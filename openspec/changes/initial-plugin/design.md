## Context

OpenCode stores session data in ~/.local/share/opencode/opencode.db
(SQLite). The session table includes cost, token counts (input, output,
reasoning, cache_read, cache_write), agent type, model (JSON),
project_id, parent_id, git diff stats, and timestamps. Messages and
tool invocations are stored in the message and part tables. This data
is rich but not structured for analytics or time-series queries.

OpenCode's plugin system supports event hooks including session.status
(fires on every idle/busy/retry transition), tool.execute.before/after,
and file.edited. Plugins receive a client SDK object for querying
session details programmatically, and a Bun shell API for system
commands. Plugins run inside the OpenCode process using the Bun runtime.

Multiple concurrent OpenCode instances are a common usage pattern
(multiple terminals, different projects). Any write strategy must handle
concurrent access to the shared metrics database.

The session.status event with type "idle" fires after every
prompt/response cycle, not once per session. There is no "session ended"
event. Sessions can be resumed days or weeks later. The event payload
contains only the sessionID; full session details must be queried via
the SDK client.

## Goals / Non-Goals

### Goals

- Collect session metrics automatically with zero user interaction after
  initial installation
- Store metrics in a format queryable by Grafana (SQLite with the
  frser-sqlite-datasource plugin) and standard SQL tools
- Make the schema extensible so new metrics require no schema migrations
- Handle concurrent writes from multiple OpenCode instances safely
- Provide sensible defaults that work out of the box, with full
  customization via a YAML config file
- Include actionable documentation covering the complete user journey
  from installation through troubleshooting

### Non-Goals

- Historical backfill from opencode.db (collector script responsibility,
  planned for ansible-role-ai)
- Markdown report generation (collector script responsibility)
- Grafana container management or dashboard provisioning
  (planned for ansible-role-ai)
- Push-based integration with external monitoring systems (Prometheus,
  Datadog) -- potential future enhancement
- Modifying or writing to OpenCode's internal database
- Real-time streaming metrics (batch on session idle is sufficient)
- Per-turn cost tracking within a session (UPSERT captures cumulative
  state)

## Decisions

### 1. Subscribe to session.status, not session.idle

Subscribe to the event handler and filter for events where
event.type === "session.status" with status type "idle". The
session.idle event is deprecated in the OpenCode schema (replaced by
session.status with status.type === "idle"). Both currently fire, but
session.status is the forward-compatible choice.

**Rationale**: Using the non-deprecated event protects against future
OpenCode releases that may remove session.idle. The session.status
event also provides the status type in its payload, enabling future use
of busy and retry transitions for richer metrics (e.g., retry counts,
time-in-busy).

### 2. UPSERT on every idle transition

session.status fires after every prompt/response cycle, not once per
session. The plugin UPSERTs the session record on each idle event,
updating metrics cumulatively. This handles multi-turn sessions,
resumed sessions (even after days or weeks), and avoids the need to
detect "session end" (no such event exists in OpenCode).

**Rationale**: There is no "session completed" event. Users can close
OpenCode and resume sessions days later. UPSERT-on-idle ensures
metrics.db always reflects the latest cumulative state of every
session without requiring end-of-session detection. First idle creates
the record; subsequent idles update it.

### 3. Dimensional model with measurements fact table

Instead of a normalized table with a column per metric (which requires
ALTER TABLE for new metrics), use a fact table where each metric is a
row: measurements(session_id, metric_name, value, recorded_at). A
metric_definitions table provides the self-describing catalog (name,
unit, description, aggregation type).

Schema:

```
sessions(session_id PK, project_id, agent, model, classification,
         title, started_at, ended_at, metadata JSON)
projects(project_id PK, name, worktree)
metric_definitions(metric_name PK, unit, description, aggregation)
measurements(session_id + metric_name composite PK, value REAL,
             recorded_at INTEGER)
  INDEX(recorded_at, metric_name)  -- time-series queries
  INDEX(metric_name, recorded_at)  -- per-metric queries
```

**Rationale**: OpenCode's session schema has evolved through 21 database
migrations. A rigid normalized metrics table would require parallel
schema migrations. The dimensional model absorbs change: new metrics
from future OpenCode versions are new rows in measurements and a new
entry in metric_definitions. Zero schema changes, zero code changes for
metric additions.

### 4. SQLite WAL mode with busy_timeout and retry logic

Use WAL journal mode (PRAGMA journal_mode=WAL), busy_timeout of 5000ms,
and application-level retry logic (3 attempts, exponential backoff from
100ms). All writes for a single idle event are wrapped in a single
transaction (~12 UPSERTs, <10ms lock hold time).

**Rationale**: Multiple OpenCode instances writing to the same
metrics.db is a common scenario. WAL mode allows concurrent readers and
serializes writers with queuing. The busy_timeout prevents immediate
SQLITE_BUSY failures. The retry logic provides a safety net for rare
cases where contention exceeds the timeout. The short transaction
duration (<10ms) makes actual contention extremely unlikely even with
5+ concurrent instances.

### 5. Classification cache per session

The classification engine caches its result per session_id. On
subsequent idle events for the same session, it skips re-evaluation
unless the message count has changed. Classification requires querying
message and part data via the SDK, which is the most expensive operation
per idle event.

**Rationale**: A single session may fire 20+ idle events (one per
prompt/response cycle). Querying the SDK for message content on every
idle event would be wasteful. Since classification depends on session
content (first user message, tool usage, agent type), and content only
changes when new messages are added, the message count serves as an
efficient invalidation signal.

### 6. First-run auto-initialization

On plugin load, check for the data directory and database. If missing,
create them with sensible defaults. Write a default config.yaml with
commented classification rules. The user should be able to install the
plugin and immediately start collecting metrics with zero configuration.

**Rationale**: Convention over Configuration principle. Most users will
be satisfied with the default classification rules. Those who need
customization can edit config.yaml afterward. The zero-configuration
install path is critical for adoption.

### 7. Use session data from the SDK client, not opencode.db

The plugin queries session details via the SDK client object provided in
the plugin context, not by opening opencode.db directly.

**Rationale**: The SDK is the supported API surface. Direct database
access couples the plugin to OpenCode's internal schema, which has no
stability guarantees. The SDK provides type-safe access that survives
schema migrations. The companion Python collector scripts in
ansible-role-ai read opencode.db directly for backfill purposes, but
that is a maintenance tool, not the steady-state data path.

### 8. Coverage strategy

The project uses a two-level testing strategy: unit tests per module
(db, writer, config, classifier, extractor) and integration tests for
the full event-to-database flow. Coverage is measured using
`bun test --coverage`.

- **Target**: minimum 80% line coverage across all source modules.
- **Ratchet**: the Makefile `test` target SHALL enforce the coverage
  threshold; any coverage regression below the target SHALL fail the
  build.
- **Classification**: tasks 2.8, 3.6, 4.5, 5.7, 6.7 are unit tests;
  task 7.6 is an integration test; task 7.7 covers error isolation.

**Rationale**: The constitution (Principle IV) requires specific
coverage targets and ratchet enforcement. The 80% threshold provides
a meaningful quality floor while remaining achievable for a v0.1.0
release. Ratchet enforcement prevents coverage erosion as the
codebase evolves.

### 9. Schema versioning via PRAGMA user_version

Use SQLite's built-in `PRAGMA user_version` to track the database
schema version. Set to 1 on initial creation. On startup, read the
pragma and apply any necessary migrations for older schema versions
before proceeding. This costs zero storage overhead (user_version is
a built-in SQLite header field).

**Rationale**: The dimensional model avoids migrations for new metrics,
but structural changes (new tables, new indexes, column additions)
require a version detection mechanism. Designing this in from v1
avoids a painful retrofit.

### 10. Timestamp convention

All timestamp fields in the database (started_at, ended_at,
recorded_at) store Unix epoch milliseconds as INTEGER values. This
matches OpenCode's internal timestamp format and enables consistent
time-series queries across all timestamp columns.

**Rationale**: Using milliseconds aligns with the JavaScript/TypeScript
ecosystem (Date.now() returns milliseconds) and OpenCode's SDK. The
Grafana query pattern `date(recorded_at/1000, 'unixepoch')` is
documented in the metrics-storage spec.

### 11. data_dir override semantics

The `data_dir` field in config.yaml overrides the location of the
metrics database only. Config.yaml itself is always read from the
default location (`$XDG_DATA_HOME/opencode-metrics/config.yaml`,
falling back to `~/.local/share/opencode-metrics/config.yaml`). The
`data_dir` value SHALL be an absolute path or use `~` for home
directory expansion. Empty strings and relative paths SHALL be
rejected with a warning, falling back to the default directory.

**Rationale**: Reading the config from a fixed location avoids the
circular dependency where config.yaml specifies its own location.
The database is the only artifact whose path benefits from override
(e.g., placing it on a faster disk or a shared mount).

## Risks / Trade-offs

- **Risk**: session.status event semantics could change in future
  OpenCode versions.
  **Mitigation**: Pin to the documented event type string. Gracefully
  handle unknown event types by ignoring them. Wrap all event handling
  in try/catch to prevent plugin crashes.

- **Risk**: bun:sqlite may behave differently from standard SQLite in
  edge cases (WAL mode, busy handling).
  **Mitigation**: Test WAL mode and concurrent access explicitly with
  bun:sqlite. Document any Bun-specific behavior discovered.

- **Trade-off**: UPSERT-on-idle means metrics.db shows the latest
  cumulative state but not the progression within a session (e.g.,
  cost at turn 5 vs turn 10). This is acceptable because per-turn
  cost tracking would create significant data volume with limited
  analytical value. Users who need turn-level data can query
  opencode.db directly.

- **Trade-off**: Classification accuracy depends on heuristic rules
  that may misclassify some sessions. This is acceptable because
  rules are user-editable via config.yaml, and misclassification does
  not affect cost or token accuracy -- only the classification label.

- **Risk**: Large sessions with many messages may cause slow SDK
  queries during extraction.
  **Mitigation**: The classification cache avoids redundant queries.
  Message content scanning is bounded to the first user message for
  PR URL detection. Full part scanning (for gh pr create detection)
  uses the same SDK call that retrieves messages.

- **Trade-off**: No data retention or archival strategy in v1.
  metrics.db will grow unboundedly over time (estimated ~87,600
  measurement rows per year at 20 sessions/day). This is acceptable
  for v1 because the database remains small (< 50 MB/year at this
  rate). Data retention, archiving, and VACUUM scheduling are deferred
  to a follow-up change or the companion ansible-role-ai maintenance
  scripts.
