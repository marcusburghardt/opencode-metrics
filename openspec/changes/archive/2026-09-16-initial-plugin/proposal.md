## Why

OpenCode users have no visibility into their spending patterns, session
efficiency, or usage trends. The only option today is ad-hoc SQL queries
against the internal opencode.db database, which requires knowledge of
the undocumented schema and produces no persistent, queryable metrics
store.

Users need to answer questions like: How much do I spend per day? What
is my average cost per session? Which types of work cost the most? Are
my cache hit ratios improving over time? None of these are answerable
without manual effort today.

## What Changes

- An OpenCode plugin (TypeScript) that subscribes to session.status
  events and automatically collects metrics into a local SQLite database
- A dimensional database schema (sessions, projects, measurements,
  metric_definitions) designed for flexibility -- new metrics require
  zero schema changes
- Config-driven session classification using ordered YAML rules (regex,
  value matching, exclusions) so users can tune classification without
  changing code
- Default classification rules covering: PR review, PR creation,
  OpenSpec workflow, exploration, planning, implementation, multi-agent,
  and ad-hoc sessions
- First-run initialization that creates the data directory, database,
  and default configuration automatically
- Concurrent-write safety via SQLite WAL mode, busy_timeout, and retry
  logic for multi-instance OpenCode usage
- Comprehensive user documentation: installation, configuration,
  testing, and troubleshooting guides

## Capabilities

### New Capabilities

- `metrics-collection`: Automatic session metrics capture on every
  session idle event via the OpenCode plugin event system
- `metrics-storage`: Dimensional SQLite database for time-series metrics
  with a self-describing metric catalog
- `session-classification`: Config-driven rule engine that classifies
  sessions by type (PR review, implementation, exploration, etc.)
- `user-documentation`: Installation, configuration, testing, and
  troubleshooting guides for end users

### Modified Capabilities

(none)

### Removed Capabilities

(none)

## Impact

- New npm package published as `opencode-metrics`
- Users install by adding the package name to their opencode.json
  plugin array -- no other configuration required for basic usage
- Creates ~/.local/share/opencode-metrics/ directory with metrics.db
  and config.yaml on first run
- Zero impact on OpenCode's internal database (read-only access via SDK
  only)
- Designed to work alongside companion components in ansible-role-ai
  (Grafana dashboards, Python maintenance scripts) but fully functional
  standalone

## Constitution Alignment

Assessed against the Unbound Force org constitution.

### I. Autonomous Collaboration

**Assessment**: PASS

The plugin produces self-describing artifacts: metrics.db is a
standalone SQLite database with a metric_definitions catalog table
that documents every metric's name, unit, description, and aggregation
type. Any consumer (Grafana, Python scripts, sqlite3 CLI) can interpret
the data without consulting the plugin. The events.jsonl append log (if
adopted in the future) follows the same principle. The plugin operates
asynchronously via event hooks -- no synchronous coupling with other
agents or tools.

### II. Composability First

**Assessment**: PASS

The plugin is independently installable via npm and delivers its core
value (metrics collection into SQLite) when deployed alone, with no
other agent required. It exposes a well-defined extension point via
config.yaml for classification rules. Companion components
(ansible-role-ai's Grafana container and collector scripts) provide
additive value without being prerequisites. The plugin auto-detects
its own data directory and initializes on first run without manual
configuration.

### III. Observable Quality

**Assessment**: PASS

All output is machine-parseable: metrics.db is queryable SQL, and
config.yaml is structured YAML. The metric_definitions table serves as
a self-describing catalog. The dimensional model (measurements fact
table with metric_name + value rows) ensures output format stability
across versions -- new metrics add rows, not columns, so downstream
tooling never breaks. Provenance is tracked per session record
(session_id, timestamps, model, agent).

### IV. Testability

**Assessment**: PASS

Every module (db, writer, classifier, extractor, config) is designed
for isolated testing with no external services required. The SDK
client is injected via the plugin context, enabling mock-based tests.
SQLite operations use in-memory databases for unit tests. The
classification engine is a pure function from (rules, session_context)
to classification label. Coverage strategy is defined in the tasks:
unit tests per module, integration test for the full event-to-database
flow.

### V. Security by Default

**Assessment**: PASS

The plugin reads session data via the supported SDK API, never writing
to OpenCode's internal database. The metrics.db file is created with
default restrictive permissions. Config.yaml is read-only from the
plugin's perspective. No external network calls are made. Dependencies
are minimized: bun:sqlite is built-in, and the only external dependency
is a YAML parser (justified by the config file requirement). No secrets
are stored or transmitted.
