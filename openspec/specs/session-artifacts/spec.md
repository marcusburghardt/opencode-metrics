## Requirements

### Requirement: Session artifacts table

The database SHALL provide a `session_artifacts` table that records
the specific PRs and issues a session interacted with.

Columns: session_id (TEXT), artifact_type (TEXT), reference (TEXT),
recorded_at (INTEGER, epoch milliseconds).
PRIMARY KEY: (session_id, artifact_type, reference).

artifact_type values: `pr-created`, `pr-reviewed`, `issue-referenced`.
reference format: `org/repo#number` (e.g., `complytime/complyctl#474`).

#### Scenario: Session creates a PR

- **GIVEN** a session runs `gh pr create` and the output contains
  `https://github.com/org/repo/pull/123`
- **WHEN** the session metrics are recorded
- **THEN** a row SHALL be inserted into session_artifacts with
  artifact_type = "pr-created", reference = "org/repo#123"

#### Scenario: Session reviews a PR

- **GIVEN** a session runs `gh pr view 10` or `gh pr diff 10`
  in a project whose remote is `github.com/org/repo`
- **WHEN** the session metrics are recorded
- **THEN** a row SHALL be inserted into session_artifacts with
  artifact_type = "pr-reviewed", reference = "org/repo#10"

#### Scenario: Session references an issue

- **GIVEN** a session runs `gh issue view 42`
  in a project whose remote is `github.com/org/repo`
- **WHEN** the session metrics are recorded
- **THEN** a row SHALL be inserted into session_artifacts with
  artifact_type = "issue-referenced", reference = "org/repo#42"

#### Scenario: gh issue list without specific number

- **GIVEN** a session runs `gh issue list` (no specific issue number)
- **WHEN** the session metrics are recorded
- **THEN** no artifact SHALL be recorded (list commands without
  explicit issue numbers are not tracked)

#### Scenario: Duplicate PR reference in same session

- **GIVEN** a session runs `gh pr view 10`, `gh pr diff 10`, and
  `gh pr checks 10` (same PR, three commands)
- **WHEN** the session metrics are recorded
- **THEN** only one row SHALL exist in session_artifacts with
  artifact_type = "pr-reviewed", reference = "org/repo#10"

### Requirement: Convenience view for session artifacts

The database SHALL provide a `v_session_artifacts` view with
recorded_at_epoch (seconds) and recorded_at_iso (RFC3339) columns,
following the same pattern as other convenience views.

#### Scenario: Grafana query uses artifact view

- **GIVEN** the v_session_artifacts view exists
- **WHEN** a consumer queries for all PR-related sessions
- **THEN** the recorded_at_iso column SHALL contain valid RFC3339
  timestamps

### Requirement: PR/issue count metrics

The metric_definitions catalog SHALL include three new metrics:
- `prs_created` (unit: count, aggregation: sum)
- `prs_reviewed` (unit: count, aggregation: sum)
- `issues_referenced` (unit: count, aggregation: sum)

These counts SHALL be recorded in the measurements table alongside
existing metrics.

#### Scenario: Cost per PR query

- **GIVEN** a session created 2 PRs and cost $5.00
- **WHEN** a consumer queries cost.value / prs_created.value
- **THEN** the result SHALL be $2.50 per PR

#### Scenario: Count equals detail invariant

- **GIVEN** a session has 3 rows in session_artifacts with
  artifact_type = "pr-reviewed"
- **THEN** the measurements row for metric_name = "prs_reviewed"
  SHALL have value = 3

### Requirement: PR/issue extraction from bash tool calls

The plugin SHALL extract PR/issue references from bash tool call
parts in the message data. The extraction SHALL parse:

- `gh pr create` commands + output URLs for created PRs
- `gh pr view/diff/checks/review <number>` for reviewed PRs
- `git fetch ... pull/<number>/head` for reviewed PRs
- `gh issue view <number>` for referenced issues
- `gh issue create` commands + output URLs for created issues
  (classified as issue-referenced since no separate issue-created
  type exists -- the artifact type tracks session interaction, not
  the specific action)
- PR URLs in command arguments or output matching
  `github.com/<org>/<repo>/pull/<number>`

#### Scenario: PR URL extracted from gh pr create output

- **GIVEN** a bash tool call runs `gh pr create ...`
- **AND** the output contains
  `https://github.com/unbound-force/unbound-force/pull/100`
- **WHEN** the extraction runs
- **THEN** a pr-created artifact SHALL be recorded with reference
  `unbound-force/unbound-force#100`

#### Scenario: PR number extracted from gh pr view command

- **GIVEN** a bash tool call runs `gh pr view 10 --json ...`
- **AND** the session's project remote is `github.com/org/repo`
- **WHEN** the extraction runs
- **THEN** a pr-reviewed artifact SHALL be recorded with reference
  `org/repo#10`

#### Scenario: PR reference without resolvable repo context

- **GIVEN** a bash tool call runs `gh pr view 10`
- **AND** the session's project remote is not a GitHub URL (or is
  absent, e.g., local-only project or deleted worktree)
- **WHEN** the extraction runs
- **THEN** the artifact SHALL be silently skipped (no row inserted)
- **AND** the prs_reviewed count SHALL NOT include this artifact

#### Scenario: Malformed PR URL in tool output

- **GIVEN** a bash tool call output contains a URL matching
  `github.com` but with a non-numeric PR identifier
  (e.g., `github.com/org/repo/pull/abc`)
- **WHEN** the extraction runs
- **THEN** the malformed URL SHALL be silently skipped

#### Scenario: gh command with explicit --repo flag

- **GIVEN** a bash tool call runs `gh pr view 10 --repo org/other`
- **WHEN** the extraction runs
- **THEN** the reference SHALL use the `--repo` value:
  `org/other#10` (overriding the session's project remote)

### Requirement: Backfill extraction

The backfill script SHALL extract PR/issue references from
historical session data using the same parsing logic as the live
plugin. The bash command structure in OpenCode's source database
(`part.data.state.input.command` and `part.data.state.output`)
SHALL be parsed identically.

#### Scenario: Historical PR data is captured

- **GIVEN** a historical session contains `gh pr create` tool calls
  with output URLs
- **WHEN** the backfill script processes the session
- **THEN** the session_artifacts table SHALL contain the extracted
  PR references
- **AND** the measurements table SHALL contain the correct
  prs_created count
