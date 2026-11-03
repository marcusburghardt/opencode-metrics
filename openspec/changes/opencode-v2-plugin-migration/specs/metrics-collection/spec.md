# Spec Delta

## MODIFIED Requirements

### Requirement: Automatic Metrics Capture

The plugin SHALL subscribe to the V2 event stream with
`ctx.event.subscribe({ types: ["session.status"], signal })` and capture
session metrics on every idle transition, reading the session identifier from
`event.data.sessionID` and the status from `event.data.status.type`. The
plugin SHALL query the V2 plugin context for session details
(`ctx.session.get()`, `ctx.session.context()`) and write them to the metrics
database. The plugin SHALL NOT require any user interaction after initial
installation for metrics to be collected. The extraction pipeline SHALL
propagate the SDK session's `parentID` field into the stored session record as
`parent_session_id`. When `parentID` is undefined or null, `parent_session_id`
SHALL be stored as NULL.

Sessions SHALL be attributed to the project reported by the session itself
(`session.projectID` and `session.location.directory`), falling back to the
plugin instance's location only when the session carries no project data.
`files_changed` SHALL be the count of distinct files reported in assistant
`snapshot.files` entries. `lines_added` and `lines_deleted` SHALL be recorded
as 0 until OpenCode exposes session diff data to plugins.

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

### Requirement: Error Isolation

The plugin SHALL NOT allow any internal error to propagate to the OpenCode
process. Event handling SHALL be wrapped in error boundaries that log failures
via `console.error()` and continue operation. The event subscription loop
SHALL catch stream-level errors, log them, and stop without rejecting into the
runtime. An abort caused by plugin cleanup SHALL NOT be logged as an error.
The cleanup function returned by `setup` SHALL abort the event subscription on
unload.

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

### Requirement: Plugin Initialization

The plugin SHALL register with OpenCode V2 using
`Plugin.define({ id: "opencode-metrics", setup(ctx) })` from
`@opencode/plugin`. The `setup` function SHALL initialize the data directory,
database, and default configuration. The plugin SHALL log its startup status
via `console.info()`. Initialization failures SHALL be caught and logged via
`console.error()` so the plugin can be disabled without preventing OpenCode
from starting. The `setup` function SHALL return a cleanup function that
aborts the event subscription.

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
- **AND** SHALL return a no-op cleanup function
- **AND** MAY disable metrics collection for the current session with a warning

#### Scenario: Plugin unload

- **GIVEN** the plugin is running and subscribed to events
- **WHEN** OpenCode unloads the plugin
- **THEN** the cleanup function returned by `setup` SHALL abort the event
  subscription via AbortController
- **AND** the event loop SHALL terminate gracefully

## ADDED Requirements

### Requirement: V2 SDK adapter

The `createSDKAdapter` function SHALL accept the V2 plugin context instead of
V1's `PluginInput` and SHALL map `ctx.session.get()` and
`ctx.session.context()` onto the unchanged `SDKClient` interface. It SHALL NOT
re-aggregate cost or tokens from messages, because `Session.Info` already
carries cumulative values. It SHALL use `ctx.location` only as a fallback for
project context.

#### Scenario: Adapter maps session aggregates directly

- **GIVEN** `ctx.session.get()` returns a session with `cost = 0.3`,
  `tokens = { input: 300, output: 130, reasoning: 40, cache: { read: 60,
  write: 20 } }`, `agent`, and `model`
- **WHEN** the adapter's `session.get(id)` is called
- **THEN** it SHALL return those aggregates without reading any messages
- **AND** `session.messages(id)` SHALL be the only path that loads messages

#### Scenario: Adapter provides project context

- **GIVEN** the plugin context has `location.project.id` and
  `location.project.canonical`
- **WHEN** the adapter's `project.current()` is called
- **THEN** it SHALL return that project id and path
- **AND** the extractor SHALL prefer the session's own project data when
  present

### Requirement: V2 message translation

The adapter SHALL translate V2 session messages into the local `MessageInfo`
shape. It SHALL populate `role` from `type`, SHALL return only `user` and
`assistant` messages, and SHALL flatten tool content blocks into a single
output string.

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
- **AND** `output` SHALL be the text content joined into a single string

#### Scenario: Adapter excludes non-conversation message types

- **GIVEN** the context includes `session.*.selected` markers, an `idle`
  marker, and a `synthetic` message
- **WHEN** the adapter maps the session messages
- **THEN** only `user` and `assistant` messages SHALL be returned
- **AND** `messages_total` SHALL match the V1 behavior of counting
  conversation messages only

