# Spec Delta

## ADDED Requirements

### Requirement: V2 SDK adapter

The adapter SHALL accept the V2 plugin context instead of V1's `PluginInput`
and SHALL expose the unchanged `SDKClient` surface (`session.get`,
`session.messages`, `project.current`, `app.log`) to the extraction pipeline.
`session.get()` SHALL return the session's cumulative `cost` and `tokens.*`
values without loading messages. Loading messages SHALL happen only through
`session.messages()`. The adapter SHALL use the plugin instance's location only
as a fallback for project context.

#### Scenario: Adapter maps session aggregates directly

- **GIVEN** `ctx.session.get()` returns a session with `cost = 0.3`,
  `tokens = { input: 300, output: 130, reasoning: 40, cache: { read: 60,
  write: 20 } }`, `agent`, and `model`
- **WHEN** the adapter's `session.get(id)` is called
- **THEN** it SHALL return those aggregates without loading any messages
- **AND** `session.messages(id)` SHALL be the only path that loads messages

#### Scenario: Adapter provides project context

- **GIVEN** the plugin context has `location.project.id` and
  `location.project.canonical`
- **WHEN** the adapter's `project.current()` is called
- **THEN** it SHALL return that project id and path
- **AND** the extractor SHALL prefer the session's own project data when
  present

#### Scenario: Adapter returns the instance fallback when the session has no project data

- **GIVEN** a session whose `projectID` and `location.directory` are both
  absent
- **WHEN** the extractor resolves the project for that session
- **THEN** it SHALL use the plugin instance's project id and path
- **AND** SHALL NOT record an empty `project_id`

### Requirement: V2 message translation

The adapter SHALL translate V2 session messages into the local message shape.
It SHALL populate `role` from `type`, SHALL return only `user` and `assistant`
messages, and SHALL flatten tool content blocks into a single output string.
Unknown content variants and absent content SHALL be ignored rather than
raising.

#### Scenario: Adapter maps V2 user messages

- **GIVEN** `ctx.session.context()` returns a user message with
  `type: "user"` and `text: "hello"`
- **WHEN** the adapter maps it
- **THEN** the result SHALL have `role: "user"`
- **AND** one text part with `content: "hello"`

#### Scenario: Adapter maps assistant content and tool output

- **GIVEN** `ctx.session.context()` returns an assistant message whose
  `content` holds a text entry and a tool entry with `name: "bash"`,
  `state.input`, and `state.content` containing text blocks
- **WHEN** the adapter maps it
- **THEN** the result SHALL contain a text part and a tool part
- **AND** the tool part SHALL use `name` as `tool`
- **AND** `args` SHALL be the tool `state.input`
- **AND** `output` SHALL be the text content joined with `"\n"` into a single
  string

#### Scenario: Adapter excludes non-conversation message types

- **GIVEN** the context includes `session.*.selected` markers, an `idle`
  marker, and a `synthetic` message
- **WHEN** the adapter maps the session messages
- **THEN** only `user` and `assistant` messages SHALL be returned
- **AND** `messages_total` SHALL match the V1 behavior of counting
  conversation messages only

#### Scenario: Tool part with no text content

- **GIVEN** an assistant tool entry whose `state.content` is empty, absent,
  or contains no `type: "text"` entries
- **WHEN** the adapter maps it
- **THEN** the tool part's `output` SHALL be an empty string
- **AND** the adapter SHALL NOT raise

#### Scenario: Unknown content variant

- **GIVEN** an assistant message with one text entry and one content entry
  of an unknown type
- **WHEN** the adapter maps it
- **THEN** the unknown entry SHALL be skipped
- **AND** the text entry SHALL still be mapped

### Requirement: Agent and model provenance

The stored `agent` and `model` SHALL be read from the session's current
selection (`Session.Info.agent` / `Session.Info.model`), not from the first
user message. This is the third documented behavior change in this migration
alongside per-session project attribution and session diff statistics.

#### Scenario: Session switches agent mid-session

- **GIVEN** a session whose first user message used agent `plan`
- **AND** whose current selection is agent `build` and model `anthropic/x`
- **WHEN** the plugin writes the session metrics
- **THEN** the stored agent SHALL be `build`
- **AND** the stored model SHALL be `anthropic/x`
- **AND** classification SHALL be evaluated against those values

### Requirement: Sequential event handling

The plugin SHALL process session lifecycle events sequentially: each event
SHALL be fully handled before the next event is consumed, so at most one write
per session is in flight. This bounds the subscription buffer and prevents
double-counted measurement deltas. Terminal events for one turn SHALL be
debounced per session (default window 750 ms, injectable for tests) so that
one turn produces one capture. The debounce state SHALL be bounded: entries
older than the window SHALL be evicted.

#### Scenario: Overlapping idle events do not double-count deltas

- **GIVEN** a session emits two idle events in quick succession
- **WHEN** the plugin handles them
- **THEN** the second event SHALL be handled only after the first write
  completes
- **AND** `SUM(measurement_deltas.delta)` SHALL equal the session's cumulative
  value, not twice the last increment

### Requirement: Subscription recovery

A stream-level failure SHALL NOT permanently silence collection. The plugin
SHALL make at most three subscribe attempts (the initial attempt plus two
resubscriptions) before logging a terminal stop and exiting the loop. Retry
delay SHALL be `min(retryBaseDelayMs * 2^n, 8000)` ms, including the first
delay, with a default base of 500 ms. The retry budget, base delay, and sleep
function SHALL be injectable for tests.

#### Scenario: Stream error triggers bounded resubscription

- **GIVEN** the plugin is subscribed and the stream fails on every attempt
- **WHEN** the loop handles the failures
- **THEN** it SHALL log three attempt-failure lines, two resubscribe lines, and
  one terminal-stop line at error level after the third failure
- **AND** the terminal-stop line SHALL be distinguishable from normal
  completion
- **AND** SHALL NOT reject into the OpenCode runtime

#### Scenario: Backoff doubles and is capped

- **GIVEN** a retry sequence with `retryBaseDelayMs` of 6000 ms
- **WHEN** two retries elapse
- **THEN** the recorded delays SHALL be 6000 ms and 8000 ms (cap)
- **AND** with the default base the delays SHALL be 500 ms and 1000 ms

#### Scenario: A successful subscription resets the retry budget

- **GIVEN** a subscription that succeeds after one failure
- **WHEN** that subscription later fails
- **THEN** the plugin SHALL again have three attempts available

### Requirement: Subscription lifecycle is observable

The plugin SHALL record each subscribe, resubscribe, and terminal stop in its
own output so an operator can distinguish "no traffic" from "collection
stopped". A normal iterator completion SHALL produce a terminal line
distinguishable from a failure stop.

#### Scenario: Normal stream completion is logged

- **GIVEN** the subscription iterator completes without an error
- **WHEN** the loop observes completion
- **THEN** it SHALL log a terminal stop line distinguishing completion from
  failure
- **AND** SHALL NOT treat completion as an error

### Requirement: Log content restriction

The plugin's log output SHALL contain only metric and behavior metadata:
session identifier, operation name, error name, and error message. Log output
SHALL NOT contain tool call output, message text, file contents, or tool
arguments.

#### Scenario: Tool output is not logged

- **GIVEN** a capture fails while processing an assistant message whose tool
  output contains arbitrary text
- **WHEN** the plugin logs the failure
- **THEN** the logged text SHALL name the session, operation, and error
- **AND** SHALL NOT contain the tool output, message text, or file contents

## MODIFIED Requirements

### Requirement: Automatic Metrics Capture

<!-- Previously: "The plugin SHALL subscribe to session.status events and
capture session metrics on every transition to idle state. The plugin SHALL
query the OpenCode SDK client for session details..." -->

The plugin SHALL subscribe to the V2 session lifecycle event stream with
`ctx.event.subscribe({ types: ["session.status", "session.idle",
"session.execution.succeeded", "session.execution.failed",
"session.execution.interrupted"], signal })` and capture session metrics when
a turn reaches a terminal state. A terminal state is a `session.status` event
whose `data.status.type` is `idle`, any `session.idle` event, or any
`session.execution.succeeded`, `session.execution.failed`, or
`session.execution.interrupted` event. The plugin SHALL read the session
identifier from `event.data.sessionID`. Non-terminal `session.status`
transitions (`busy`, `retry`) SHALL NOT trigger a capture. Because several
terminal families can fire for one turn, captures SHALL be debounced per
session so one turn produces one capture. The plugin SHALL query the V2 plugin
context for session details (`ctx.session.get()`, `ctx.session.context()`) and
write them to the metrics database. The plugin SHALL NOT require any user
interaction after initial installation for metrics to be collected. The
extraction pipeline SHALL propagate the SDK session's `parentID` field into
the stored session record as `parent_session_id`. When `parentID` is undefined
or null, `parent_session_id` SHALL be stored as NULL.

`cost` and `tokens_*` SHALL represent the session's own cumulative values as
reported by `Session.Info`, and SHALL NOT include the values of child
(sub-agent) sessions. Recursive aggregation across the session tree remains
the responsibility of the `subagent-linking` views.

Sessions SHALL be attributed to the project reported by the session itself
(`session.projectID` and `session.location.directory`), falling back to the
plugin instance's location only when the session carries no project data.
`files_changed` SHALL be the count of distinct, repo-relative file paths
reported in assistant `snapshot.files` entries across the session. `snapshot`
entries that are absent, null, or contain non-string values SHALL contribute
nothing. `lines_added` and `lines_deleted` SHALL be recorded as 0 until
OpenCode exposes session diff data to plugins.

#### Scenario: First session idle after plugin installation

- **GIVEN** the plugin is installed and OpenCode V2 is running
- **WHEN** a session transitions to idle for the first time
- **THEN** a new session record SHALL be created in the sessions table
- **AND** measurement rows SHALL be created for all v1 metrics
- **AND** a project record SHALL be created or updated in the projects table

#### Scenario: Subsequent idle events in the same session

- **GIVEN** a session record already exists in metrics.db
- **WHEN** the same session transitions to idle again (after another
  prompt/response cycle)
- **THEN** the session record SHALL be updated with the latest cumulative
  values (cost, tokens, duration, timestamps)
- **AND** measurement rows SHALL be updated with the latest values

#### Scenario: Sub-agent session captures parent_session_id

- **GIVEN** the SDK returns a session with parentID = "sess-abc-123"
- **WHEN** the plugin processes the session idle event
- **THEN** the session record written to the database SHALL have
  parent_session_id = "sess-abc-123"

#### Scenario: Root session has NULL parent_session_id

- **GIVEN** the SDK returns a session with parentID = undefined
- **WHEN** the plugin processes the session idle event
- **THEN** the session record written to the database SHALL have
  parent_session_id = NULL

#### Scenario: Session resumed after days

- **GIVEN** a session was last active 10 days ago and has an existing record
  in metrics.db
- **WHEN** the user resumes the session and it transitions to idle
- **THEN** the existing session record SHALL be updated with the new
  cumulative values
- **AND** the ended_at timestamp SHALL reflect the latest activity

#### Scenario: Session from another project is attributed correctly

- **GIVEN** the plugin is loaded for project A
- **AND** a session belonging to project B transitions to idle
- **WHEN** the plugin processes the event
- **THEN** the session and measurement rows SHALL reference project B's
  `project_id`
- **AND** the project path SHALL come from the session's location, not the
  plugin instance's directory

#### Scenario: V2 diff statistics are recorded from snapshots

- **GIVEN** a session's assistant messages report `snapshot.files` containing
  three distinct paths
- **WHEN** the plugin writes the session metrics
- **THEN** `files_changed` SHALL be 3
- **AND** `lines_added` and `lines_deleted` SHALL be 0

#### Scenario: Overlapping snapshots count distinct files once

- **GIVEN** two assistant messages report `snapshot.files` = ["a.ts", "b.ts"]
  and ["b.ts", "c.ts"]
- **WHEN** the plugin writes the session metrics
- **THEN** `files_changed` SHALL be 3 (the distinct union)
- **AND** SHALL NOT be 4 (the sum)

#### Scenario: Session with no snapshots

- **GIVEN** a session whose assistant messages report no `snapshot.files`
- **WHEN** the plugin writes the session metrics
- **THEN** `files_changed` SHALL be 0
- **AND** the session record SHALL still be written

#### Scenario: Non-idle status transitions are ignored

- **GIVEN** the plugin is subscribed to the lifecycle stream
- **WHEN** a `session.status` event arrives with `status.type` of `busy` or
  `retry`
- **THEN** the plugin SHALL NOT query or write session metrics

#### Scenario: `session.idle` triggers capture

- **GIVEN** the plugin is subscribed to the lifecycle stream
- **WHEN** a `session.idle` event arrives with a `data.sessionID`
- **THEN** the plugin SHALL capture that session

#### Scenario: `session.execution.succeeded` triggers capture

- **GIVEN** the plugin is subscribed to the lifecycle stream
- **WHEN** a terminal `session.execution.*` event arrives with a
  `data.sessionID`
- **THEN** the plugin SHALL capture that session

#### Scenario: Duplicate terminal events for one turn produce one capture

- **GIVEN** the same session emits a `session.status` idle event and a
  `session.idle` event (or a terminal `session.execution.*` event) for one
  turn
- **WHEN** the plugin handles them within the debounce window
- **THEN** only one capture SHALL be performed for that session
- **AND** the duplicate events SHALL NOT move the debounce timestamp

#### Scenario: Malformed event payload is skipped

- **GIVEN** an event whose `data` is absent, or whose `data.sessionID` is
  null or empty
- **WHEN** the plugin handles it
- **THEN** it SHALL log a warning and skip the write
- **AND** SHALL NOT crash or throw

### Requirement: Error Isolation

<!-- Previously: "The plugin SHALL NOT allow any internal error to propagate
to the OpenCode process. All event handling SHALL be wrapped in error
boundaries that log failures and continue operation." (logged via
client.app.log()) -->

The plugin SHALL NOT allow any internal error to propagate to the OpenCode
process. Event handling SHALL be wrapped in error boundaries that log failures
via `console.error()` and continue operation. A single failed capture SHALL NOT
stop the subscription: subsequent idle events SHALL still be captured. The
event subscription loop SHALL catch stream-level errors, log them, and recover
per the Subscription recovery requirement. An abort caused by plugin cleanup
SHALL NOT be logged as an error, and abort SHALL be identified by the signal's
`aborted` state rather than by matching message text. The cleanup function
returned by `setup` SHALL abort the event subscription on unload and SHALL stop
the loop from consuming further events. A capture already in progress SHALL
complete or roll back atomically: no partially written row and no
`measurement_deltas` entry for an abandoned capture.

#### Scenario: Database write failure

- **GIVEN** a session transitions to idle
- **WHEN** the metrics database write fails (e.g., disk full)
- **THEN** the error SHALL be logged via `console.error()` at error level
- **AND** OpenCode SHALL continue operating normally
- **AND** the plugin SHALL attempt to write metrics on the next idle event

#### Scenario: SDK query failure

- **GIVEN** a session transitions to idle
- **WHEN** the plugin context query for session details fails
- **THEN** the error SHALL be logged via `console.error()` at error level
- **AND** the plugin SHALL NOT crash or cause OpenCode to crash

#### Scenario: Event subscription stream failure

- **GIVEN** the plugin is subscribed to the session status stream
- **WHEN** the stream throws an unexpected error
- **THEN** the error SHALL be logged via `console.error()`
- **AND** the plugin SHALL NOT reject into the OpenCode runtime
- **AND** OpenCode SHALL continue operating normally

#### Scenario: Cleanup aborts the subscription

- **GIVEN** the plugin is running and subscribed to events
- **WHEN** OpenCode unloads the plugin
- **THEN** the cleanup function SHALL abort the subscription signal
- **AND** the abort SHALL NOT be logged as an error

#### Scenario: Cleanup during an in-flight capture

- **GIVEN** a capture is in progress when the plugin is unloaded
- **WHEN** the abort signal fires
- **THEN** the loop SHALL stop consuming further events
- **AND** the in-flight write SHALL complete or roll back atomically
- **AND** no partial session row or orphan `measurement_deltas` entry SHALL
  remain

### Requirement: Plugin Initialization

<!-- Previously: "The plugin SHALL initialize on OpenCode startup by creating
the data directory, database, and default configuration if they do not exist.
The plugin SHALL log its startup status via client.app.log()." -->

The plugin SHALL register with OpenCode V2 using
`Plugin.define({ id: "opencode-metrics", setup(ctx) })` from
`@opencode/plugin`. The `setup` function SHALL initialize the data directory,
database, and default configuration. The plugin SHALL log its startup status
via `console.info()`. Initialization failures SHALL be caught and logged via
`console.error()` so the plugin can be disabled without preventing OpenCode
from starting; on failure the plugin SHALL NOT start the event subscription and
SHALL return a no-op cleanup function. The `setup` function SHALL return a
cleanup function that aborts the event subscription.

When the plugin API package imports successfully but its exported version is
incompatible with the version this release was built against, `setup` SHALL
log an actionable error naming the supported range and SHALL return a no-op
cleanup function. The supported range SHALL be `>=2.2.5 <3.0.0`. This check
covers version drift on an import-compatible package; it SHALL NOT be
described as covering hosts where the module itself fails to load.

#### Scenario: First-time initialization

- **GIVEN** the plugin is installed but has never run before
- **WHEN** OpenCode starts
- **THEN** the plugin SHALL create ~/.local/share/opencode-metrics/ with
  directory permissions 0o755
- **AND** SHALL create metrics.db with the full schema and file permissions
  0o644
- **AND** SHALL write a default config.yaml with file permissions 0o644
- **AND** SHALL log an initialization message at info level

#### Scenario: Subsequent startups

- **GIVEN** the data directory, database, and config already exist
- **WHEN** OpenCode starts
- **THEN** the plugin SHALL open the existing database and load the existing
  config
- **AND** SHALL NOT overwrite the user's config.yaml
- **AND** SHALL log a startup message at info level

#### Scenario: Initialization failure

- **GIVEN** the plugin is installed but the data directory cannot be created
  (e.g., permission denied, read-only filesystem)
- **WHEN** OpenCode starts
- **THEN** the plugin SHALL log the error at error level via `console.error()`
- **AND** SHALL NOT crash or cause OpenCode to crash
- **AND** SHALL NOT start the event subscription
- **AND** SHALL return a no-op cleanup function

#### Scenario: Plugin unload

- **GIVEN** the plugin is running and subscribed to events
- **WHEN** OpenCode unloads the plugin
- **THEN** the cleanup function returned by `setup` SHALL abort the event
  subscription via AbortController
- **AND** the event loop SHALL terminate gracefully

#### Scenario: Incompatible plugin package version

- **GIVEN** the resolved plugin API package imports successfully but reports a
  version outside `>=2.2.5 <3.0.0`
- **WHEN** `setup` runs
- **THEN** the plugin SHALL log an actionable error naming the supported range
- **AND** SHALL return a no-op cleanup function
- **AND** SHALL NOT start the event subscription
- **AND** SHALL NOT prevent OpenCode from starting

### Requirement: Graceful Handling of Missing Data

<!-- Previously: the requirement was written against V1 SDK payloads and
treated absent diff stats as an exceptional case. -->

The plugin SHALL handle missing or null fields in session data gracefully.
Numeric fields SHALL default to 0 when missing. String fields SHALL default to
"unknown" when missing. Derived metrics whose source values are undefined SHALL
be skipped (not recorded) rather than producing NaN or null values. The
`event.data` shape SHALL be validated before use: absent `data`, absent
`data.status`, or an absent/null `data.sessionID` SHALL cause the event to be
skipped with a warning. `lines_added` and `lines_deleted` being 0 is the
expected state for all V2 sessions, not an error condition.

#### Scenario: Session with missing fields

- **GIVEN** a session transitions to idle
- **AND** the session data has null cost, missing token counts, and no diff
  stats
- **WHEN** the plugin processes the session
- **THEN** cost SHALL be recorded as 0
- **AND** token metrics SHALL be recorded as 0
- **AND** files_changed, lines_added, lines_deleted SHALL be recorded as 0
- **AND** the session record SHALL be created with "unknown" for any missing
  string fields

#### Scenario: Session with null session_id

- **GIVEN** a session transitions to idle
- **AND** the event payload contains a null or empty `data.sessionID`
- **WHEN** the plugin processes the event
- **THEN** the plugin SHALL log a warning at warn level and skip the write
- **AND** SHALL NOT crash or throw an exception
