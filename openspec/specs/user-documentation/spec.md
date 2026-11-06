## Purpose

Define the user-facing documentation required for installation, upgrades, verification, and troubleshooting.

## Requirements

### Requirement: Breaking Release Communication

The documentation SHALL communicate a breaking release before the user
upgrades. The upgrade section SHALL state, at minimum: the minimum supported
host version for the installed plugin version; which plugin release line
supports the previous host version; the last version that supports the
previous host; and how to pin or roll back. The GitHub Release body for a
breaking release SHALL contain a hand-reviewed upgrade section, not only
generated commit entries.

#### Scenario: User arrives from the previous release line

- **GIVEN** a user reads the upgrade section of README.md
- **WHEN** the current release requires a newer OpenCode host
- **THEN** the section SHALL state the required host version before any
  upgrade command
- **AND** SHALL name the last plugin version that supports their current host
- **AND** SHALL show how to pin to it

#### Scenario: Breaking release notes are published

- **GIVEN** a release containing a breaking change
- **WHEN** the GitHub Release is published
- **THEN** its body SHALL contain an upgrade section naming each user-visible
  behavior change
- **AND** SHALL NOT consist only of generated commit bullets

### Requirement: V1 to V2 Migration Documentation

The documentation SHALL include a migration guide for users moving from the
V1 plugin line to the V2 plugin line. The guide SHALL state its audience,
prerequisites, ordered steps, verification, and rollback.

#### Scenario: Existing V1 user migrates

- **GIVEN** a user has the V1 plugin line installed
- **WHEN** they follow the migration guide
- **THEN** it SHALL tell them to upgrade OpenCode first
- **AND** SHALL explain the loader change (default export; a loader file, or a
  directory containing `index.ts`)
- **AND** SHALL tell them how to verify collection after migrating
- **AND** SHALL tell them how to roll back

### Requirement: Installation Documentation


The README.md SHALL include a complete installation guide covering the npm
plugin installation method, verification steps, and alternative installation
via a local default-export loader **file**. A directory containing `index.ts`
with a default export SHALL also be accepted. The guide SHALL state the
minimum supported OpenCode version for the current release line. The guide
SHALL be actionable by a user who has never used an OpenCode plugin before. A
local installation SHALL explain that runtime dependencies must be resolvable
(a `bun install` or equivalent), because the plugin's OpenCode API package is
a runtime dependency.

#### Scenario: New user installs the plugin

- **GIVEN** a user reads the installation section of README.md
- **WHEN** they follow the documented steps
- **THEN** they SHALL be able to install the plugin by adding it to their
  `opencode.json` `plugins` array
- **AND** verify the plugin loaded
- **AND** verify metrics.db was created in the data directory

#### Scenario: Local loader install

- **GIVEN** a user installs from a local checkout
- **WHEN** they follow the documented steps
- **THEN** the guide SHALL require installing runtime dependencies before
  building
- **AND** SHALL show the default-export loader file the install writes
  (`~/.config/opencode/plugins/opencode-metrics.ts`)
- **AND** MAY note that a directory containing `index.ts` is also accepted

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


The README.md SHALL include example sqlite3 queries that users can run to
verify the plugin is collecting metrics correctly and to inspect their data.
Queries SHALL cover: session count, daily cost, classification distribution,
and cache hit ratio. Verification SHALL lead with a database query whose
success does not depend on log capture, and MAY additionally describe the
plugin's log line at its confirmed location.

#### Scenario: User verifies metrics collection

- **GIVEN** the plugin has been running for at least one session
- **WHEN** the user runs the documented sqlite3 verification queries
- **THEN** the queries SHALL return meaningful results confirming data is
  being collected
- **AND** the output format SHALL match what the documentation shows

#### Scenario: Log capture differs from expectation

- **GIVEN** the plugin is collecting metrics but no plugin log line is present
  where the documentation says it should be
- **WHEN** the user follows the verification section
- **THEN** they SHALL still be able to confirm collection from the database
- **AND** the troubleshooting section SHALL explain the log-capture caveat

### Requirement: Troubleshooting Documentation


The README.md SHALL document common issues, diagnostic commands, and recovery
procedures. Each documented issue SHALL include symptoms, likely causes, and
resolution steps. The documented issues SHALL include the failure modes this
migration introduces: plugin loaded on an unsupported host, loader present but
not registering, plugin collecting nothing after an upgrade, and console log
lines not appearing where expected.

#### Scenario: User encounters database locked error

- **GIVEN** a user sees "database is locked" in their OpenCode logs
- **WHEN** they consult the troubleshooting section
- **THEN** they SHALL find the specific error documented with explanation
  (concurrent write contention) and resolution steps (verify WAL mode, check
  for stale processes)

#### Scenario: Plugin collects nothing after upgrade

- **GIVEN** a user upgraded the plugin and their host
- **WHEN** no new sessions appear in metrics.db
- **THEN** the troubleshooting section SHALL describe how to check the host
  version, the resolved plugin version, and the loader export shape

### Requirement: Metric Reference Documentation


The README.md SHALL include a complete metric reference table listing all
metrics with their metric_name, unit, description, and recommended aggregation
type, mirroring the metric_definitions table contents. Where a metric is
recorded as a constant (for example line counts on OpenCode V2), the table
SHALL state the limitation inline so a user writing custom SQL is not
surprised by zeros.

#### Scenario: User discovers available metrics

- **GIVEN** a user wants to write a custom SQL query against metrics.db
- **WHEN** they consult the metric reference section of README.md
- **THEN** they SHALL find a table listing all metrics with name, unit,
  human-readable description, and aggregation type
- **AND** the table SHALL match the contents of the metric_definitions table
  in the database

#### Scenario: User reads a known-limitation metric

- **GIVEN** the plugin records line counts as 0
- **WHEN** the user reads the `lines_added` row in the metric reference
- **THEN** the row SHALL state the limitation and the reason

### Requirement: Upgrade and Uninstall Documentation


The README.md SHALL document how to upgrade the plugin to a new version and
how to uninstall it. The upgrade section SHALL distinguish same-line upgrades
(data preserved; schema uses IF NOT EXISTS, new metrics are additive rows)
from cross-line upgrades that require a host version change. The uninstall
section SHALL document removing the plugin from `opencode.json` and optionally
cleaning up the data directory. Uninstall SHALL also cover removing a locally
installed loader directory.

#### Scenario: User upgrades the plugin

- **GIVEN** a user has an older version of the plugin installed
- **WHEN** they consult the upgrade section of README.md
- **THEN** they SHALL find instructions for updating the package
- **AND** SHALL find confirmation that existing metrics data is preserved
  within the same release line

#### Scenario: User upgrades across a breaking line

- **GIVEN** a user on the V1 plugin line consults the upgrade section
- **WHEN** they read the instructions
- **THEN** they SHALL be told the host version requirement first
- **AND** SHALL be told how to stay on the previous line
- **AND** SHALL be told what behavior changes and what stops being populated

#### Scenario: User uninstalls the plugin

- **GIVEN** a user wants to remove the plugin
- **WHEN** they consult the uninstall section of README.md
- **THEN** they SHALL find instructions for removing the entry from
  `opencode.json`
- **AND** SHALL find instructions for removing any locally installed loader
- **AND** SHALL find instructions for optionally deleting the data directory
  (~/.local/share/opencode-metrics/)

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
