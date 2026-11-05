# session-flow-metrics Specification

## Purpose
Expose permission, turn, context, timing, and subagent flow metrics alongside
cost so consumers can see where a session's time and money went.

## Requirements

### Requirement: Permission prompt metrics

The plugin SHALL subscribe to `permission.asked` and `permission.replied`
events and record, per session, the number of permission prompts and the
total time spent waiting for replies. A prompt SHALL be counted when a
`permission.asked` event carries a `sessionID`. The wait for a prompt SHALL
be the interval between its `permission.asked` and the matching
`permission.replied` event, keyed by the event's permission identifier.

#### Scenario: One prompt approved

- **GIVEN** a session receives `permission.asked` at t=1000ms for permission
  id "p1"
- **AND** it receives `permission.replied` at t=4000ms for permission id "p1"
- **WHEN** the session next transitions to idle and is captured
- **THEN** `permission_prompts` SHALL be 1
- **AND** `permission_wait_seconds` SHALL be 3.0

#### Scenario: Multiple prompts accumulate

- **GIVEN** a session has three approved prompts with waits of 2s, 5s, and 1s
- **WHEN** the session is captured
- **THEN** `permission_prompts` SHALL be 3
- **AND** `permission_wait_seconds` SHALL be 8.0

#### Scenario: Prompt pending at capture time

- **GIVEN** a `permission.asked` event has no matching
  `permission.replied` event when the session is captured
- **THEN** the prompt SHALL be counted in `permission_prompts`
- **AND** its open interval SHALL NOT be added to `permission_wait_seconds`
- **AND** it SHALL remain eligible for a later capture once replied

#### Scenario: Rejected prompt

- **GIVEN** a prompt is answered with a rejection
- **WHEN** `permission.replied` arrives
- **THEN** the prompt SHALL still count and its wait SHALL be recorded;
  the metric SHALL NOT distinguish approval from rejection

### Requirement: Turn and context metrics

The plugin SHALL derive per-session turn and context metrics from the
session's assistant messages:

- `turns_total`: the number of assistant messages in the session.
- `context_tokens_max`: the largest per-turn context, where context is
  `input + cache.read + cache.write`.
- `context_tokens_final`: the per-turn context of the last assistant
  message, or 0 when the session has no assistant messages.

#### Scenario: Context growth across turns

- **GIVEN** assistant turns with context 20,000, 80,000, and 150,000 tokens
- **WHEN** the session is captured
- **THEN** `turns_total` SHALL be 3
- **AND** `context_tokens_max` SHALL be 150,000
- **AND** `context_tokens_final` SHALL be 150,000

#### Scenario: Session with no assistant messages

- **GIVEN** a session that contains only a user message
- **WHEN** the session is captured
- **THEN** `turns_total` SHALL be 0
- **AND** `context_tokens_max` SHALL be 0
- **AND** `context_tokens_final` SHALL be 0

### Requirement: Timing split metrics

The plugin SHALL derive generation and post-generation time from assistant
message timestamps:

- `generation_seconds`: the sum of `streamed - created` over assistant turns.
- `post_generation_seconds`: the sum of `completed - streamed` over assistant
  turns.

Turns missing either timestamp SHALL be skipped for that metric without
failing the capture.

#### Scenario: Generation and tool wait are separated

- **GIVEN** an assistant turn created at t=0, streamed at t=4000ms, and
  completed at t=9000ms
- **WHEN** the session is captured
- **THEN** `generation_seconds` SHALL be 4.0
- **AND** `post_generation_seconds` SHALL be 5.0

#### Scenario: Missing completion timestamp

- **GIVEN** an assistant turn has `created` and `streamed` but no `completed`
- **WHEN** the session is captured
- **THEN** `generation_seconds` SHALL include the turn
- **AND** `post_generation_seconds` SHALL skip the turn

### Requirement: Compaction metric

The plugin SHALL record `compactions` as the count of compaction markers in
the session's message history.

#### Scenario: One automatic compaction

- **GIVEN** a session contains one compaction marker with reason "auto"
- **WHEN** the session is captured
- **THEN** `compactions` SHALL be 1

### Requirement: Child session count

The plugin SHALL record `child_sessions` as the number of sessions whose
`parentID` equals the captured session's id, excluding the session itself.

#### Scenario: Session with two direct children

- **GIVEN** session "root" has two direct child sessions and one grandchild
- **WHEN** "root" is captured
- **THEN** `child_sessions` SHALL be 2

#### Scenario: Session with no children

- **GIVEN** a session with no sessions referencing it as parent
- **WHEN** it is captured
- **THEN** `child_sessions` SHALL be 0

### Requirement: Flow metrics are registered in the catalog

Every flow metric SHALL be inserted into `metric_definitions` with a unit,
description, and aggregation, following the existing catalog convention.
The units SHALL be `count` for counts and `seconds` for durations, and the
aggregation SHALL be `sum` for all flow metrics.

#### Scenario: Catalog row exists for each metric

- **GIVEN** a freshly created metrics database
- **WHEN** a consumer queries `metric_definitions` for
  `permission_prompts`, `permission_wait_seconds`, `turns_total`,
  `context_tokens_max`, `context_tokens_final`, `generation_seconds`,
  `post_generation_seconds`, `compactions`, and `child_sessions`
- **THEN** one row SHALL exist for each metric name
- **AND** each row SHALL have a non-empty unit and description

### Requirement: Missing data degrades per metric

If a source field needed for a flow metric is absent, the plugin SHALL
record 0 for that metric and SHALL still write the other metrics for the
session. A missing field MUST NOT abort the capture or suppress unrelated
measurements.

#### Scenario: Message without token data

- **GIVEN** an assistant message has no token payload
- **WHEN** the session is captured
- **THEN** context metrics SHALL be 0 for that turn
- **AND** `turns_total`, permission metrics, and cost metrics SHALL still be
  recorded
