## MODIFIED Requirements

### Requirement: Sessions Table Schema

The sessions table SHALL include the columns: session_id (TEXT PK),
project_id (TEXT), agent (TEXT), model (TEXT), classification (TEXT),
budget_tag (TEXT, nullable), parent_session_id (TEXT, nullable),
title (TEXT), started_at (INTEGER), ended_at (INTEGER),
metadata (TEXT).

Previously: The sessions table did not include parent_session_id.

#### Scenario: Existing database migrated to version 4

- **GIVEN** a metrics.db at schema version 3
- **WHEN** the plugin starts
- **THEN** the sessions table SHALL gain a parent_session_id column
- **AND** a secondary index idx_sessions_parent SHALL be created on
  parent_session_id
- **AND** existing rows SHALL have parent_session_id = NULL
- **AND** PRAGMA user_version SHALL be set to 4

#### Scenario: Session record includes parent_session_id

- **GIVEN** a sub-agent session with parentID "sess-parent-abc"
- **WHEN** the session record is upserted
- **THEN** the parent_session_id column SHALL contain
  "sess-parent-abc"

### Requirement: Convenience Views

The v_sessions convenience view SHALL expose parent_session_id
alongside all existing columns (session_id, project_id, agent,
model, classification, title, started_at_epoch, ended_at_epoch,
started_at_iso, ended_at_iso, metadata, budget_tag).

Previously: v_sessions did not include parent_session_id.

#### Scenario: Grafana query joins v_sessions with measurements

- **GIVEN** sessions with parent_session_id values stored
- **WHEN** a Grafana query joins v_sessions with v_measurements
  and filters on parent_session_id IS NOT NULL
- **THEN** the query SHALL return only sub-agent session metrics

## REMOVED Requirements

None.
