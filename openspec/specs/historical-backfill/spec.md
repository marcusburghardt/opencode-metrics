## Requirements

### Requirement: Historical session backfill from OpenCode database

The project SHALL provide a `scripts/backfill.ts` script that reads
historical session data from OpenCode's internal database and writes
it into the opencode-metrics database using the same schema, derived
metrics, and classification logic as the live plugin.

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

#### Scenario: Backfill handles zero-denominator cache ratio

- **GIVEN** a session has tokens_cache_read=0 and tokens_input=0
- **WHEN** the backfill script computes cache_hit_ratio
- **THEN** cache_hit_ratio SHALL be recorded as 0

### Requirement: Backfill is idempotent

The backfill script SHALL use INSERT ... ON CONFLICT DO UPDATE for all
writes, making it safe to run multiple times without creating duplicate
data.

#### Scenario: Running backfill twice produces identical results

- **GIVEN** the backfill has been run once successfully
- **WHEN** the user runs `make backfill` again
- **THEN** the session count in the metrics database SHALL remain the
  same
- **AND** no duplicate measurement rows SHALL exist
- **AND** the script SHALL complete without errors

### Requirement: Source database opened read-only

The backfill script SHALL open OpenCode's internal database in
read-only mode to prevent any accidental modification.

#### Scenario: Script cannot modify the source database

- **GIVEN** the backfill script is running
- **WHEN** it accesses OpenCode's internal database
- **THEN** the database connection SHALL be opened with readonly: true
- **AND** any attempt to write SHALL fail with a database error

### Requirement: Source and destination path validation

The backfill script SHALL resolve both paths to their canonical form
and SHALL exit with a clear error if the source and destination paths
refer to the same file.

#### Scenario: Same-file protection

- **GIVEN** the user passes --source and --dest that resolve to the
  same file
- **WHEN** the script starts
- **THEN** the script SHALL exit with a clear error before any
  database operations

### Requirement: Graceful handling of corrupted source data

The backfill script SHALL handle corrupted or unreadable rows in the
source database gracefully, logging a warning and skipping affected
sessions rather than aborting the entire backfill.

#### Scenario: Corrupted row in source database

- **GIVEN** the source database contains a session with corrupted or
  unreadable data
- **WHEN** the backfill script encounters a query error for that session
- **THEN** the script SHALL log a warning with the session ID and error
- **AND** SHALL skip that session and continue processing remaining
  sessions
- **AND** the summary report SHALL include a count of skipped sessions

### Requirement: Auto-detect database paths with override flags

The backfill script SHALL auto-detect both database paths using XDG
conventions and SHALL support --source and --dest CLI flags for
override.

#### Scenario: Default path auto-detection

- **GIVEN** OpenCode's database exists at ~/.local/share/opencode/opencode.db
- **AND** the metrics database exists at ~/.local/share/opencode-metrics/metrics.db
- **WHEN** the user runs `make backfill` without flags
- **THEN** the script SHALL detect and use both default paths
- **AND** SHALL print the resolved paths at startup

#### Scenario: Custom source path override

- **GIVEN** a user has OpenCode's database at a non-default location
- **WHEN** the user runs `bun run scripts/backfill.ts --source /custom/path/opencode.db`
- **THEN** the script SHALL use the specified path as the source

#### Scenario: Source database not found

- **GIVEN** no OpenCode database exists at the expected path
- **WHEN** the user runs `make backfill`
- **THEN** the script SHALL exit with a clear error message indicating
  the expected path and the --source flag for override

### Requirement: Dry-run mode

The backfill script SHALL support a --dry-run flag that reads and
analyzes the source database without writing to the destination.

#### Scenario: Dry-run reports statistics without writing

- **GIVEN** the source database contains sessions
- **WHEN** the user runs `bun run scripts/backfill.ts --dry-run`
- **THEN** the script SHALL print the session count, total cost,
  and classification distribution
- **AND** SHALL NOT open, create, or write to the destination database

### Requirement: Progress reporting

The backfill script SHALL print progress updates during processing
and a summary report at completion.

#### Scenario: Progress updates during processing

- **GIVEN** the source database contains 500+ sessions
- **WHEN** the backfill is running
- **THEN** the script SHALL print progress every 100 sessions

#### Scenario: Summary report at completion

- **WHEN** the backfill completes
- **THEN** the script SHALL print: total sessions processed, total
  cost imported, classification distribution (count per category),
  and elapsed time

### Requirement: Destination database auto-initialization

If the metrics database does not exist when the backfill script runs,
the script SHALL initialize it using the same initDatabase() function
as the live plugin, creating the full schema and metric definitions.

#### Scenario: First-time backfill without prior plugin run

- **GIVEN** the opencode-metrics plugin has never run (no metrics.db)
- **WHEN** the user runs `make backfill`
- **THEN** the script SHALL create the data directory and database
- **AND** SHALL initialize the schema and metric definitions
- **AND** SHALL proceed with the backfill normally
