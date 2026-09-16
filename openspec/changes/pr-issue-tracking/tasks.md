<!-- All tasks are sequential — extraction depends on PartInfo
     extension, writer depends on extraction types, integration
     wires both, tests validate the full chain. No [P] markers. -->

## 1. Schema Changes

- [x] 1.1 Add session_artifacts table to createSchema() in src/db.ts:
  CREATE TABLE IF NOT EXISTS session_artifacts (
    session_id TEXT, artifact_type TEXT, reference TEXT,
    recorded_at INTEGER,
    PRIMARY KEY (session_id, artifact_type, reference)
  )
- [x] 1.2 Add secondary index for cross-session artifact queries:
  CREATE INDEX IF NOT EXISTS idx_artifacts_reference
    ON session_artifacts (reference, artifact_type)
- [x] 1.3 Add v_session_artifacts view with recorded_at_epoch and
  recorded_at_iso columns following the existing view pattern
- [x] 1.4 Add 3 new metric definitions to ensureMetricDefinitions():
  prs_created (count, "PRs created in the session", sum),
  prs_reviewed (count, "PRs reviewed in the session", sum),
  issues_referenced (count, "Issues referenced in the session", sum)
- [x] 1.5 Bump SCHEMA_VERSION from 1 to 2 in src/db.ts to reflect
  the session_artifacts table addition. The migration path from v1→v2
  is handled by CREATE TABLE/INDEX/VIEW IF NOT EXISTS (idempotent).
  Update initDatabase() to set PRAGMA user_version = SCHEMA_VERSION
  when currentVersion < SCHEMA_VERSION (not only when currentVersion
  === 0), so existing v1 databases reflect the actual schema state.

## 2. Data Model Extension + Extraction Logic

- [x] 2.1 Extend PartInfo interface in src/extractor.ts with an
  `output?: string` field. Update the SDK adapter in src/index.ts
  to map `p.state.output` into the new field for tool-type parts.
  Define a BashToolCall type (e.g., { command: string; output?: string })
  that extraction functions accept, bridging both live and backfill paths.
- [x] 2.2 Create src/artifacts.ts module with extraction functions:
  (a) extractPRsCreated(parts: BashToolCall[]): parse gh pr create
  commands and extract PR URLs from tool output
  (github.com/org/repo/pull/number -> org/repo#number),
  (b) extractPRsReviewed(parts: BashToolCall[], repoContext): parse
  gh pr view/diff/checks/review commands, extract PR numbers,
  combine with repo context to form org/repo#number. Honor --repo
  flag if present (overrides session repo context),
  (c) extractIssuesReferenced(parts: BashToolCall[], repoContext):
  parse gh issue view <number> commands, extract issue numbers.
  gh issue list without a specific number produces no artifact.
  gh issue create output URLs are classified as issue-referenced,
  (d) parseRepoFromRemoteUrl(url: string): pure URL parser that
  extracts org/repo from GitHub remote URLs (https and ssh formats).
  Returns null for non-GitHub URLs,
  (e) resolveRepoContext(worktree: string): filesystem operation
  that reads git remote from worktree path, delegates to
  parseRepoFromRemoteUrl. Returns null if worktree is inaccessible
  or remote is not GitHub (artifact silently skipped)

## 3. Writer Changes

- [x] 3.1 Add upsertArtifacts() function to src/writer.ts:
  INSERT OR IGNORE INTO session_artifacts for each extracted
  artifact. OR IGNORE handles the PK deduplication (same PR
  referenced multiple times in a session).

## 4. Live Plugin Integration

- [x] 4.1 Extend extractSessionData() in src/extractor.ts to call
  the extraction functions from src/artifacts.ts, passing
  BashToolCall parts (with output field) and project repo context.
  Return extracted artifact references as part of ExtractedData
  (add an artifacts field). Add prs_created, prs_reviewed,
  issues_referenced counts to the metrics array. This is pure
  extraction — no database writes.
- [x] 4.2 Extend writeSessionData() in src/writer.ts (or
  handleSessionIdle() in src/index.ts) to call upsertArtifacts()
  with the extracted artifacts from ExtractedData. This maintains
  the project's clean extraction→write separation: all database
  writes happen in the write layer, not in extraction.

## 5. Backfill Integration

- [x] 5.1 Extend the backfill loop in scripts/backfill.ts to:
  (a) Extract PR/issue data from source part table using the same
  parsing functions,
  (b) Derive repo context from the project worktree path,
  (c) Call upsertArtifacts() with extracted references,
  (d) Add prs_created, prs_reviewed, issues_referenced counts to
  the metrics array passed to writeMetrics()

## 6. Schema Tests

- [x] 6.1 Add tests to src/db.test.ts:
  (a) session_artifacts table exists with correct columns,
  (b) idx_artifacts_reference index exists,
  (c) v_session_artifacts view exists with correct timestamp columns,
  (d) 3 new metric definitions exist in metric_definitions table,
  (e) SCHEMA_VERSION is 2
- [x] 6.2 Add writer tests to src/db.test.ts (or src/writer.test.ts):
  (a) upsertArtifacts() inserts artifact rows with correct columns,
  (b) upsertArtifacts() with duplicate PK produces one row (OR IGNORE),
  (c) upsertArtifacts() with multiple artifacts in a single call,
  (d) upsertArtifacts() participates in writeSessionData transaction
  (rollback on failure removes artifact rows)

## 7. Extraction Tests

- [x] 7.1 Create src/artifacts.test.ts with tests:
  (a) extractPRsCreated: gh pr create output with URL -> pr-created,
  (b) extractPRsCreated: gh pr create without URL -> no artifact,
  (c) extractPRsReviewed: gh pr view 10 + repo context -> pr-reviewed
  with org/repo#10,
  (d) extractPRsReviewed: gh pr diff 10 -> same reference as view,
  (e) extractPRsReviewed: git fetch pull/14/head -> pr-reviewed,
  (f) extractPRsReviewed: gh pr view 10 --repo org/other -> uses
  --repo value, reference = org/other#10,
  (g) extractIssuesReferenced: gh issue view 42 -> issue-referenced,
  (h) extractIssuesReferenced: gh issue list (no specific number) ->
  no artifact,
  (i) parseRepoFromRemoteUrl: https://github.com/org/repo.git ->
  org/repo,
  (j) parseRepoFromRemoteUrl: git@github.com:org/repo.git -> org/repo,
  (k) parseRepoFromRemoteUrl: non-GitHub URL -> null,
  (l) extractPRsCreated: malformed PR URL (non-numeric) -> skipped,
  (m) extraction with missing repo context -> artifact silently skipped,
  (n) Deduplication: same PR via view + diff + checks -> one artifact,
  (o) Multiple PRs in one session -> multiple artifacts,
  (p) Partial extraction failure: 3 commands, 1 malformed -> 2
  artifacts extracted (best-effort per command),
  (q) Count equals detail invariant: prs_created count matches
  pr-created artifact row count,
  (r) extractIssuesReferenced: gh issue create output with URL
  (github.com/org/repo/issues/42) -> issue-referenced with
  org/repo#42
- [x] 7.2 Add integration test to src/artifacts.test.ts:
  Mock bash parts with 3 PRs reviewed -> extract -> write to temp DB
  -> verify session_artifacts has 3 rows with artifact_type="pr-reviewed"
  -> verify measurements has metric_name="prs_reviewed" with value=3
  (end-to-end count-equals-detail invariant across extraction + write)

## 8. Update Documentation

- [x] 8.1 Add a "PR and Issue Analytics" subsection to the Example
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
- [x] 8.2 Add metric reference entries for the 3 new metrics in the
  metric reference table in README.md
- [x] 8.4 Update stale README sections to reflect the new schema:
  (a) "What gets imported" section: 12 → 15 metrics, add 3 new
  metrics to the bullet list, mention artifact extraction,
  (b) "Metric Reference" header: "All 12 metrics" → "All 15 metrics",
  (c) "Verifying the installation" expected .tables output: add
  session_artifacts,
  (d) View listing: add v_session_artifacts with its columns,
  (e) Grafana schema overview diagram: add session_artifacts table
  and its relationship to sessions,
  (f) "Verifying the backfill" section: add artifact verification
  query (SELECT artifact_type, COUNT(*) FROM session_artifacts
  GROUP BY 1),
  (g) Table of Contents: add entries for new subsections
  (PR and Issue Analytics, Insights),
  (h) Add note: "Existing users should re-run make backfill after
  upgrading to populate artifact data for historical sessions.
  The backfill is idempotent and safe to re-run.",
  (i) "Diagnostic commands" section: update "Check schema version"
  expected output from 1 to 2
- [x] 8.5 Add an "Insights" section to README.md documenting what
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

- [x] 9.1 Run make test — all existing + new tests pass
- [x] 9.2 Run make lint — no lint issues
- [x] 9.3 Run make build — plugin builds cleanly
- [x] 9.4 Run make backfill — verify artifact rows created for
  historical sessions with PR/issue activity
- [x] 9.5 Verify with sqlite3:
  SELECT artifact_type, COUNT(*) FROM session_artifacts GROUP BY 1;
  Expected: pr-created ~105, pr-reviewed ~127, issue-referenced ~82

<!-- spec-review: passed -->
<!-- code-review: passed -->
