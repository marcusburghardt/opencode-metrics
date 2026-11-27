# permission-capture Specification

## Purpose

Provide a local, privacy-preserving record of permission prompts and replies so
operators and the `ansible-role-ai` retrospective can identify recurring
approvals, wait times, broad grants, and permission-policy drift without storing
raw commands, paths, or secrets.

## Requirements

### Requirement: Capture permission events as an observer
The plugin SHALL record `permission.asked` and `permission.replied` events in its
local database. Capture SHALL be observer-only and SHALL NOT approve, reject,
delay, or modify a permission decision.

#### Scenario: Permission is asked and answered
- **GIVEN** a permission request shown to the user
- **WHEN** the user replies `once`, `always`, or `reject`
- **THEN** the plugin SHALL persist one event with both timestamps and the reply
- **AND** the user-visible permission outcome SHALL be unchanged

#### Scenario: Capture fails
- **GIVEN** the metrics database is unavailable or a write fails
- **WHEN** a permission event arrives
- **THEN** the session and permission prompt SHALL continue normally
- **AND** the failure SHALL be logged without surfacing as a user error

### Requirement: Expose contract version 1
The plugin SHALL expose contract version `1` through a `permission_contract`
marker table and SHALL store events in the `permission_events` table.

#### Scenario: Consumer checks the contract
- **GIVEN** the role helper reads the metrics database
- **WHEN** it queries `permission_contract`
- **THEN** it SHALL receive version `1` and know that `permission_events` is
  available

#### Scenario: Contract row is missing
- **GIVEN** a database created before this change
- **WHEN** the migration runs
- **THEN** the plugin SHALL create the marker row with version `1` and a new
  local salt

### Requirement: Record complete permission event fields
Each row in `permission_events` SHALL include a stable permission identifier,
session identifier, project identifier, agent, model, action, canonical
resource, resource hash, reply, asked timestamp, replied timestamp, wait
milliseconds, source tool, source message identifier, and contract version.

#### Scenario: Asked event
- **GIVEN** a `permission.asked` event with session, action, and resources
- **WHEN** the plugin records it
- **THEN** the row SHALL contain the session, action, canonical resource, hash,
  asked timestamp, and contract version
- **AND** reply and replied timestamp SHALL be null

#### Scenario: Replied event
- **GIVEN** an open event for permission id `perm-1`
- **WHEN** a `permission.replied` event arrives with reply `always`
- **THEN** the row SHALL contain the reply, replied timestamp, and wait duration

### Requirement: Deduplicate events and handle late replies
The permission identifier SHALL be unique and a repeated event SHALL upsert
rather than duplicate the row. A late reply SHALL update the existing row. A
reply with no matching ask SHALL be ignored.

#### Scenario: Duplicate delivery
- **GIVEN** the same asked event is delivered twice
- **WHEN** the plugin processes both
- **THEN** exactly one row SHALL exist for that permission identifier

#### Scenario: Orphan reply
- **GIVEN** no event exists for permission id `perm-9`
- **WHEN** a reply for `perm-9` arrives
- **THEN** the plugin SHALL NOT create a row and SHALL NOT fail the session

### Requirement: Canonicalize shell resources
For shell actions the plugin SHALL store a canonical value containing at most
the command head and one subcommand token. Assignments, quoting, URLs, and paths
SHALL be removed.

#### Scenario: Shell command with arguments
- **GIVEN** a shell resource `git push origin feature/secret-name`
- **WHEN** the plugin sanitizes it
- **THEN** the canonical value SHALL be `git push`

#### Scenario: Environment assignment
- **GIVEN** a shell resource `FOO=bar make test`
- **WHEN** the plugin sanitizes it
- **THEN** the canonical value SHALL be `make test`

### Requirement: Canonicalize file and directory resources
For file and directory actions the plugin SHALL store a path class and, for
files, the extension. The full path SHALL NOT be stored.

#### Scenario: Project file
- **GIVEN** a read permission for a file under the project directory
- **WHEN** the plugin sanitizes it
- **THEN** the canonical value SHALL describe the project path class and the
  extension only

#### Scenario: External directory
- **GIVEN** an external-directory permission for a home directory path
- **WHEN** the plugin sanitizes it
- **THEN** the canonical value SHALL describe the home path class only

### Requirement: Hash raw resources and redact secrets
The plugin SHALL store a salted hash of the raw resource for recurrence
detection. It SHALL NOT store secrets, tokens, headers, credentials, private-key
material, or message text.

#### Scenario: Secret appears in a command
- **GIVEN** a shell resource containing an authorization header or token
- **WHEN** the plugin sanitizes it
- **THEN** the canonical value SHALL omit the secret
- **AND** the raw value SHALL NOT be stored by default

#### Scenario: Recurrence detection
- **GIVEN** the same raw resource appears in multiple sessions with different
  arguments
- **WHEN** the plugin stores the events
- **THEN** the salted hash SHALL allow grouping without storing the raw value

### Requirement: Persist saved permission patterns
When a user replies `always`, the plugin SHALL record the save patterns returned
by the permission event in canonical form and SHALL distinguish them from the
presented resource.

#### Scenario: Always reply with a saved pattern
- **GIVEN** an asked event with a save pattern and a reply of `always`
- **WHEN** the reply is recorded
- **THEN** the canonical save pattern SHALL be stored with the event

#### Scenario: Parameterized resource
- **GIVEN** a saved pattern containing variable placeholders or one-off
  arguments
- **WHEN** a consumer inspects the event
- **THEN** it SHALL be able to flag the pattern as non-reusable

### Requirement: Provide a friction view
The plugin SHALL expose a read-only view named `v_permission_friction` that
aggregates events by action, canonical resource, project, agent, and model. The
view SHALL include prompt count, median and p95 wait, always count, reject count,
first-seen, and last-seen timestamps.

#### Scenario: Aggregated friction
- **GIVEN** multiple events for the same canonical resource
- **WHEN** a consumer queries the view for a project and window
- **THEN** it SHALL receive aggregated counts and wait statistics
- **AND** it SHALL NOT need to read raw resources

#### Scenario: Empty window
- **GIVEN** no events in the requested window
- **WHEN** the view is queried
- **THEN** it SHALL return no rows without error

### Requirement: Provide a JSON friction report
The plugin SHALL provide `scripts/permission-report.ts`, which SHALL open the
metrics database read-only and print JSON for a requested window and optional
project.

#### Scenario: JSON output
- **GIVEN** a database with permission events
- **WHEN** the report runs with a day window
- **THEN** it SHALL print valid JSON containing the window, totals, and grouped
  friction rows

#### Scenario: Read-only report
- **GIVEN** the report is run
- **WHEN** it opens the database
- **THEN** it SHALL NOT modify events, metrics, or configuration

### Requirement: Apply retention and configuration defaults
The plugin SHALL enable capture by default with a 90-day retention period. The
settings SHALL be `permission_capture.enabled`,
`permission_capture.retention_days`, and `permission_capture.store_raw`. Cleanup
SHALL remove expired events and SHALL leave other metrics intact.

#### Scenario: Expired events
- **GIVEN** events older than the retention window
- **WHEN** cleanup runs
- **THEN** expired permission events SHALL be removed
- **AND** session measurements SHALL remain unchanged

#### Scenario: Capture disabled
- **GIVEN** `permission_capture.enabled` is false
- **WHEN** permission events arrive
- **THEN** the plugin SHALL NOT write permission events
- **AND** existing session metrics SHALL continue to be recorded

### Requirement: Protect stored permission data
The plugin SHALL keep the metrics database owner-readable only. Raw resource
storage SHALL be disabled by default and, when enabled explicitly, SHALL still
redact secrets.

#### Scenario: Default storage
- **GIVEN** capture enabled with default settings
- **WHEN** events are stored
- **THEN** raw resources SHALL NOT be stored
- **AND** the database SHALL be readable only by the owner

#### Scenario: Raw storage opt-in
- **GIVEN** `permission_capture.store_raw` is enabled
- **WHEN** a resource contains a credential
- **THEN** the stored value SHALL still redact the credential

### Requirement: Preserve existing session metrics
The plugin SHALL keep `permission_prompts` and `permission_wait_seconds`
cumulative metrics unchanged and SHALL keep all existing tables, metrics, and
views readable.

#### Scenario: Existing consumer
- **GIVEN** a consumer reads the existing permission metrics
- **WHEN** capture is enabled
- **THEN** the consumer SHALL receive the same values as before for the same
  session

#### Scenario: Capture absent
- **GIVEN** a database without the permission event table
- **WHEN** the plugin records session metrics
- **THEN** the session metric path SHALL work without the event table

### Requirement: Migrate additively to schema version 7
The plugin SHALL add the permission tables and view through an additive
migration from schema version 6 to 7 and SHALL set `PRAGMA user_version = 7`.

#### Scenario: Existing database
- **GIVEN** a schema version 6 database
- **WHEN** the plugin initializes
- **THEN** it SHALL create the permission objects, seed the contract row, and
  preserve all existing rows

#### Scenario: Repeated initialization
- **GIVEN** a schema version 7 database
- **WHEN** the plugin initializes again
- **THEN** the migration SHALL be idempotent and SHALL NOT reset the salt or
  events

### Requirement: Test the capture contract
The test suite SHALL cover ingestion, duplicate delivery, late replies,
canonicalization, secret redaction, retention cleanup, the friction view, the
JSON report, and fail-open behavior using synthetic events and a temporary
database.

#### Scenario: Synthetic event stream
- **GIVEN** the test suite runs
- **WHEN** it exercises permission capture
- **THEN** it SHALL use a temporary database
- **AND** it SHALL NOT read or modify the user's metrics database

#### Scenario: Redaction regression
- **GIVEN** a synthetic event containing a credential
- **WHEN** the event is stored
- **THEN** the test SHALL fail if the credential appears in the row or the view

### Requirement: Document the contract and limitations
The README SHALL document contract version 1, the table and view names, the
sanitization rules, retention, configuration, and the fact that permission
events cannot be backfilled.

#### Scenario: First enablement
- **GIVEN** capture is enabled on an existing installation
- **WHEN** a user reads the documentation
- **THEN** it SHALL state that earlier permission history is unavailable and
  capture starts from the enablement date
