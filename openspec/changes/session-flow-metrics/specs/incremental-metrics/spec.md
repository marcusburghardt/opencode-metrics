## MODIFIED Requirements

### Requirement: Incremental delta tracking for all metrics

The plugin SHALL record the incremental change (delta) for each metric
on every idle event, storing it in a `measurement_deltas` table
alongside the existing cumulative `measurements` table. This SHALL apply
to the flow metrics as well: `permission_prompts`,
`permission_wait_seconds`, `turns_total`, `context_tokens_max`,
`context_tokens_final`, `generation_seconds`, `post_generation_seconds`,
`compactions`, and `child_sessions`.

Previously: the requirement covered every recorded metric but did not name
the flow metrics, which are introduced by the `session-flow-metrics` change.

#### Scenario: First idle event for a new session

- **GIVEN** no measurements exist for session "s1"
- **WHEN** the plugin records cost = 0.50 on an idle event
- **THEN** a row SHALL be inserted into measurement_deltas with
  session_id = "s1", metric_name = "cost", delta = 0.50
- **AND** a row SHALL be upserted into measurements with value = 0.50

#### Scenario: Subsequent idle event with increased cost

- **GIVEN** measurements contains cost = 0.50 for session "s1"
- **WHEN** the plugin records cost = 1.20 on the next idle event
- **THEN** a row SHALL be inserted into measurement_deltas with
  delta = 0.70 (1.20 - 0.50)
- **AND** the measurements row SHALL be updated to value = 1.20

#### Scenario: Idle event with no change in value

- **GIVEN** measurements contains cost = 1.20 for session "s1"
- **WHEN** the plugin records cost = 1.20 on another idle event
- **THEN** no row SHALL be inserted into measurement_deltas
  (delta = 0 is skipped)
- **AND** the measurements row SHALL remain at value = 1.20

#### Scenario: Negative delta for code impact metrics

- **GIVEN** measurements contains files_changed = 5 for session "s1"
- **WHEN** the plugin records files_changed = 3 (file reverted)
- **THEN** a row SHALL be inserted into measurement_deltas with
  delta = -2
- **AND** the measurements row SHALL be updated to value = 3

#### Scenario: Flow metric delta

- **GIVEN** measurements contains permission_prompts = 1 for session "s1"
- **WHEN** a later capture records permission_prompts = 3
- **THEN** a row SHALL be inserted into measurement_deltas with
  metric_name = "permission_prompts" and delta = 2
- **AND** the measurements row SHALL be updated to value = 3

#### Scenario: Flow metric decreases after a context reset

- **GIVEN** measurements contains context_tokens_final = 400000
- **WHEN** a compaction is followed by a capture with
  context_tokens_final = 25000
- **THEN** a row SHALL be inserted into measurement_deltas with
  delta = -375000
- **AND** the measurements row SHALL be updated to value = 25000
