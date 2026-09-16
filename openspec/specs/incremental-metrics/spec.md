## Requirements

### Requirement: Incremental delta tracking for all metrics

The plugin SHALL record the incremental change (delta) for each metric
on every idle event, storing it in a `measurement_deltas` table
alongside the existing cumulative `measurements` table.

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

### Requirement: Delta table schema

The `measurement_deltas` table SHALL have columns: session_id (TEXT),
metric_name (TEXT), delta (REAL), recorded_at (INTEGER, epoch
milliseconds). The primary key SHALL be
(session_id, metric_name, recorded_at).

#### Scenario: Multiple deltas for the same session and metric

- **GIVEN** session "s1" has had 3 idle events with cost changes
- **WHEN** a consumer queries measurement_deltas for session "s1"
  and metric_name = "cost"
- **THEN** 3 rows SHALL be returned, each with its own recorded_at
  and delta value
- **AND** SUM(delta) SHALL equal the current value in the
  measurements table

### Requirement: Delta sum equals cumulative value invariant

For any session and metric, the sum of all deltas in
measurement_deltas SHALL equal the current cumulative value in the
measurements table. This invariant MUST be verified by automated tests.

#### Scenario: Invariant holds after multiple updates

- **GIVEN** session "s1" has received 5 idle events with cost values
  0.10, 0.30, 0.30, 0.75, 1.00
- **WHEN** a consumer queries both tables
- **THEN** measurements.value SHALL be 1.00
- **AND** SUM(measurement_deltas.delta) SHALL be 1.00
- **AND** the individual deltas SHALL be 0.10, 0.20, 0.00 (skipped),
  0.45, 0.25

### Requirement: Secondary index for cross-session aggregation

The measurement_deltas table SHALL have a secondary index on
(metric_name, recorded_at) to support efficient Grafana queries that
filter by metric name and aggregate across time ranges.

#### Scenario: Daily cost query uses index

- **GIVEN** the measurement_deltas table contains 100,000+ rows
- **WHEN** a consumer queries
  `SELECT SUM(delta) FROM measurement_deltas
   WHERE metric_name = 'cost' AND recorded_at/1000 >= ?`
- **THEN** the query SHALL use the idx_deltas_metric_time index
  rather than performing a full table scan

### Requirement: Convenience view with timestamp conversion

The database SHALL provide a `v_measurement_deltas` view that exposes
`recorded_at_epoch` (epoch seconds) and `recorded_at_iso` (RFC3339
string), following the same pattern as `v_measurements`.

#### Scenario: Grafana query uses ISO timestamps

- **GIVEN** the v_measurement_deltas view exists
- **WHEN** a Grafana panel queries
  `SELECT recorded_at_iso AS time, SUM(delta) AS cost
   FROM v_measurement_deltas WHERE metric_name = 'cost'
   GROUP BY date(recorded_at_epoch, 'unixepoch')`
- **THEN** the time column SHALL contain valid RFC3339 timestamps
  parseable by the frser-sqlite-datasource plugin
