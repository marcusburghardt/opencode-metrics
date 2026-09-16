## Requirements

### Requirement: Installation Documentation

The README.md SHALL include a complete installation guide covering
the npm plugin installation method, verification steps, and
alternative installation via local files. The guide SHALL be
actionable by a user who has never used an OpenCode plugin before.

#### Scenario: New user installs the plugin

- **GIVEN** a user reads the installation section of README.md
- **WHEN** they follow the documented steps
- **THEN** they SHALL be able to install the plugin by adding it
  to their opencode.json plugin array
- **AND** verify the plugin loaded by checking OpenCode startup logs
- **AND** verify metrics.db was created in the data directory

### Requirement: Configuration Documentation

The README.md SHALL document every configurable field in config.yaml
with descriptions, types, default values, and examples. The guide
SHALL include worked examples showing how to add, modify, reorder,
and disable classification rules.

#### Scenario: User customizes classification rules

- **GIVEN** a user reads the configuration section of README.md
- **WHEN** they want to add a custom classification for their
  project-specific agent
- **THEN** the documentation SHALL provide a clear example showing
  the rule syntax, where to add it in config.yaml, and how rule
  ordering affects the result

### Requirement: Verification Documentation

The README.md SHALL include example sqlite3 queries that users can
run to verify the plugin is collecting metrics correctly and to
inspect their data. Queries SHALL cover: session count, daily cost,
classification distribution, and cache hit ratio.

#### Scenario: User verifies metrics collection

- **GIVEN** the plugin has been running for at least one session
- **WHEN** the user runs the documented sqlite3 verification queries
- **THEN** the queries SHALL return meaningful results confirming
  data is being collected
- **AND** the output format SHALL match what the documentation shows

### Requirement: Troubleshooting Documentation

The README.md SHALL document common issues, diagnostic commands, and
recovery procedures. Each documented issue SHALL include symptoms,
likely causes, and resolution steps.

#### Scenario: User encounters database locked error

- **GIVEN** a user sees "database is locked" in their OpenCode logs
- **WHEN** they consult the troubleshooting section
- **THEN** they SHALL find the specific error documented with
  explanation (concurrent write contention) and resolution steps
  (verify WAL mode, check for stale processes)

### Requirement: Metric Reference Documentation

The README.md SHALL include a complete metric reference table listing
all metrics with their metric_name, unit, description, and
recommended aggregation type, mirroring the metric_definitions table
contents. This enables users writing custom SQL queries to discover
and understand available metrics without querying the database
directly.

#### Scenario: User discovers available metrics

- **GIVEN** a user wants to write a custom SQL query against metrics.db
- **WHEN** they consult the metric reference section of README.md
- **THEN** they SHALL find a table listing all metrics with
  name, unit, human-readable description, and aggregation type
- **AND** the table SHALL match the contents of the metric_definitions
  table in the database

### Requirement: Upgrade and Uninstall Documentation

The README.md SHALL document how to upgrade the plugin to a new
version and how to uninstall it. The upgrade section SHALL explain
that existing data is preserved (schema uses IF NOT EXISTS, new
metrics are additive rows). The uninstall section SHALL document
removing the plugin from opencode.json and optionally cleaning up
the data directory.

#### Scenario: User upgrades the plugin

- **GIVEN** a user has an older version of the plugin installed
- **WHEN** they consult the upgrade section of README.md
- **THEN** they SHALL find instructions for updating the npm package
- **AND** SHALL find confirmation that existing metrics data is
  preserved across upgrades

#### Scenario: User uninstalls the plugin

- **GIVEN** a user wants to remove the plugin
- **WHEN** they consult the uninstall section of README.md
- **THEN** they SHALL find instructions for removing the entry from
  opencode.json
- **AND** SHALL find instructions for optionally deleting the data
  directory (~/.local/share/opencode-metrics/)

### Requirement: Grafana Integration Documentation

The README.md SHALL include a Grafana integration section with
example SQL queries mapped to common dashboard panel types. The
section SHALL reference the ansible-role-ai ephemeral Grafana
container as the recommended quickstart path and document manual
setup as an alternative.

#### Scenario: User sets up Grafana dashboard

- **GIVEN** a user has Grafana running with the frser-sqlite-datasource
  plugin
- **WHEN** they follow the Grafana integration section
- **THEN** they SHALL be able to configure a datasource pointing to
  metrics.db
- **AND** create panels using the documented example queries
- **AND** see time-series visualizations of their OpenCode usage
