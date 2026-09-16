## Context

OpenCode stores session data in `~/.local/share/opencode/opencode.db`,
a SQLite database with 19 tables. The key tables for backfill are:

- `session`: One row per coding session with cost, token counts, agent,
  model (JSON), title, timestamps, and git diff summary stats. This
  table contains aggregated totals -- no need to sum from messages.
- `message`: Individual messages within a session. Needed for message
  counts and for extracting classification signals (first user message
  text, tool call content).
- `part`: Sub-parts of messages. Needed for extracting bash commands
  and text content used by the classification engine.
- `project`: Repository/project registry with worktree paths.

The opencode-metrics database stores data in a dimensional schema:
sessions (dimensions), measurements (facts keyed by session_id +
metric_name), projects, and metric_definitions. The backfill script
maps from the source schema to the destination schema.

## Goals / Non-Goals

**Goals:**

- Import all historical sessions from OpenCode's database into the
  metrics database with full classification
- Use the same classification logic as the live plugin (same rules,
  same engine) for consistency between historical and future data
- Be idempotent -- safe to run multiple times without duplicating data
- Complete in under 60 seconds for ~1000 sessions
- Require zero configuration -- auto-detect database paths using the
  same XDG conventions as the plugin
- Provide clear progress output and a summary report

**Non-Goals:**

- Real-time sync or continuous backfill -- this is a one-time import
- Modifying OpenCode's internal database in any way
- Backfilling from non-default OpenCode data directories (users with
  custom OPENCODE_DATA_DIR can pass a flag)
- Importing data from other tools or formats

## Decisions

### Decision 1: Full classifier for historical sessions

**Choice**: Run the full classification engine (with message/part
queries for each session) rather than agent-only heuristics.

**Rationale**: The PR review, PR creation, and OpenSpec workflow
classifications are the most analytically interesting categories for
cost analysis. Agent-only classification would correctly identify
~80% of sessions (exploration, planning, implementation, multi-agent)
but would miss these high-value categories. The performance cost is
acceptable: ~900 sessions with selective message/part queries completes
in under 30 seconds on local SQLite.

**Alternatives considered**:
- *Agent-only classification*: Faster but misses PR and OpenSpec
  categories. These are the categories users most want to see in
  cost breakdowns.
- *Skip classification entirely*: Would make the backfilled data
  less useful than live data. Inconsistency between historical and
  future session classifications would confuse users.

### Decision 2: Direct SQLite access, not the SDK

**Choice**: Read OpenCode's database directly via bun:sqlite rather
than the OpenCode SDK client.

**Rationale**: The SDK client is only available inside a running
OpenCode plugin context. The backfill script runs standalone from the
command line. Direct SQLite access is the only option for a standalone
script. The database schema is stable and well-documented (Drizzle ORM
migrations in OpenCode's source).

### Decision 3: Import the existing classifier module

**Choice**: Import `classify` and `ClassificationCache` from `src/classifier.ts`
and `loadConfig` from `src/config.ts` rather than reimplementing.

**Rationale**: Ensures classification consistency between backfilled
and live data. Uses the same config.yaml rules. Avoids code duplication.
The classifier is a pure function with no OpenCode SDK dependencies.

### Decision 4: Batch processing with transaction wrapping

**Choice**: Process sessions in batches of 100, each wrapped in a
database transaction. Display progress after each batch.

**Rationale**: Transactions amortize SQLite's fsync overhead (100x
fewer fsyncs than per-session commits). Batch size of 100 balances
memory usage against transaction overhead. Progress output gives the
user confidence the script is working for large histories.

### Decision 5: Source database opened read-only

**Choice**: Open OpenCode's database with `{ readonly: true }` to
prevent any accidental writes.

**Rationale**: The source database is OpenCode's authoritative data
store. Even though the script only runs SELECT queries, opening in
read-only mode is a defense-in-depth measure. It also avoids creating
WAL checkpoint contention with a running OpenCode instance.

### Decision 6: Auto-detect paths with override flags

**Choice**: Auto-detect both database paths using XDG conventions,
with optional `--source` and `--dest` CLI flags for override.

**Rationale**: Most users have default paths. Users with custom
configurations (e.g., XDG_DATA_HOME overrides) can pass flags.
The script prints the resolved paths at startup for transparency.

### Decision 7: Coverage strategy

The backfill script (`scripts/backfill.ts`) is subject to the
project-wide 80% minimum line coverage target enforced by `make test`.
Tests in `scripts/backfill.test.ts` are classified as:

- **Unit tests**: Derived metric wiring, model extraction from JSON,
  CLI argument parsing, project name fallback, source database
  validation, batch boundary behavior.
- **Integration tests**: End-to-end backfill flow (source with N
  sessions → verify N sessions + N×12 measurements in destination),
  idempotency (run twice, no duplicates), dry-run mode, auto-init
  of destination database.

The existing `bun test --coverage` command and Makefile ratchet apply
to the `scripts/` directory. All tests use in-memory or temp-directory
SQLite databases — no external services required.

### Decision 8: Reuse derived metric functions from extractor.ts

Import `computeCacheHitRatio()` and `computeDurationSeconds()` from
`src/extractor.ts` rather than reimplementing the formulas. These are
pure functions with no SDK dependencies — they accept plain numbers and
return numbers. Reuse ensures formula consistency between backfilled
and live data, and avoids maintaining duplicate logic with duplicate
test coverage.

### Decision 9: Batch transactions bypass writeSessionData()

The existing `writeSessionData()` in `src/writer.ts` wraps a single
session in a transaction with `withRetry()` for SQLITE_BUSY handling.
For batch processing, the backfill script uses the lower-level
`upsertProject()`, `upsertSession()`, and `writeMetrics()` functions
directly inside a batch transaction of 100 sessions to amortize fsync
overhead. The `withRetry()` wrapper is omitted because the backfill
script is the sole writer during execution, eliminating SQLITE_BUSY
contention on the destination database. Users should avoid running
the backfill while the live plugin is actively writing (documented in
README).

## Risks / Trade-offs

- **Risk**: OpenCode's schema may change in future versions, breaking
  the backfill queries. **Mitigation**: The script uses only stable,
  core tables (session, message, part, project) that have been present
  since OpenCode's initial release. Schema changes are detectable via
  missing columns (the script validates table structure on startup).
- **Risk**: Large message/part queries for classification may be slow
  for sessions with thousands of messages. **Mitigation**: The script
  queries only the first user message and tool-call parts per session,
  not all parts. This is O(1) per session for message content and
  bounded by the number of tool calls.
- **Trade-off**: The script requires the opencode-metrics database to
  already exist (initialized by the plugin on first run, or by
  `make build && bun run dist/index.js` in a test context). If the
  database doesn't exist, the script initializes it using the same
  `initDatabase()` function from `src/db.ts`.
