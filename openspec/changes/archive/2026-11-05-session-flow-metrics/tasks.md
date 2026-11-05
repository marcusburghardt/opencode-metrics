<!--
  [P] marks tasks eligible for parallel execution.
  Add [P] when a task: (a) touches different files from
  other [P] tasks in the group, (b) has no dependency
  on prior tasks in the group, (c) can safely execute
  without ordering constraints.
  Do NOT add [P] when tasks modify the same file —
  parallel workers will cause merge conflicts.
  Tasks without [P] run sequentially first, then [P]
  tasks run in parallel.
-->

## 1. Metric catalog and pure helpers

- [x] 1.1 Add definitions for `permission_prompts`,
  `permission_wait_seconds`, `turns_total`, `context_tokens_max`,
  `context_tokens_final`, `generation_seconds`, `post_generation_seconds`,
  `compactions`, and `child_sessions` to `METRIC_DEFINITIONS` in
  `src/db.ts`, with unit `count` or `seconds` and aggregation `sum`.
- [x] 1.2 [P] Create `src/permissions.ts` with `PERMISSION_EVENT_TYPES`,
  a `PermissionTracker` class (prompts, closed wait milliseconds, open
  intervals keyed by permission id), and `drain(sessionID)` that returns
  the metrics and resets closed state.
- [x] 1.3 [P] Add `deriveFlowMetrics(rawMessages)` to `src/extractor.ts`.
  It returns `turns_total`, `context_tokens_max`, `context_tokens_final`,
  `generation_seconds`, `post_generation_seconds`, and `compactions`.
  Skip a turn's timing metric when its timestamps are missing.
- [x] 1.4 [P] Update `MONOTONIC_METRICS` in `src/writer.ts`: add the flow
  metrics except `context_tokens_final` and `child_sessions`, which may
  legitimately decrease.
- [x] 1.5 Add a `countChildSessions(db, sessionID)` helper to `src/db.ts`
  using `SELECT COUNT(*) FROM sessions WHERE parent_session_id = ?`.

## 2. Wiring and capture

- [x] 2.1 Extend `src/index.ts` to subscribe to
  `[...SESSION_LIFECYCLE_EVENT_TYPES, ...PERMISSION_EVENT_TYPES]` in the
  existing single loop, and dispatch permission events to the tracker
  without triggering a capture.
- [x] 2.2 Add the tracker to `PluginRuntime` and flush it in
  `handleSessionIdle`, merging its metrics into `ExtractedData.metrics`.
  Keep unclosed intervals pending across captures.
- [x] 2.3 Add `child_sessions` from `countChildSessions()` to the captured
  metrics at write time, inside the same transaction as the other metrics.
- [x] 2.4 Guard malformed permission payloads: missing or non-string
  `sessionID` drops the event; missing permission id counts the prompt but
  records no wait.

## 3. Tests

- [x] 3.1 [P] Add `src/permissions.test.ts` covering: one prompt, multiple
  prompts, pending prompt at capture, rejected prompt, missing permission
  id, and unrelated reply.
- [x] 3.2 [P] Add `deriveFlowMetrics` cases to `src/extractor.test.ts`
  covering context growth, no assistant messages, missing timestamps, and a
  compaction marker.
- [x] 3.3 [P] Add catalog and `countChildSessions` cases to
  `src/db.test.ts`.
- [x] 3.4 [P] Add monotonic/non-monotonic coverage for the new metrics to
  `src/writer.test.ts`, including the negative `context_tokens_final`
  delta after compaction.
- [x] 3.5 Add event dispatch tests to `src/index.test.ts`: a permission
  event does not capture; a lifecycle event still captures; a malformed
  permission event is ignored.
- [x] 3.6 Add a delta invariant test asserting the sum of each flow
  metric's deltas equals its cumulative value after repeated captures.

## 4. Documentation

- [x] 4.1 [P] Add the flow metrics to the README metrics table with units
  and semantics, including the note that `post_generation_seconds` contains
  approval wait.
- [x] 4.2 [P] Document the event families consumed and the in-memory
  limitation (counts survive, open intervals do not survive a restart).

## 5. Verification

- [x] 5.1 Run `make test`, `make lint`, and `make build`; confirm no
  regressions in existing metric counts or delta tests.
- [x] 5.2 Verify constitution alignment: no new dependency, new values are
  machine-readable, and the pure helpers are tested without the OpenCode
  runtime.
- [x] 5.3 Manual smoke test: run a short session that triggers at least one
  approval, then query `measurements` for the new metric names and confirm
  non-zero `permission_prompts` and `turns_total`.
