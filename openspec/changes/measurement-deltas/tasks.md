<!--
  All tasks are sequential — the schema, writer, and tests
  build on each other. No [P] markers.
-->

## 1. Schema Changes

- [x] 1.1 Add measurement_deltas table to createSchema() in src/db.ts:
  CREATE TABLE IF NOT EXISTS measurement_deltas (
    session_id TEXT, metric_name TEXT, delta REAL,
    recorded_at INTEGER,
    PRIMARY KEY (session_id, metric_name, recorded_at)
  )
- [x] 1.2 Add secondary index to createSchema() in src/db.ts:
  CREATE INDEX IF NOT EXISTS idx_deltas_metric_time
    ON measurement_deltas (metric_name, recorded_at)
- [x] 1.3 Add v_measurement_deltas view to createSchema() in src/db.ts
  following the same pattern as v_measurements: expose
  recorded_at_epoch (seconds) and recorded_at_iso (RFC3339)

## 2. Writer Changes

- [x] 2.1 Modify writeMetrics() in src/writer.ts to compute and store
  deltas before the existing upsert. For each metric: (a) SELECT
  current value from measurements, (b) compute delta =
  new_value - previous_value, (c) INSERT OR IGNORE delta into
  measurement_deltas if delta != 0 (OR IGNORE handles the
  near-impossible case of a PK collision on sub-millisecond idle
  events, preventing the delta path from breaking the primary
  cumulative upsert), (d) UPSERT into measurements as before.
  Use prepared statements for all three operations.

## 3. Schema Tests

- [x] 3.1 Add tests to src/db.test.ts verifying:
  (a) measurement_deltas table exists after initDatabase() with
  correct columns: session_id (TEXT), metric_name (TEXT), delta
  (REAL), recorded_at (INTEGER), PRIMARY KEY (session_id,
  metric_name, recorded_at) — verify via PRAGMA table_info(),
  (b) idx_deltas_metric_time index exists,
  (c) v_measurement_deltas view exists,
  (d) v_measurement_deltas returns correct epoch and ISO columns
  for a known timestamp

## 4. Writer Tests

- [x] 4.1 Add tests to src/writer.test.ts verifying:
  (a) First write creates a delta row equal to the full value,
  (b) Second write creates a delta row with the difference,
  (c) Write with unchanged value creates no delta row (zero skipped),
  (d) SUM(delta) equals the final cumulative value after multiple
  updates (invariant test),
  (e) Negative delta is recorded correctly (value decreases),
  (f) Multiple metrics in a single writeMetrics() call each get
  their own delta rows,
  (g) Delta rows are rolled back when the enclosing transaction
  fails — no orphaned delta rows remain after a writeSessionData()
  failure,
  (h) After 5 cumulative writes (0.10, 0.30, 0.30, 0.75, 1.00):
  verify individual deltas are (0.10, 0.20, skipped, 0.45, 0.25),
  SUM(delta) equals 1.00, and measurements.value equals 1.00 —
  use toBeCloseTo() for float comparisons

## 5. Update Documentation

- [x] 5.1 Add delta-based query examples to the "Example queries"
  section in README.md:
  (a) "Cost incurred today" using v_measurement_deltas,
  (b) "Daily cost breakdown for a session" using v_measurement_deltas,
  (c) "Daily cost trend (accurate)" using v_measurement_deltas,
  (d) Note explaining when to use v_measurements (cumulative totals)
  vs v_measurement_deltas (time-sliced aggregation)
- [x] 5.2 Create GRAFANA_MIGRATION.md documenting which dashboard panels
  should switch from v_measurements to v_measurement_deltas queries,
  with exact replacement queries for ansible-role-ai adoption. This
  is a one-time migration guide, not permanent README content.
- [x] 5.3 Add a note to the README delta query examples clarifying
  that SUM(delta) is only meaningful for metrics with
  aggregation = 'sum' in metric_definitions (cost, tokens, counts).
  Non-summable metrics (cache_hit_ratio with aggregation = 'avg')
  have mechanically correct deltas but SUM(delta) produces
  analytically meaningless results for ratios.

## 6. Verification

- [x] 6.1 Run make test — all existing + new tests pass
- [x] 6.2 Run make lint — no lint issues
- [x] 6.3 Run make build — verify the plugin builds cleanly
- [x] 6.4 Run make backfill — verify backfill produces delta rows
  (one per session per metric, delta = cumulative value)
- [x] 6.5 Verify with sqlite3: SELECT COUNT(*) FROM measurement_deltas
  should equal sessions x metrics_with_nonzero_values

<!-- spec-review: passed -->
<!-- code-review: passed -->
