## 1. Schema Changes

- [ ] 1.1 Add session_artifacts table to createSchema() in src/db.ts:
  CREATE TABLE IF NOT EXISTS session_artifacts (
    session_id TEXT, artifact_type TEXT, reference TEXT,
    recorded_at INTEGER,
    PRIMARY KEY (session_id, artifact_type, reference)
  )
- [ ] 1.2 Add secondary index for cross-session artifact queries:
  CREATE INDEX IF NOT EXISTS idx_artifacts_reference
    ON session_artifacts (reference, artifact_type)
- [ ] 1.3 Add v_session_artifacts view with recorded_at_epoch and
  recorded_at_iso columns following the existing view pattern
- [ ] 1.4 Add 3 new metric definitions to ensureMetricDefinitions():
  prs_created (count, "PRs created in the session", sum),
  prs_reviewed (count, "PRs reviewed in the session", sum),
  issues_referenced (count, "Issues referenced in the session", sum)

## 2. Extraction Logic

- [ ] 2.1 Create src/artifacts.ts module with extraction functions:
  (a) extractPRsCreated(bashParts): parse gh pr create commands and
  extract PR URLs from tool output
  (github.com/org/repo/pull/number -> org/repo#number),
  (b) extractPRsReviewed(bashParts, repoContext): parse
  gh pr view/diff/checks/review commands, extract PR numbers,
  combine with repo context to form org/repo#number,
  (c) extractIssuesReferenced(bashParts, repoContext): parse
  gh issue view/list/create commands, extract issue numbers,
  (d) extractRepoContext(projectWorktree): derive org/repo from
  git remote URL in the project worktree path

## 3. Writer Changes

- [ ] 3.1 Add upsertArtifacts() function to src/writer.ts:
  INSERT OR IGNORE INTO session_artifacts for each extracted
  artifact. OR IGNORE handles the PK deduplication (same PR
  referenced multiple times in a session).

## 4. Live Plugin Integration

- [ ] 4.1 Extend extractSessionData() in src/extractor.ts (or
  src/index.ts) to call the extraction functions from
  src/artifacts.ts, passing bash tool call parts and project context.
  Add prs_created, prs_reviewed, issues_referenced counts to the
  metrics array. Call upsertArtifacts() with the extracted references.

## 5. Backfill Integration

- [ ] 5.1 Extend the backfill loop in scripts/backfill.ts to:
  (a) Extract PR/issue data from source part table using the same
  parsing functions,
  (b) Derive repo context from the project worktree path,
  (c) Call upsertArtifacts() with extracted references,
  (d) Add prs_created, prs_reviewed, issues_referenced counts to
  the metrics array passed to writeMetrics()

## 6. Schema Tests

- [ ] 6.1 Add tests to src/db.test.ts:
  (a) session_artifacts table exists with correct columns,
  (b) idx_artifacts_reference index exists,
  (c) v_session_artifacts view exists with correct timestamp columns,
  (d) 3 new metric definitions exist in metric_definitions table

## 7. Extraction Tests

- [ ] 7.1 Create src/artifacts.test.ts with tests:
  (a) extractPRsCreated: gh pr create output with URL -> pr-created,
  (b) extractPRsCreated: gh pr create without URL -> no artifact,
  (c) extractPRsReviewed: gh pr view 10 + repo context -> pr-reviewed
  with org/repo#10,
  (d) extractPRsReviewed: gh pr diff 10 -> same reference as view,
  (e) extractPRsReviewed: git fetch pull/14/head -> pr-reviewed,
  (f) extractIssuesReferenced: gh issue view 42 -> issue-referenced,
  (g) extractIssuesReferenced: gh issue list (no specific number) ->
  no artifact,
  (h) extractRepoContext: git remote URL parsing
  (https://github.com/org/repo.git -> org/repo),
  (i) Deduplication: same PR via view + diff + checks -> one artifact,
  (j) Multiple PRs in one session -> multiple artifacts,
  (k) Count equals detail invariant: prs_created count matches
  pr-created artifact row count

## 8. Update Documentation

- [ ] 8.1 Add a "PR and Issue Analytics" subsection to the Example
  queries section in README.md with queries covering:
  (a) Cost per PR created (total and average),
  (b) Total cost to deliver a specific PR (cross-session aggregation
  by reference),
  (c) Most expensive PRs across all sessions,
  (d) Sessions that touched a specific PR,
  (e) PR activity over time (PRs created per week),
  (f) Cost per PR trend over time (weekly),
  (g) PR activity by classification (which workflows produce PRs),
  (h) PRs per session (batching efficiency),
  (i) Sessions with zero PRs/issues (non-deliverable spend),
  (j) Cost per PR by project (repository-level ROI)
- [ ] 8.2 Add metric reference entries for the 3 new metrics in the
  metric reference table in README.md
- [ ] 8.3 Add an "Insights" section to README.md documenting what
  analytics become possible with PR/issue tracking:
  (a) Cost-per-deliverable: cost per PR created, cost per review,
  cost per PR by project and by model,
  (b) Value density: PRs per session, non-deliverable spend ratio,
  highest-value sessions,
  (c) PR lifecycle: total cost to deliver a specific PR across all
  sessions, review rounds per PR, self-review detection,
  (d) Cross-metric correlations: review quality indicators
  (PRs reviewed x tokens_output = feedback volume), creation
  efficiency (PRs created x files_changed = PR size vs cost),
  project-level ROI (cost by project x PRs by project),
  (e) Trend analysis: PRs created per week, cost per PR over time,
  review rounds declining, workflow evolution (PR creation by
  classification), issue-to-PR ratio

## 9. Verification

- [ ] 9.1 Run make test — all existing + new tests pass
- [ ] 9.2 Run make lint — no lint issues
- [ ] 9.3 Run make build — plugin builds cleanly
- [ ] 9.4 Run make backfill — verify artifact rows created for
  historical sessions with PR/issue activity
- [ ] 9.5 Verify with sqlite3:
  SELECT artifact_type, COUNT(*) FROM session_artifacts GROUP BY 1;
  Expected: pr-created ~105, pr-reviewed ~127, issue-referenced ~82
