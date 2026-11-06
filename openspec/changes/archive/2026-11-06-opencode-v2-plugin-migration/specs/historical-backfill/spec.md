# Spec Delta

## MODIFIED Requirements

### Requirement: Historical session backfill from OpenCode database

The project SHALL provide a `scripts/backfill.ts` script that reads historical
session data from OpenCode's internal database and writes it into the
opencode-metrics database using the same schema, derived metrics, and
classification logic as the live plugin. The script SHALL support both the
legacy OpenCode V1 layout (`session`, `message`, `part`) and the OpenCode V2
layout (`session_v2`, `session_message`, `session_part`).

When reading the V2 layout, the script SHALL:

- read session aggregates (`cost`, `tokens_input`, `tokens_output`,
  `tokens_reasoning`, `tokens_cache_read`, `tokens_cache_write`, `agent`,
  `model`, `parent_id`, `title`, `time_created`, `time_updated`) from
  `session_v2`
- read `user` and `assistant` messages from `session_message`, decoding the
  JSON `data` column into the intermediate message shape used by the
  extractor, and ignore control message types
- read message parts from `session_part` when rows exist, keyed by
  `message_id` and ordered by `ordinal`, decoding the JSON `data` column;
  when a message has no `session_part` rows, decode the content embedded in
  `session_message.data` (OpenCode 2.2.5 stores user text and assistant
  content inline)

The README and `QUICK_START.md` SHALL state which layouts are supported so
users do not read a successful backfill as full coverage.

#### Scenario: Backfill imports all historical sessions

- **GIVEN** OpenCode's internal database exists at the default path
  (~/.local/share/opencode/opencode.db) and contains session data
- **WHEN** the user runs `make backfill`
- **THEN** the script SHALL read all sessions from the detected source layout
- **AND** SHALL write session records, project records, and measurement
  records per session into the metrics database
- **AND** SHALL report the total count, total cost, and classification
  distribution

#### Scenario: Backfill imports sessions from the V2 layout

- **GIVEN** the source database contains `session_v2`, `session_message`, and
  `session_part`
- **AND** those tables contain sessions that do not exist in the legacy
  `session` table
- **WHEN** the user runs `make backfill`
- **THEN** the script SHALL import every session from `session_v2`
- **AND** SHALL extract first user message text, bash commands, and message
  count from the V2 message and part rows
- **AND** SHALL write the same session, project, measurement, and artifact
  records as the live plugin

#### Scenario: Backfill imports sessions from the legacy layout

- **GIVEN** the source database predates OpenCode V2 and has no `session_v2`
  table
- **WHEN** the user runs `make backfill`
- **THEN** the script SHALL read from the legacy `session`, `message`, and
  `part` tables
- **AND** SHALL produce the same results as before this change

#### Scenario: V2 content is read from embedded message data

- **GIVEN** the source database has `session_message` rows but no
  `session_part` rows for those messages
- **WHEN** the backfill imports a session
- **THEN** it SHALL read user text from `session_message.data.text`
- **AND** SHALL read assistant text and tool entries from
  `session_message.data.content`
- **AND** SHALL NOT treat the session as empty solely because `session_part`
  is empty

#### Scenario: Backfill preserves V2 parent session links

- **GIVEN** a `session_v2` row has `parent_id = "ses-parent"`
- **WHEN** the backfill imports that session
- **THEN** the stored session record SHALL have
  `parent_session_id = "ses-parent"`
- **AND** a `session_v2` row with `parent_id = NULL` SHALL store NULL

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
- **AND** each summary value SHALL default to 0 when it is NULL, missing, or
  unavailable in the detected layout

#### Scenario: Backfill handles zero-denominator cache ratio

- **GIVEN** a session has tokens_cache_read=0 and tokens_input=0
- **WHEN** the backfill script computes cache_hit_ratio
- **THEN** cache_hit_ratio SHALL be recorded as 0
