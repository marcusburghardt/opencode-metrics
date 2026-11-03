## MODIFIED Requirements

### Requirement: Historical session backfill from OpenCode database

The project SHALL provide a `scripts/backfill.ts` script that reads
historical session data from OpenCode's internal database and writes
it into the opencode-metrics database using the same schema, derived
metrics, and classification logic as the live plugin. The script SHALL
support both the legacy OpenCode V1 layout (`session`, `message`,
`part`) and the OpenCode V2 layout (`session_v2`, `session_message`,
`session_part`).

When reading the V2 layout, the script SHALL:

- read session aggregates (`cost`, `tokens_input`, `tokens_output`,
  `tokens_reasoning`, `tokens_cache_read`, `tokens_cache_write`,
  `agent`, `model`, `title`, `time_created`, `time_updated`) from
  `session_v2`
- read messages from `session_message`, decoding the JSON `data`
  column into the intermediate message shape used by the extractor
- read message parts from `session_part`, keyed by `message_id` and
  ordered by `ordinal`, decoding the JSON `data` column

#### Scenario: Backfill imports all historical sessions

- **GIVEN** OpenCode's internal database exists at the default path
  (~/.local/share/opencode/opencode.db) and contains session data
- **WHEN** the user runs `make backfill`
- **THEN** the script SHALL read all sessions from the source database
- **AND** SHALL write session records, project records, and
  measurement records per session into the metrics database
- **AND** SHALL report the total count, total cost, and classification
  distribution

#### Scenario: Backfill classifies sessions using full classifier

- **GIVEN** the source database contains sessions with messages and
  parts
- **WHEN** the backfill script processes a session
- **THEN** the script SHALL query the first user message text, tool
  call parts for bash commands, and message count
- **AND** SHALL run the same classification engine as the live plugin
  using the loaded config.yaml rules
- **AND** SHALL write the classification result to the session record

#### Scenario: Backfill computes derived metrics correctly

- **GIVEN** a session has tokens_cache_read=1000 and tokens_input=500
- **WHEN** the backfill script computes metrics
- **THEN** cache_hit_ratio SHALL be 1000/(1000+500) = 0.667
- **AND** duration_seconds SHALL be (time_updated-time_created)/1000
- **AND** files_changed SHALL use summary_files (default 0)
- **AND** lines_added/deleted SHALL use summary_additions/deletions
- **AND** each summary value SHALL default to 0 when it is NULL,
  missing, or unavailable in the detected layout

#### Scenario: Backfill handles zero-denominator cache ratio

- **GIVEN** a session has tokens_cache_read=0 and tokens_input=0
- **WHEN** the backfill script computes cache_hit_ratio
- **THEN** cache_hit_ratio SHALL be recorded as 0

#### Scenario: Backfill imports sessions from the V2 layout

- **GIVEN** the source database contains `session_v2`,
  `session_message`, and `session_part`
- **AND** those tables contain sessions that do not exist in the legacy
  `session` table
- **WHEN** the user runs `make backfill`
- **THEN** the script SHALL import every session from `session_v2`
- **AND** SHALL extract first user message text, bash commands, and
  message count from the V2 message and part rows
- **AND** SHALL write the same session, project, measurement, and
  artifact records as the live plugin

#### Scenario: Backfill imports sessions from the legacy layout

- **GIVEN** the source database predates OpenCode V2 and has no
  `session_v2` table
- **WHEN** the user runs `make backfill`
- **THEN** the script SHALL read from the legacy `session`, `message`,
  and `part` tables
- **AND** SHALL produce the same results as before this change

## ADDED Requirements

### Requirement: Source schema detection

The backfill script SHALL detect which OpenCode source layout the
database uses before reading any rows. It SHALL select the V2 layout
when the `session_v2`, `session_message`, and `session_part` tables are
all present, and the legacy layout otherwise. The detected layout SHALL
be reported in the startup output and in the completion summary.

#### Scenario: V2 layout detected

- **GIVEN** the source database contains `session_v2`,
  `session_message`, and `session_part`
- **WHEN** the script starts
- **THEN** it SHALL report the detected layout as V2
- **AND** SHALL read from the V2 tables

#### Scenario: Legacy layout detected

- **GIVEN** the source database contains `session`, `message`, and
  `part` but no `session_v2`
- **WHEN** the script starts
- **THEN** it SHALL report the detected layout as legacy
- **AND** SHALL read from the legacy tables

#### Scenario: Ambiguous layout rejected

- **GIVEN** the source database contains `session_v2` but is missing
  `session_message` or `session_part`
- **WHEN** the script starts
- **THEN** it SHALL exit with a clear error naming the missing tables
- **AND** SHALL NOT write to the destination database

### Requirement: V2 diff summary limitation is reported, not fabricated

The backfill script SHALL use `session_v2.summary_files`,
`summary_additions`, and `summary_deletions` when present. When those
columns are NULL or zero for a V2-era session, the script SHALL record
`files_changed`, `lines_added`, and `lines_deleted` as 0 and SHALL NOT
derive or fabricate substitute values.

#### Scenario: V2 session without diff summary

- **GIVEN** a session in `session_v2` has NULL `summary_files`,
  `summary_additions`, and `summary_deletions`
- **WHEN** the backfill imports that session
- **THEN** `files_changed`, `lines_added`, and `lines_deleted` SHALL be
  recorded as 0
- **AND** the remaining metrics SHALL be imported normally
- **AND** the summary SHALL report how many imported sessions lacked
  diff summary data
