<!--
  [P] marks tasks eligible for parallel execution.
  Add [P] when a task: (a) touches different files from
  other [P] tasks in the group, (b) has no dependency
  on prior tasks in the group, (c) can safely execute
  without ordering constraints.
  Do NOT add [P] when tasks modify the same file —
  parallel workers will cause merge conflicts.
  Tasks without [P] run sequentially first, then [P]
  tasks run in parallel.

  All source files MUST include an SPDX license header:
  // SPDX-License-Identifier: Apache-2.0
-->

## 1. Project Foundation

- [x] 1.1 Initialize package.json with name (opencode-metrics), version
  (0.1.0), description, license (Apache-2.0), author, repository,
  keywords, and main/exports fields pointing to the build output
- [x] 1.2 [P] Configure TypeScript (tsconfig.json) targeting ESNext with
  Bun module resolution and strict mode enabled
- [x] 1.3 Create Makefile with targets: build, test, lint, clean
- [x] 1.4 [P] Add .gitignore for node_modules, dist, and build artifacts
- [x] 1.5 Add @opencode-ai/plugin as a dev dependency for type
  definitions
- [x] 1.6 Add yaml npm package as a runtime dependency for config.yaml
  parsing (justified: Bun has no built-in YAML parser; this is the
  sole external runtime dependency)
- [x] 1.7 Configure linter (Biome) with TypeScript support; add
  biome.json config and update Makefile lint target to invoke it
- [x] 1.8 Configure coverage reporting in Makefile test target using
  bun test --coverage with minimum 80% line coverage threshold;
  test target SHALL fail if coverage drops below threshold

## 2. Database Schema and Initialization

- [x] 2.1 Create src/db.ts module with initDatabase() function that
  creates the data directory ($XDG_DATA_HOME/opencode-metrics/,
  falling back to ~/.local/share/opencode-metrics/) with permissions
  0o755, and opens the SQLite database with WAL mode and
  busy_timeout=5000; database and config files SHALL be created with
  permissions 0o644
- [x] 2.2 Define the projects dimension table (project_id PK, name,
  worktree) using CREATE TABLE IF NOT EXISTS
- [x] 2.3 Define the sessions dimension table (session_id PK,
  project_id, agent, model, classification, title, started_at,
  ended_at, metadata JSON) using CREATE TABLE IF NOT EXISTS
- [x] 2.4 Define the metric_definitions catalog table (metric_name
  PK, unit, description, aggregation) using CREATE TABLE IF NOT EXISTS
- [x] 2.5 Define the measurements fact table (session_id + metric_name
  composite PK, value REAL, recorded_at INTEGER) with indexes on
  (recorded_at, metric_name) and (metric_name, recorded_at) using
  CREATE TABLE IF NOT EXISTS and CREATE INDEX IF NOT EXISTS
- [x] 2.6 Set PRAGMA user_version = 1 on initial database creation to
  track schema version; on startup, read user_version and apply any
  necessary migrations for older schemas
- [x] 2.7 Implement ensureMetricDefinitions() to seed the v1 metric
  catalog using INSERT OR IGNORE with descriptions from the V1 Metric
  Catalog table in the metrics-storage spec: cost, tokens_input,
  tokens_output, tokens_reasoning, tokens_cache_read,
  tokens_cache_write, cache_hit_ratio, duration_seconds,
  files_changed, lines_added, lines_deleted, messages_total
- [x] 2.8 Write tests for schema creation, idempotency (run
  initDatabase twice), WAL mode verification, user_version check,
  and file permission verification (directory 0o755, files 0o644)

## 3. Metrics Writer

- [x] 3.1 Create src/writer.ts module with upsertProject() that inserts
  or updates a project record from session data
- [x] 3.2 Implement upsertSession() that inserts or updates the session
  dimension record with all fields including classification
- [x] 3.3 Implement writeMetrics() that batch upserts measurement rows
  for all metrics of a session
- [x] 3.4 Implement withRetry() wrapper that retries SQLITE_BUSY errors
  up to 3 times with exponential backoff (100ms, 200ms, 400ms)
- [x] 3.5 Implement writeSessionData() that wraps upsertProject +
  upsertSession + writeMetrics in a single transaction for atomicity
- [x] 3.6 Write tests for upsert behavior (insert then update same
  session), transaction atomicity, and retry logic with simulated
  SQLITE_BUSY errors

## 4. Configuration Management

- [x] 4.1 Create src/config.ts module with TypeScript types for the
  config schema: classification rules (name, description, conditions
  with field/pattern/values, exclude conditions), data_dir override
- [x] 4.2 [P] Create src/defaults.ts with the default config.yaml
  content as a string constant, including all default classification
  rules with inline comments
- [x] 4.3 Implement loadConfig() that reads config.yaml from the data
  directory, validates structure (required fields, correct types),
  compile-tests all regex patterns in classification rules, and merges
  with defaults for any missing fields; returns the default config if
  no file exists; logs warnings and falls back to defaults for
  unparseable YAML, invalid regex patterns, or type errors
- [x] 4.4 Implement writeDefaultConfig() that writes the default
  config.yaml to the data directory only if the file does not exist;
  includes config version field (version: 1) for future migration
  support
- [x] 4.5 Write tests for config loading, default merging, validation
  of malformed configs (invalid YAML, invalid regex, wrong types,
  missing required fields, unrecognized fields), fallback to defaults
  behavior, and writeDefaultConfig idempotency

## 5. Classification Engine

- [x] 5.1 Create src/classifier.ts module with TypeScript types for
  classification context: agent, model, first_user_message,
  part_content (concatenated), bash_commands (extracted from tool
  calls), message_count
- [x] 5.2 Implement evaluateCondition() that checks a single condition
  against a context field: regex pattern matching for string fields,
  exact value matching for list fields
- [x] 5.3 Implement evaluateRule() that checks all conditions of a rule
  (AND logic) and all exclude conditions (any exclude match
  disqualifies)
- [x] 5.4 Implement classify() that evaluates rules in order from
  config and returns the first matching rule name, falling back to
  "ad-hoc" if no rule matches
- [x] 5.5 Implement classification cache keyed by session_id storing
  the classification result and message_count at time of classification;
  return cached result if message_count has not changed; cache SHALL
  be bounded to 1000 entries with LRU eviction
- [x] 5.6 Define default rules: pr-review (PR URL in first_user_message,
  exclude gh pr create in bash_commands), pr-creation (gh pr create in
  bash_commands), openspec-workflow (openspec/proposal/design/tasks
  references in part_content with plan or build agent), multi-agent
  (agent matches divisor-/cobalt-/gaze- prefix), exploration
  (agent=explore), planning (agent=plan), implementation (agent=build),
  ad-hoc (default fallback)
- [x] 5.7 Write tests for rule evaluation, ordering, exclude logic,
  cache hit/miss behavior, and default fallback

## 6. Session Data Extraction

- [x] 6.1 Create src/extractor.ts module with extractSessionData()
  function that takes the SDK client and a session ID and returns a
  structured object with session dimensions and computed metrics
- [x] 6.2 Query session details via client.session.get() to extract
  cost, tokens, agent, model, title, timestamps, git diff stats
- [x] 6.3 Query session messages via client.session.messages() to
  extract: first user message text, total message count, and part
  content for classification signals (PR URLs, gh pr create, openspec
  references)
- [x] 6.4 Extract project details via client.project.current() for
  the project dimension record
- [x] 6.5 Compute derived metrics: cache_hit_ratio as
  cache_read / (cache_read + tokens_input) with 0 when denominator
  is zero; duration_seconds as (time_updated - time_created) / 1000
  with 0 when either timestamp is missing or result is negative
- [x] 6.6 Handle missing or null fields gracefully: default to 0 for
  numeric fields, "unknown" for string fields, skip metrics with
  undefined source values; if session_id is null or empty, log a
  warning and skip the entire write
- [x] 6.7 Write tests with mocked SDK client responses covering
  complete sessions, sessions with missing fields, sessions with
  zero cost, sessions with zero tokens (cache_hit_ratio = 0),
  sessions with missing timestamps (duration = 0), and sessions
  with null session_id (skip write)

## 7. Plugin Entry Point and Event Handler

- [x] 7.1 Create src/index.ts with the plugin export function matching
  the Plugin type from @opencode-ai/plugin
- [x] 7.2 On plugin initialization: call initDatabase(), loadConfig(),
  writeDefaultConfig(), and log startup message via client.app.log()
  with service name "opencode-metrics"
- [x] 7.3 Register event handler that filters for events where
  event.type === "session.status" and the status type is "idle"
- [x] 7.4 On idle event: extract session data via extractor, build
  classification context, classify session, write to metrics.db via
  writer
- [x] 7.5 Wrap all event handling in try/catch; log errors via
  client.app.log() at error level; never allow plugin errors to
  propagate to OpenCode
- [x] 7.6 Write integration tests with mock event payloads and mock
  SDK client verifying the full flow from idle event to database write
- [x] 7.7 Write tests for error isolation: simulated database write
  failure (verify error logged, event handler returns normally),
  simulated SDK query exception (verify error logged, no exception
  propagation), and simulated initialization failure (verify error
  logged, OpenCode not crashed)

## 8. Build and Packaging

- [x] 8.1 Configure package.json exports and files fields to include
  only the built output (dist/) and default config content
- [x] 8.2 [P] Add .npmignore or package.json files whitelist to exclude
  tests, src, openspec, and development files from the published package
- [x] 8.3 Verify all source files contain SPDX-License-Identifier:
  Apache-2.0 header
- [x] 8.4 Verify the package builds cleanly (make build) and all tests
  pass (make test)
- [x] 8.5 Verify the plugin loads correctly when added to opencode.json
  as "plugin": ["opencode-metrics"] by running OpenCode and checking
  that metrics.db is created after the first session idle

## 9. Documentation: Installation Guide

- [x] 9.1 Write installation section in README.md covering: add to
  opencode.json plugin array, restart OpenCode, verify plugin loaded
  (check logs), verify metrics.db was created in the data directory
- [x] 9.2 Document prerequisites: minimum OpenCode version, Node.js/Bun
  availability (handled by OpenCode), supported platforms
- [x] 9.3 Document the alternative local file installation method (copy
  built plugin to ~/.config/opencode/plugins/)
- [x] 9.4 Document integration with ansible-role-ai for automated
  deployment (reference ai_opencode_plugins variable)

## 10. Documentation: Configuration Guide

- [x] 10.1 Write configuration section in README.md explaining the
  config.yaml location (~/.local/share/opencode-metrics/config.yaml),
  auto-creation on first run, and how to customize it
- [x] 10.2 Document every config field with examples: classification
  rules structure (name, description, conditions, exclude), condition
  types (field + pattern for regex, field + values for exact match),
  rule evaluation order (first match wins, last rule is fallback)
- [x] 10.3 Provide worked examples: adding a custom classification for
  a project-specific agent, modifying PR review detection patterns,
  reordering rules, disabling a default rule
- [x] 10.4 Document the data_dir override field: overrides database
  location only (config.yaml always read from default location),
  must be an absolute path or use ~ for home expansion, empty strings
  and relative paths are rejected with a warning

## 11. Documentation: Testing and Verification

- [x] 11.1 Write a verification section explaining how to confirm the
  plugin is working: check metrics.db exists, query it with sqlite3
  to see session count and recent entries
- [x] 11.2 Provide example sqlite3 queries for common checks: total
  sessions collected, daily cost summary, classification distribution,
  most expensive sessions, cache hit ratio trend
- [x] 11.3 Document how to run the project's own test suite (make test)
  for contributors

## 12. Documentation: Metric Reference, Upgrade, and Uninstall

- [x] 12.1 Write a metric reference section in README.md with a table
  listing all 12 V1 metrics: metric_name, unit, description, and
  aggregation type, matching the metric_definitions table contents
- [x] 12.2 Write an upgrade section in README.md covering: how to
  update the npm package, confirmation that existing data is preserved
  (schema uses IF NOT EXISTS, new metrics are additive rows), and any
  version-specific migration notes
- [x] 12.3 Write an uninstall section in README.md covering: removing
  from opencode.json and optionally deleting the data directory

## 13. Documentation: Troubleshooting

- [x] 13.1 Document common issues and solutions: plugin not loading
  (check opencode.json syntax, verify package name, check OpenCode
  startup logs), database not created (check directory permissions,
  check disk space), database locked errors (verify WAL mode, check
  for stale lock files), config validation errors (malformed YAML,
  invalid regex patterns — symptoms, causes, resolution)
- [x] 13.2 Document diagnostic commands: how to check plugin logs in
  OpenCode, how to inspect metrics.db schema with sqlite3, how to
  verify WAL mode is active (PRAGMA journal_mode), how to check
  database integrity (PRAGMA integrity_check)
- [x] 13.3 Document recovery procedures: how to rebuild metrics.db
  (delete file and restart OpenCode for fresh start, or use the
  ansible-role-ai backfill script for historical data), how to reset
  config.yaml to defaults (delete file and restart)

## 14. Documentation: Grafana Integration

- [x] 14.1 Write a Grafana section explaining the metrics.db schema and
  how it maps to Grafana panels via the frser-sqlite-datasource plugin
- [x] 14.2 Provide example Grafana SQL queries for common dashboard
  panels: daily cost time-series, cost by project bar chart, cost by
  classification pie chart, session count trend, cache hit ratio over
  time, top sessions table
- [x] 14.3 Reference the ansible-role-ai ephemeral Grafana container as
  the recommended quickstart path for visualization
- [x] 14.4 Document manual Grafana setup: install frser-sqlite-datasource
  plugin, configure datasource pointing to metrics.db path, note WAL
  mode considerations for container bind mounts (mount directory not
  file, or use immutable=1 for read-only access)

<!-- spec-review: passed -->
<!-- code-review: passed -->
