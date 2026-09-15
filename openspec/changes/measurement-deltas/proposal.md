## Why

The plugin stores one cumulative value per session per metric (PRIMARY
KEY (session_id, metric_name) with ON CONFLICT DO UPDATE). When a
session spans multiple days, the entire cumulative cost is attributed
to the day of the last recorded_at timestamp. There is no way to
compute how much cost was incurred on a specific day.

This affects 83 of 909 sessions (9.1%), but those sessions account for
$2,442 of $3,438 total cost (71%). The most impactful sessions -- long
pipelines, multi-day reviews, sustained implementation work -- are
exactly the ones whose daily attribution is wrong.

Example: a 21-day session costing $153.38 appears as a single $153.38
spike on the final day, while the preceding 20 days show nothing. The
Grafana "Daily Cost" panel is misleading for any time range that
includes multi-day sessions.

## What Changes

- Add a `measurement_deltas` table that stores incremental changes
  alongside the existing cumulative `measurements` table. Each idle
  event records the difference between the new cumulative value and
  the previously stored value.
- Add a `v_measurement_deltas` convenience view with epoch-second and
  ISO-8601 timestamp columns (matching the existing v_measurements
  pattern).
- Add a secondary index `(metric_name, recorded_at)` for efficient
  cross-session daily aggregation queries.
- Modify `writeMetrics()` to compute and store deltas before the
  existing upsert -- reading the current value, computing the
  difference, inserting the delta (if non-zero), then upserting the
  cumulative value as before.
- Update README.md with delta-based query examples.
- Produce an actionable summary of Grafana dashboard query changes
  for adoption in ansible-role-ai.

## Capabilities

### New Capabilities

- `incremental-metrics`: Per-idle-event delta tracking enabling
  accurate time-sliced cost attribution for multi-day sessions.

### Modified Capabilities

- `metrics-storage`: The schema gains a new table and view. The
  existing measurements table and v_measurements view are unchanged.
- `metrics-collection`: writeMetrics() gains delta computation logic.
  External behavior unchanged -- the function signature and cumulative
  upsert are preserved.

### Removed Capabilities

(none)

## Impact

- **Files modified**: `src/db.ts` (schema), `src/writer.ts` (delta
  logic), `src/writer.test.ts` (new tests), `src/db.test.ts` (new
  tests), `README.md` (query examples)
- **Backward compatibility**: Full. The existing measurements table,
  v_measurements view, and all existing queries continue to work.
  The delta table is additive -- consumers that don't know about it
  are unaffected.
- **Dependencies**: None new.
- **Breaking changes**: None.
- **Storage**: ~36 MB/year at current usage (11.5 sessions/day,
  ~5 idle events/session, ~5 changed metrics/event). Negligible
  for local SQLite.
- **Performance**: +2-3ms per idle event (12 SELECT + up to 12
  INSERT for deltas). Dwarfed by SDK query time (~50-200ms).

## Constitution Alignment

Assessed against the Unbound Force org constitution.

### I. Autonomous Collaboration

**Assessment**: PASS

The delta table is a self-describing artifact: any consumer can query
`measurement_deltas` or `v_measurement_deltas` to get incremental
values with full provenance (session_id, metric_name, recorded_at).
No coordination with the producing plugin is needed. The existing
`metric_definitions` catalog describes what each metric_name means,
including the `aggregation: "sum"` hint that tells consumers which
metrics can be meaningfully summed as deltas.

### II. Composability First

**Assessment**: PASS

The delta table is additive -- the plugin continues to deliver its core
value (cumulative metrics) without the delta table being consumed.
Grafana dashboards can use `v_measurements` (cumulative) or
`v_measurement_deltas` (incremental) independently. The backfill script
(`scripts/backfill.ts`) works transparently: it calls `writeMetrics()`
which now also produces delta rows. No consumer is forced to adopt
deltas.

### III. Observable Quality

**Assessment**: PASS

The delta values are machine-parseable via the `v_measurement_deltas`
SQL view (ISO-8601 timestamps, numeric deltas). The view follows the
established pattern (v_sessions, v_measurements) for timestamp
conversion. Quality is verifiable: SUM(delta) for a session must equal
the cumulative value in measurements -- this invariant is testable and
tested.

### IV. Testability

**Assessment**: PASS

The delta computation is a pure arithmetic operation
(new_value - previous_value) with well-defined edge cases: first event
(previous = 0), unchanged value (delta = 0, skipped), negative delta
(allowed for code impact metrics). All paths are testable in isolation
using in-memory SQLite databases. Coverage strategy is defined in the
design document.
