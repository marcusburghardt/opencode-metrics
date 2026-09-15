<!--
  All tasks are sequential -- no [P] markers.
  The script is a single file with supporting changes to Makefile
  and README.
-->

## 1. Create Backfill Script

- [x] 1.1 Create `scripts/backfill.ts` with SPDX header and shebang
  (`#!/usr/bin/env bun`). Import Database from bun:sqlite, classify
  from src/classifier.ts, loadConfig from src/config.ts, initDatabase
  and getDataDir from src/db.ts, upsertProject, upsertSession, and
  writeMetrics from src/writer.ts, computeCacheHitRatio and
  computeDurationSeconds from src/extractor.ts.
- [x] 1.2 Implement CLI argument parsing: `--source <path>` (default:
  auto-detect ~/.local/share/opencode/opencode.db), `--dest <path>`
  (default: auto-detect via getDataDir()), `--dry-run` (print stats
  without writing), `--help` (usage instructions). Use simple
  process.argv parsing -- no external CLI library. After resolving
  both paths, canonicalize them (resolve symlinks) and exit with a
  clear error if source and destination refer to the same file.
- [x] 1.3 Implement source database validation: open with
  `{ readonly: true }`, verify the session, message, part, and project
  tables exist by querying sqlite_master. Exit with a clear error if
  tables are missing.
- [x] 1.4 Implement destination database initialization: if the metrics
  database does not exist, call initDatabase() to create it with the
  full schema and metric definitions. If it exists, open it normally.
- [x] 1.5 Implement project backfill: query all projects from the
  source, upsert each into the destination using upsertProject().
  Use the project name if present, otherwise derive from the worktree
  path basename.
- [x] 1.6 Implement session backfill loop: query all sessions from the
  source in batches of 100 (ORDER BY time_created ASC). For each
  session:
  (a) Extract model ID from the JSON model column using
  json_extract(model, '$.id'),
  (b) Count messages from the message table,
  (c) Query the first user message text from the message table
  (role='user', ORDER BY time_created ASC LIMIT 1, extract from
  data JSON),
  (d) Query tool-call parts for bash commands (part.data type='tool',
  tool name contains 'bash' or 'shell'),
  (e) Concatenate text part content for classification context,
  (f) Build ClassificationContext and run classify(),
  (g) Build the session record and 12 measurement records,
  (h) Write using upsertSession() and writeMetrics() inside a
  transaction.
- [x] 1.7 Use imported computeCacheHitRatio() and
  computeDurationSeconds() from src/extractor.ts for derived metrics.
  For remaining metrics: files_changed = summary_files or 0,
  lines_added = summary_additions or 0,
  lines_deleted = summary_deletions or 0.
  In dry-run mode, skip steps 1.4 through 1.6h (destination
  initialization and all writes). Open the source database and
  compute all statistics and classifications, but do not open or
  create the destination database.
- [x] 1.8 Implement progress reporting: print the resolved source and
  destination paths at startup, print progress every 100 sessions
  (e.g., "Processed 200/899 sessions..."), print a summary at the end
  with total sessions, total cost, classification distribution, and
  elapsed time.

## 2. Add Makefile Target

- [x] 2.1 Add `backfill` target to Makefile that runs
  `bun run scripts/backfill.ts`. Add `backfill` to the `.PHONY`
  declaration. Add a comment documenting what it does.

## 3. Write Tests

- [x] 3.1 Create `scripts/backfill.test.ts` with tests covering all
  spec scenarios. Use temporary databases in temp directories with
  a minimal config.yaml fixture containing 2-3 known classification
  rules. Tests:
  (a) Derived metric wiring: verify computeCacheHitRatio and
  computeDurationSeconds are called with correct source columns,
  verify null summary_files/additions/deletions default to 0,
  (b) Model extraction from JSON column (valid JSON, null model,
  malformed JSON),
  (c) Classification context building: use config fixture with known
  rules, assert sessions matching those rules are classified
  correctly in the destination database,
  (d) Dry-run mode: verify statistics are printed but no destination
  database is created or written to,
  (e) Idempotency: run twice, verify no duplicate rows and identical
  counts,
  (f) Source database validation failure: create empty SQLite database
  (no tables), pass as source, assert non-zero exit and clear error
  naming missing tables, no writes to destination,
  (g) Source database not found: pass non-existent path, assert error
  with --source hint,
  (h) Read-only source enforcement: verify source opened with
  readonly flag,
  (i) Auto-initialization of destination: no prior metrics.db, verify
  database created with full schema and metric definitions,
  (j) End-to-end backfill flow: source with N sessions, verify N
  session records and N x 12 measurement rows in destination,
  (k) CLI argument parsing: --source and --dest override paths,
  --source without value produces error, --help prints usage without
  DB operations,
  (l) Project name fallback: project with name uses name, project
  with null name uses worktree basename, project with null name and
  null worktree uses sensible default,
  (m) Batch boundary: source with 150 sessions, verify all 150
  imported correctly across batch boundaries,
  (n) Same-file protection: source and dest resolve to same path,
  assert error exit before any writes.
  Use toBeCloseTo() for floating-point assertions on cache_hit_ratio.

## 4. Update Documentation

- [x] 4.1 Add a "Historical Data Backfill" section to README.md after
  the "Installation" section, covering:
  (a) What it does (one-time import from OpenCode's internal database),
  (b) Prerequisites (opencode-metrics plugin initialized, or first run
  will initialize automatically),
  (c) Usage: `make backfill` (or `bun run scripts/backfill.ts`),
  (d) CLI flags: --source, --dest, --dry-run, --help,
  (e) What gets imported (sessions, projects, all 12 metrics,
  classification),
  (f) How to verify: example sqlite3 query showing imported session
  count and total cost,
  (g) Note that the script is idempotent and safe to run multiple
  times.
- [x] 4.2 Update the "How to Verify" section in README.md to reference
  the backfill as the quickstart path for existing users: "Run
  `make backfill` to import your existing session history, then
  verify with sqlite3 queries."

## 5. Update Spec

- [x] 5.1 Sync the delta spec from
  openspec/changes/backfill-script/specs/historical-backfill/spec.md
  to openspec/specs/historical-backfill/spec.md.

## 6. Verification

- [x] 6.1 Run `make test` to verify all tests pass (existing + new)
- [x] 6.2 Run `make lint` to verify no lint issues
- [x] 6.3 Run `bun run scripts/backfill.ts --dry-run` to verify the
  script runs without errors against the real OpenCode database (do
  not use `make backfill --dry-run` as make interprets --dry-run as
  its own flag)
- [x] 6.4 Run `make backfill` to perform the actual backfill, then
  verify with:
  `sqlite3 ~/.local/share/opencode-metrics/metrics.db
  "SELECT COUNT(*), SUM(value) FROM measurements
  WHERE metric_name='cost';"`

<!-- spec-review: passed -->
<!-- code-review: passed -->
