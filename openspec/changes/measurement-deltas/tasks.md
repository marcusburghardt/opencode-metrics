<!--
  All tasks are sequential — the schema, writer, and tests
  build on each other. No [P] markers.
-->

## 1. Schema Changes

- [ ] 1.1 Add measurement_deltas table to createSchema() in src/db.ts:
  CREATE TABLE IF NOT EXISTS measurement_deltas (
    session_id TEXT, metric_name TEXT, delta REAL,
    recorded_at INTEGER,
    PRIMARY KEY (session_id, metric_name, recorded_at)
  )
- [ ] 1.2 Add secondary index to createSchema() in src/db.ts:
  CREATE INDEX IF NOT EXISTS idx_deltas_metric_time
    ON measurement_deltas (metric_name, recorded_at)
- [ ] 1.3 Add v_measurement_deltas view to createSchema() in src/db.ts
  following the same pattern as v_measurements: expose
  recorded_at_epoch (seconds) and recorded_at_iso (RFC3339)

## 2. Writer Changes

- [ ] 2.1 Modify writeMetrics() in src/writer.ts to compute and store
  deltas before the existing upsert. For each metric: (a) SELECT
  current value from measurements, (b) compute delta =
  new_value - previous_value, (c) INSERT delta into
  measurement_deltas if delta != 0, (d) UPSERT into measurements
  as before. Use prepared statements for all three operations.

## 3. Schema Tests

- [ ] 3.1 Add tests to src/db.test.ts verifying:
  (a) measurement_deltas table exists after initDatabase(),
  (b) idx_deltas_metric_time index exists,
  (c) v_measurement_deltas view exists,
  (d) v_measurement_deltas returns correct epoch and ISO columns
  for a known timestamp

## 4. Writer Tests

- [ ] 4.1 Add tests to src/writer.test.ts verifying:
  (a) First write creates a delta row equal to the full value,
  (b) Second write creates a delta row with the difference,
  (c) Write with unchanged value creates no delta row (zero skipped),
  (d) SUM(delta) equals the final cumulative value after multiple
  updates (invariant test),
  (e) Negative delta is recorded correctly (value decreases),
  (f) Multiple metrics in a single writeMetrics() call each get
  their own delta rows

## 5. Update Documentation

- [ ] 5.1 Add delta-based query examples to the "Example queries"
  section in README.md:
  (a) "Cost incurred today" using v_measurement_deltas,
  (b) "Daily cost breakdown for a session" using v_measurement_deltas,
  (c) "Daily cost trend (accurate)" using v_measurement_deltas,
  (d) Note explaining when to use v_measurements (cumulative totals)
  vs v_measurement_deltas (time-sliced aggregation)
- [ ] 5.2 Add a "Grafana Dashboard Updates" section to README.md (or
  a separate GRAFANA_MIGRATION.md) documenting which dashboard panels
  should switch from v_measurements to v_measurement_deltas queries,
  with exact replacement queries for ansible-role-ai adoption

## 6. Verification

- [ ] 6.1 Run make test — all existing + new tests pass
- [ ] 6.2 Run make lint — no lint issues
- [ ] 6.3 Run make build — verify the plugin builds cleanly
- [ ] 6.4 Run make backfill — verify backfill produces delta rows
  (one per session per metric, delta = cumulative value)
- [ ] 6.5 Verify with sqlite3: SELECT COUNT(*) FROM measurement_deltas
  should equal sessions x metrics_with_nonzero_values
