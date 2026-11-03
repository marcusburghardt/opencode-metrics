# Spec Delta

## MODIFIED Requirements

### Requirement: Historical session backfill from OpenCode database

<!-- Previously: asserted that the script "reads all sessions from the source
database" with no era distinction, implying full historical coverage. -->

The project SHALL provide a `scripts/backfill.ts` script that reads historical
session data from OpenCode's legacy `session`, `message`, and `part` tables and
writes it into the opencode-metrics database using the same schema, derived
metrics, and classification logic as the live plugin. OpenCode stopped writing
those tables at the 2026-10-30 cutover; sessions created afterwards exist only
in `session_v2`, `session_message`, and `session_part` and SHALL NOT be
imported until a separate change adds V2 sources. The README and
`QUICK_START.md` SHALL state the cutoff so users do not read a successful
backfill as full coverage.

#### Scenario: Backfill imports all historical sessions

- **GIVEN** OpenCode's legacy database exists at the default path
  (~/.local/share/opencode/opencode.db) and contains session data up to the
  cutoff
- **WHEN** the user runs `make backfill`
- **THEN** the script SHALL read all sessions present in the legacy tables
- **AND** SHALL write session records, project records, and measurement
  records per session into the metrics database
- **AND** SHALL report the total count, total cost, and classification
  distribution

#### Scenario: V2-era sessions are not imported

- **GIVEN** OpenCode has recorded sessions after 2026-10-30 in `session_v2`
- **WHEN** the user runs `make backfill`
- **THEN** those sessions SHALL NOT be imported
- **AND** the documentation SHALL state that backfill does not cover them
- **AND** the user SHALL NOT be led to expect full historical coverage

#### Scenario: Backfill classifies sessions using full classifier

- **GIVEN** the source database contains sessions with messages and parts
- **WHEN** the backfill script processes a session
- **THEN** the script SHALL query the first user message text, tool call parts
  for bash commands, and message count
- **AND** SHALL run the same classification engine as the live plugin using the
  loaded config.yaml rules
- **AND** SHALL write the classification result to the session record

#### Scenario: Backfill computes derived metrics correctly

- **GIVEN** a session has tokens_cache_read=1000 and tokens_input=500
- **WHEN** the backfill script computes metrics
- **THEN** cache_hit_ratio SHALL be 1000/(1000+500) = 0.667
- **AND** duration_seconds SHALL be (time_updated-time_created)/1000
- **AND** files_changed SHALL use summary_files (default 0)
- **AND** lines_added/deleted SHALL use summary_additions/deletions

#### Scenario: Backfill handles zero-denominator cache ratio

- **GIVEN** a session has tokens_cache_read=0 and tokens_input=0
- **WHEN** the backfill script computes cache_hit_ratio
- **THEN** cache_hit_ratio SHALL be recorded as 0
