## Why

The plugin records *what a session cost* but not *where the time and money went*.
Cost, tokens, and wall-clock duration are collected; permission prompts, tool
waits, context growth, and compaction are invisible. That gap makes the two
most expensive failure modes impossible to see in the dashboard:

- A single `/unleash` session ran 292 assistant turns and grew to 621k tokens
  of context with no compaction. The last third of its turns cost 71% of the
  session, and turns above 300k context cost 88%. Nothing in the current
  metrics shows that context, not output, drove the bill.
- On the same day, 1,415 shell commands produced 103 distinct permission
  approvals. 74% of those commands carried no explicit timeout, and one
  `gh pr checks` call blocked for 17 hours. The dashboard shows the resulting
  wall-clock duration but not why the session stalled.

Adding flow metrics makes these visible and comparable across sessions,
models, and agents without changing the dimensional storage model.

## What Changes

- **Permission tracking**: subscribe to `permission.asked` and
  `permission.replied` in addition to session lifecycle events, and record:
  - `permission_prompts` (count)
  - `permission_wait_seconds` (sum of asked → replied intervals)
- **Turn and context tracking** derived from the session's assistant messages:
  - `turns_total`
  - `context_tokens_max` and `context_tokens_final` (input + cache read +
    cache write for a turn)
  - `compactions` (count of compaction markers)
- **Timing split** derived from assistant message timestamps:
  - `generation_seconds` (created → streamed)
  - `post_generation_seconds` (streamed → completed, i.e. tool and approval
    wait time)
- **Subagent context**:
  - `child_sessions` (direct children created by this session)
- **Metric catalog**: register every new metric in `metric_definitions` with
  its unit, description, and aggregation so existing queries and Grafana
  panels can discover them.
- **Documentation**: list the new metrics and their semantics in the README
  and the metrics dictionary.

## Capabilities

### New Capabilities
- `session-flow-metrics`: permission, turn, context, timing, and subagent
  flow metrics collected per session alongside the existing cost metrics.

### Modified Capabilities
- `metrics-collection`: the event subscription now covers permission events
  and aggregates per-session permission state before capture.
- `incremental-metrics`: the new metrics participate in the existing
  delta-tracking invariant (deltas sum to the cumulative value).
- `subagent-linking`: expose the direct-child count as a derived metric.

### Removed Capabilities
- None.

## Impact

- `src/index.ts`: extend event subscription and keep per-session permission
  state; flush at capture.
- `src/extractor.ts`: extend `MessageInfo` and the V2 translator to retain
  per-message token and timestamp data needed for context and timing metrics.
- `src/db.ts`: add metric definitions.
- `src/defaults.ts` / `src/config.ts`: no new required configuration; all new
  metrics are always-on. Bounds and event names become named constants.
- Tests: unit tests for permission aggregation, context/turn extraction,
  delta behavior, and event filtering.
- Out of scope (separate repository): Grafana panels for the new metrics.
  The metrics are machine-readable and queryable as soon as they are written.

## Constitution Alignment

Assessed against the Unbound Force org constitution (v1.0.0).

### I. Autonomous Collaboration

**Assessment**: PASS

The change produces additional self-describing measurement rows in the
existing dimensional model. No new inter-agent protocol is introduced, and
consumers do not need to consult the producing agent: metric definitions carry
unit, description, and aggregation.

### II. Composability First

**Assessment**: PASS

The metrics are additive. A deployment that ignores them keeps working
unchanged, and the plugin remains usable without the companion Grafana stack.
No new dependency is introduced.

### III. Observable Quality

**Assessment**: PASS

This is the direct purpose of the change. Every new value is numeric and
stored per session, and the permission and timing metrics are backed by
automated tests with deterministic clocks.

### IV. Testability

**Assessment**: PASS

Permission aggregation, message translation, and context calculation are pure
functions tested in isolation with injected event payloads and clocks. The
event handler remains exported for direct testing, matching the existing
pattern.

### V. Security by Default

**Assessment**: PASS

Permission events are already emitted by the host; the plugin only records
counts and durations, never command text or approval content. No credentials
or tool inputs are stored. The database keeps its existing `0o644` file mode
and restrictive directory permissions.

## Assumptions

- The V2 SDK continues to expose `permission.asked` and `permission.replied`
  with a `sessionID` and timestamp.
- Per-turn token data is available on assistant messages from
  `session.context()`; if a field is absent, the metric is recorded as 0
  rather than dropping the whole capture.
- `post_generation_seconds` includes approval wait. Separating the two is the
  purpose of the permission metrics; the timing split is still useful on its
  own.
