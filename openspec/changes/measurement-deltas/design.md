## Context

The plugin's `writeMetrics()` function UPSERTs cumulative metric values
into the `measurements` table on every session idle event. The PRIMARY
KEY `(session_id, metric_name)` means only the latest cumulative value
is retained. For sessions spanning multiple days, all cost is attributed
to the day of the final update.

OpenCode's SDK provides cumulative totals per session (cost, tokens,
diff stats). The SDK does not provide per-event deltas. The delta must
be computed at write time by comparing the new cumulative value against
the previously stored value.

## Goals / Non-Goals

### Goals

- Enable accurate time-sliced aggregation (daily, weekly, hourly) for
  all 12 metrics, especially cost
- Preserve the existing cumulative storage model unchanged
- Keep the delta computation transparent to callers of writeMetrics()
- Support efficient Grafana queries for daily aggregation across all
  sessions
- Produce an actionable summary of dashboard query changes for
  ansible-role-ai

### Non-Goals

- Schema migration paths for existing databases (private repo, single
  user -- additive schema via CREATE IF NOT EXISTS is sufficient)
- Bumping PRAGMA user_version (defer until public release)
- Retention or archival policies for delta rows (defer to a future
  change when growth warrants it, estimated Year 2-3)
- Modifying the backfill script (it calls writeMetrics() which will
  transparently produce delta rows)

## Decisions

### Decision 1: Additive table alongside measurements

**Choice**: Add `measurement_deltas` as a new table. Do not modify the
`measurements` table or its primary key.

**Rationale**: The existing cumulative model is correct for total-cost
queries ("how much did this session cost overall?"). The delta model
is correct for time-sliced queries ("how much cost was incurred today?").
Both are needed. Replacing the cumulative table would break all existing
queries and views.

### Decision 2: Delta computed in writeMetrics()

**Choice**: Read the current value from `measurements`, compute the
difference, and insert into `measurement_deltas` -- all within the
same function call and transaction scope.

**Rationale**: Keeps the delta logic co-located with the write path.
Callers (the plugin event handler, the backfill script) don't need to
change. The computation is a single SELECT + arithmetic + INSERT per
metric, adding ~2-3ms per idle event.

### Decision 3: Skip zero deltas

**Choice**: Only insert a delta row when the computed delta is non-zero.

**Rationale**: Idle events often fire without changing metric values
(e.g., user switches tabs and back). Recording zero deltas adds noise
and inflates storage without providing analytical value. The SUM(delta)
aggregation is unaffected by omitted zeros.

### Decision 4: Primary key includes recorded_at

**Choice**: `PRIMARY KEY (session_id, metric_name, recorded_at)` where
recorded_at is epoch milliseconds.

**Rationale**: Allows multiple delta entries per session per metric over
time (one per idle event). Millisecond-precision timestamps make
collisions practically impossible for sequential idle events. The PK
also serves as a clustered index for per-session lookups.

### Decision 5: Secondary index for cross-session aggregation

**Choice**: Add `CREATE INDEX idx_deltas_metric_time ON
measurement_deltas (metric_name, recorded_at)`.

**Rationale**: The most common Grafana query pattern is
`WHERE metric_name = 'cost' AND date(recorded_at...) = date('now')`.
Without this index, SQLite must full-scan the delta table. With it,
the query performs an index seek on `metric_name` then a range scan
on `recorded_at`. At Year 1 scale (~147K rows), the difference is
~20 rows scanned vs ~147K. The index is automatically maintained by
SQLite with zero manual effort.

### Decision 6: Convenience view with timestamp conversion

**Choice**: Add `v_measurement_deltas` view following the same pattern
as `v_measurements` -- exposing `recorded_at_epoch` (seconds) and
`recorded_at_iso` (RFC3339).

**Rationale**: Consistency with existing views. Grafana panels can use
the `_iso` column directly as the time column without conversion.

### Decision 7: Coverage strategy

All new code is covered by the project-wide 80% line coverage target
enforced by `make test`. Tests are classified as:

- **Unit tests**: Delta computation edge cases (first event, zero
  delta, negative delta, multiple updates), in `src/writer.test.ts`.
- **Integration tests**: End-to-end flow verifying that SUM(delta)
  equals the final cumulative value, in `src/writer.test.ts`.
- **Schema tests**: Table and view existence, index existence, view
  column correctness, in `src/db.test.ts`.

## Risks / Trade-offs

- **Storage growth**: ~36 MB/year at current usage. Acceptable for
  local SQLite. A retention policy can be added in a future change
  if growth becomes a concern.
- **Write overhead**: +2-3ms per idle event (12 SELECT + up to 12
  INSERT). Negligible compared to SDK query time (~50-200ms).
- **Negative deltas**: Possible for code impact metrics (files_changed,
  lines_added, lines_deleted) if changes are reverted within a session.
  The schema allows negative REAL values. SUM(delta) still produces
  the correct final total.
- **Backfill produces single-delta rows**: Historical sessions imported
  by the backfill script get one delta row equal to their full
  cumulative value (since there's no historical breakdown). This is
  correct but means backfilled sessions cannot provide daily breakdowns.
  Daily cost accuracy improves organically as the plugin collects
  new sessions with real incremental deltas.
