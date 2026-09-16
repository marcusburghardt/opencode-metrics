## Requirements

### Requirement: Automatic Metrics Capture

The plugin SHALL subscribe to session.status events and capture session
metrics on every transition to idle state. The plugin SHALL query the
OpenCode SDK client for session details and write them to the metrics
database. The plugin SHALL NOT require any user interaction after
initial installation for metrics to be collected.

#### Scenario: First session idle after plugin installation

- **GIVEN** the plugin is installed and OpenCode is running
- **WHEN** a session transitions to idle for the first time
- **THEN** a new session record SHALL be created in the sessions table
- **AND** measurement rows SHALL be created for all v1 metrics
- **AND** a project record SHALL be created or updated in the projects
  table

#### Scenario: Subsequent idle events in the same session

- **GIVEN** a session record already exists in metrics.db
- **WHEN** the same session transitions to idle again (after another
  prompt/response cycle)
- **THEN** the session record SHALL be updated with the latest
  cumulative values (cost, tokens, duration, timestamps)
- **AND** measurement rows SHALL be updated with the latest values

#### Scenario: Session resumed after days

- **GIVEN** a session was last active 10 days ago and has an existing
  record in metrics.db
- **WHEN** the user resumes the session and it transitions to idle
- **THEN** the existing session record SHALL be updated with the new
  cumulative values
- **AND** the ended_at timestamp SHALL reflect the latest activity

### Requirement: Error Isolation

The plugin SHALL NOT allow any internal error to propagate to the
OpenCode process. All event handling SHALL be wrapped in error
boundaries that log failures and continue operation.

#### Scenario: Database write failure

- **GIVEN** a session transitions to idle
- **WHEN** the metrics database write fails (e.g., disk full)
- **THEN** the error SHALL be logged via client.app.log() at error level
- **AND** OpenCode SHALL continue operating normally
- **AND** the plugin SHALL attempt to write metrics on the next idle
  event

#### Scenario: SDK query failure

- **GIVEN** a session transitions to idle
- **WHEN** the SDK client query for session details fails
- **THEN** the error SHALL be logged via client.app.log() at error level
- **AND** the plugin SHALL NOT crash or cause OpenCode to crash

### Requirement: Plugin Initialization

The plugin SHALL initialize on OpenCode startup by creating the data
directory, database, and default configuration if they do not exist.
The plugin SHALL log its startup status via client.app.log().

#### Scenario: First-time initialization

- **GIVEN** the plugin is installed but has never run before
- **WHEN** OpenCode starts
- **THEN** the plugin SHALL create ~/.local/share/opencode-metrics/
  with directory permissions 0o755
- **AND** SHALL create metrics.db with the full schema and file
  permissions 0o644
- **AND** SHALL write a default config.yaml with file permissions
  0o644
- **AND** SHALL log an initialization message at info level

#### Scenario: Subsequent startups

- **GIVEN** the data directory, database, and config already exist
- **WHEN** OpenCode starts
- **THEN** the plugin SHALL open the existing database and load the
  existing config
- **AND** SHALL NOT overwrite the user's config.yaml
- **AND** SHALL log a startup message at info level

#### Scenario: Initialization failure

- **GIVEN** the plugin is installed but the data directory cannot be
  created (e.g., permission denied, read-only filesystem)
- **WHEN** OpenCode starts
- **THEN** the plugin SHALL log the error at error level via
  client.app.log()
- **AND** SHALL NOT crash or cause OpenCode to crash
- **AND** MAY disable metrics collection for the current session
  with a warning

### Requirement: Graceful Handling of Missing Data

The plugin SHALL handle missing or null fields in SDK session data
gracefully. Numeric fields SHALL default to 0 when missing. String
fields SHALL default to "unknown" when missing. Derived metrics
whose source values are undefined SHALL be skipped (not recorded)
rather than producing NaN or null values.

#### Scenario: Session with missing fields

- **GIVEN** a session transitions to idle
- **AND** the SDK returns session data with null cost, missing token
  counts, and no git diff stats
- **WHEN** the plugin processes the session
- **THEN** cost SHALL be recorded as 0
- **AND** token metrics SHALL be recorded as 0
- **AND** files_changed, lines_added, lines_deleted SHALL be
  recorded as 0
- **AND** the session record SHALL be created with "unknown" for
  any missing string fields

#### Scenario: Session with null session_id

- **GIVEN** a session transitions to idle
- **AND** the event payload contains a null or empty session_id
- **WHEN** the plugin processes the event
- **THEN** the plugin SHALL log a warning and skip the write
- **AND** SHALL NOT crash or throw an exception
