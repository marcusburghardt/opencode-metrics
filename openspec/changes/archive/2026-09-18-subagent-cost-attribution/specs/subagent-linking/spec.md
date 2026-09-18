## ADDED Requirements

### Requirement: Parent-Child Session Linking

The plugin SHALL store the parent session identifier for every session
that was spawned as a sub-agent. The `parent_session_id` field SHALL
contain the session ID of the spawning parent, or NULL for root
sessions (sessions not spawned by another session). The value SHALL
be sourced from the SDK's `session.parentID` field.

#### Scenario: Sub-agent session records parent

- **GIVEN** a coordinator session spawns a divisor-sre sub-agent
- **WHEN** the sub-agent session transitions to idle
- **THEN** the sub-agent's session record SHALL contain the
  coordinator's session_id in `parent_session_id`

#### Scenario: Root session has NULL parent

- **GIVEN** a user starts a new interactive session directly
- **WHEN** the session transitions to idle
- **THEN** `parent_session_id` SHALL be NULL

#### Scenario: Multi-level nesting

- **GIVEN** a coordinator spawns a worker, which spawns a
  cobalt-crush sub-agent
- **WHEN** the cobalt-crush session transitions to idle
- **THEN** cobalt-crush's `parent_session_id` SHALL reference the
  worker's session_id
- **AND** the worker's `parent_session_id` SHALL reference the
  coordinator's session_id
- **AND** the coordinator's `parent_session_id` SHALL be NULL

### Requirement: Recursive Cost Aggregation via SQL

The database schema SHALL support recursive cost aggregation using
SQLite's WITH RECURSIVE common table expressions. No materialized
views or denormalized columns (e.g., `root_session_id`, `depth`)
SHALL be added; the single `parent_session_id` column with its
index SHALL be sufficient for all recursive queries.

#### Scenario: Total cost including all descendants

- **GIVEN** a root session with cost $0.50 and two sub-agents
  costing $1.20 and $0.80
- **WHEN** a recursive CTE walks the session tree from the root
- **THEN** the aggregated cost SHALL be $2.50

#### Scenario: Cost per sub-agent type

- **GIVEN** multiple sessions with various sub-agent types
- **WHEN** querying sessions WHERE parent_session_id IS NOT NULL
  grouped by agent
- **THEN** the result SHALL show cost totals per agent type

#### Scenario: Own cost vs fully-loaded cost

- **GIVEN** a root session with direct cost $0.50 and sub-agent
  costs totaling $2.00
- **WHEN** comparing the root's own measurement value to the
  recursive SUM
- **THEN** the own cost SHALL be $0.50 and the fully-loaded cost
  SHALL be $2.50

### Requirement: Deterministic Sub-Agent Detection

Sub-agent detection SHALL be deterministic and automatic based solely
on the presence of a non-NULL `parent_session_id` value. No
classification rules, configuration, or pattern matching SHALL be
required to determine whether a session is a sub-agent.

#### Scenario: Any agent type detected as sub-agent

- **GIVEN** a session with agent "custom-reviewer" and a non-NULL
  parent_session_id
- **WHEN** querying for sub-agent sessions
- **THEN** the session SHALL be identifiable as a sub-agent via
  `parent_session_id IS NOT NULL`
- **AND** detection SHALL NOT depend on agent name patterns

### Requirement: Backfill Safety

Existing sessions in databases created before this change SHALL have
`parent_session_id = NULL` after migration. This is semantically
correct for root sessions and benign for historical sub-agent sessions
whose parent information was never captured. The migration SHALL NOT
attempt to retroactively reconstruct parent-child relationships.

#### Scenario: Existing database upgraded to V4

- **GIVEN** a metrics.db at schema version 3 with 500 sessions
- **WHEN** the plugin starts with the V4 schema
- **THEN** all 500 existing sessions SHALL have
  parent_session_id = NULL
- **AND** all existing data SHALL remain intact and queryable
- **AND** no errors SHALL be logged during migration
