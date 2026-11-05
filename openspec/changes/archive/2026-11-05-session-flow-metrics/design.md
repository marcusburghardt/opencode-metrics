## Context

The plugin captures one row set per session on each idle transition. It
already reads the session aggregate (cost, tokens, parent id) and the
conversation messages (for PR/issue artifact extraction). The storage model
is dimensional: a new metric is a new `metric_definitions` row plus a
`measurements`/`measurement_deltas` pair, not a schema migration.

Today the only event families consumed are session lifecycle events. The V2
SDK also emits `permission.asked` and `permission.replied`, which are the only
source for approval counts and approval wait time. The message payloads
already contain per-turn token counts and timestamps, so context growth and
the generation/tool-wait split need no new subscription.

## Goals / Non-Goals

### Goals
- Record permission prompts and approval wait per session.
- Record turn count, peak/final context, generation time, post-generation
  time, compaction count, and direct child count.
- Keep every new value in the existing measurements model so dashboards and
  ad-hoc SQL discover it without schema changes.
- Degrade per metric when a source field is missing.

### Non-Goals
- Reconstructing historical flow metrics for sessions already captured.
  Backfill remains the separate `backfill-v2-source` change.
- Reading OpenCode's own SQLite database. The plugin stays on the SDK.
- Grafana panel changes. The dashboard lives in `ansible-role-ai`.
- Classifying approvals (allow vs reject); only count and duration matter.
- Recursive cost aggregation; `parent_session_id` already supports it.

## Decisions

### One subscription, dispatch by event type

Add `PERMISSION_EVENT_TYPES = ["permission.asked", "permission.replied"]` and
subscribe to the concatenation of lifecycle and permission types in the
existing single loop. The loop already processes events sequentially, which
`writeMetrics` depends on for delta correctness. A second subscription would
introduce interleaving and duplicate reconnect logic.

`handleSessionEvent` dispatches: lifecycle types follow the existing
capture path; permission types update state and return without capturing.

### In-memory permission tracker flushed at capture

A `PermissionTracker` keyed by session id holds:

- `prompts`: number of `permission.asked` events seen
- `waitMs`: accumulated closed intervals
- `open`: map of permission id → asked-at timestamp

On `permission.asked`, increment `prompts` and record the open interval. On
`permission.replied`, close the matching interval and add it to `waitMs`.
Open intervals stay pending across captures so a late reply is counted on the
next capture. State is bounded by session count and is dropped when the
plugin process exits; partial accounting across a restart is acceptable.

### Derive flow metrics from raw V2 messages

Add `deriveFlowMetrics(rawMessages)` to the extractor rather than overloading
`MessageInfo` with token/timing fields used by only one consumer. It scans
assistant messages for `tokens` and `time`, and counts `compaction` entries.
This keeps artifact extraction unchanged and makes the flow calculation a
pure, directly testable function.

Per-turn context is `tokens.input + tokens.cache.read + tokens.cache.write`.
`generationMs` adds `time.streamed - time.created`; `postGenerationMs` adds
`time.completed - time.streamed`. A missing timestamp skips only that metric
for that turn.

### Count children from the metrics database

The SDK adapter has no list-by-parent API. `child_sessions` is computed with
`SELECT COUNT(*) FROM sessions WHERE parent_session_id = ?` inside the write
transaction. A child captured after the parent is reflected the next time the
parent reaches idle; this is documented rather than adding a denormalized
counter.

### Metric catalog stays the single source of truth

New definitions are appended to `METRIC_DEFINITIONS` in `src/db.ts`, with
unit `count` or `seconds` and aggregation `sum`. Metric name strings are
referenced only through that catalog and the extractor's returned object, so
no dashboard-specific names leak into logic.

### Correlation and validation

Permission events are validated with the same `isRecord` guards as lifecycle
events. Events without a string `sessionID` are dropped. The permission id is
taken from the event payload; if absent, the tracker counts the prompt but
cannot close an interval, so no wait is recorded.

## Risks / Trade-offs

- **Approval wait is inside `post_generation_seconds`.** The split is still
  useful, but a consumer subtracting the two metrics should treat the result
  as tool + approval time. Documented in the metric description.
- **In-memory state does not survive a process restart.** Prompts seen before
  a restart but replied after it lose their interval. Counts remain correct.
- **`child_sessions` can lag.** A parent captured before its children exist
  records 0 until its next idle. This avoids a schema change and matches the
  existing incremental model.
- **Event payload drift.** If the SDK renames the permission identifier, the
  tracker still counts prompts but records no waits. Guarded and covered by a
  test with a missing identifier.
- **Message payload size.** `deriveFlowMetrics` walks the same messages the
  extractor already loads, so no additional SDK call is introduced.
- **Constitution alignment.** The change is additive and machine-readable
  (Observable Quality), introduces no dependency (Composability First), and
  is implemented as pure functions with injected clocks (Testability).
