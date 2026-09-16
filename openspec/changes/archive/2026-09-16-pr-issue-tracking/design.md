## Context

OpenCode sessions interact with GitHub PRs and issues through bash
tool calls: `gh pr create`, `gh pr view`, `gh pr diff`, `gh pr checks`,
`gh issue list`, `gh issue view`, etc. The tool call data is available
in the `part` table of OpenCode's internal database as JSON with the
structure `{ type: "tool", tool: "bash", state: { input: { command },
output } }`.

The live plugin already iterates message parts for classification
signals (first user message, bash commands for pr-review/pr-creation
classification). Extending this to count and extract PR/issue
references is a natural addition to the existing extraction path.

## Goals / Non-Goals

### Goals

- Count PRs created, PRs reviewed, and issues referenced per session
- Store specific PR/issue references for drill-down analysis
- Enable "cost per PR" and "value per session" queries in Grafana
- Extract data from both live sessions and historical backfill
- Normalize PR references as `org/repo#number` for cross-session joins

### Non-Goals

- Tracking PR status (merged, closed, open) — would require GitHub
  API calls, adding a network dependency
- Tracking commits or branches — too granular, less actionable
- Real-time PR monitoring — this is post-hoc analytics
- Extracting issue content or PR diff content — only references

## Decisions

### Decision 1: Extraction from bash tool call parts

**Choice**: Parse `gh pr` and `gh issue` commands from bash tool call
parts (`part.data.state.input.command`) and extract PR URLs from tool
call outputs (`part.data.state.output`).

**Rationale**: The data is already there — the classification engine
already extracts bash commands for pr-review/pr-creation detection.
The same parts contain PR numbers, repo references, and output URLs.
No new data sources or API calls needed.

### Decision 2: Reference normalization as org/repo#number

**Choice**: Normalize all PR/issue references to the format
`org/repo#number` (e.g., `complytime/complyctl#474`). Extract from:
- `gh pr view 10` → use current repo context (from project table)
- `gh pr create` output containing `github.com/org/repo/pull/123`
- `git fetch upstream pull/14/head` → extract PR number

**Rationale**: A normalized reference format enables cross-session
aggregation: "show me all sessions that touched PR #474" across
different OpenCode sessions. The `org/repo` prefix distinguishes
PRs across repositories.

### Decision 3: Artifact types as an enum-like TEXT column

**Choice**: Store artifact_type as TEXT with values: `pr-created`,
`pr-reviewed`, `issue-referenced`. No formal enum constraint.

**Rationale**: SQLite has no native ENUM type. TEXT with documented
values is the established pattern in this schema (metric_name in
measurements uses the same approach). New artifact types can be
added without schema changes.

### Decision 4: Count metrics as additional measurement rows

**Choice**: Add `prs_created`, `prs_reviewed`, `issues_referenced`
to the metric_definitions catalog with `aggregation: "sum"` and
`unit: "count"`. Store counts in the measurements table alongside
the existing 12 metrics.

**Rationale**: Fits the existing dimensional model — no new tables
or joins needed for aggregate queries. "Cost per PR" is simply
`cost.value / prs_created.value` using the existing measurement
join pattern.

### Decision 5: Duplicate detection via PRIMARY KEY

**Choice**: `PRIMARY KEY (session_id, artifact_type, reference)` on
session_artifacts. Same PR referenced multiple times in a session
(e.g., `gh pr view 10` + `gh pr diff 10` + `gh pr checks 10`)
produces one row, not three.

**Rationale**: The artifact table tracks which PRs/issues a session
interacted with, not how many times each command was run. De-duplication
at the schema level prevents inflated counts.

### Decision 6: Backfill extraction from historical data

**Choice**: The backfill script extracts PR/issue data from
OpenCode's `part` table using the same parsing logic as the live
plugin. The bash command structure in the source DB
(`part.data.state.input.command`) matches the live plugin's
extraction format.

**Rationale**: Consistent extraction logic between live and backfill
ensures the same references are captured regardless of data source.
Historical data has rich PR activity (105 sessions created PRs,
127 reviewed PRs).

### Decision 7: extractRepoContext contract boundary

**Choice**: Split repo context resolution into two functions:
1. `parseRepoFromRemoteUrl(url: string): string | null` — pure URL
   parser that extracts `org/repo` from a GitHub remote URL. Handles
   `https://github.com/org/repo.git`, `git@github.com:org/repo.git`,
   and similar formats. Returns null for non-GitHub URLs.
2. `resolveRepoContext(worktree: string): string | null` — filesystem
   operation that reads the git remote from a worktree path, then
   delegates to the pure parser. Used in integration layer only.

**Rationale**: Constitution Principle IV (Testability) requires
isolation. The pure parser is fully unit-testable with string
fixtures. The filesystem resolver is tested implicitly via backfill
verification (tasks 9.4-9.5). This separation ensures the core
parsing logic has no external dependencies.

### Decision 8: Coverage strategy

Tests are classified as:
- **Unit tests**: PR/issue extraction from bash command strings, URL
  parsing, reference normalization, count computation
- **Integration tests**: End-to-end flow from mock parts to
  session_artifacts rows + measurement counts
- **Schema tests**: Table and view existence, column contract

All subject to the project-wide 80% line coverage target.

## Risks / Trade-offs

- **Extraction accuracy**: The parsing depends on `gh` CLI command
  format. If a user interacts with PRs through a different tool
  (e.g., `hub`, direct API calls, or a web browser), those
  interactions won't be captured. This is acceptable — the plugin
  captures what's observable through OpenCode's tool calls.
- **PR number ambiguity**: `gh pr view 10` without a repo context
  refers to PR #10 in the current project. The backfill can resolve
  this from the session's project_id → project worktree → git remote.
  The live plugin has project context from `client.project.current()`.
- **Storage**: One row per PR/issue per session. At ~3 PR interactions
  per day, ~1K rows/year. Negligible.
