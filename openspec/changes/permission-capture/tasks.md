## 1. Schema and migration

- [x] 1.1 Add `permission_contract`, `permission_events`, and
  `v_permission_friction` definitions to `src/db.ts` and bump
  `SCHEMA_VERSION` to 7.
- [x] 1.2 Implement the idempotent V6 → V7 migration: create objects if
  missing, seed version 1 and a random salt once, and preserve existing rows.
- [x] 1.3 Add indexes for permission id, session, canonical resource, action,
  and asked timestamp.
- [x] 1.4 Add `src/db.test.ts` cases for fresh creation, V6 migration,
  repeated initialization, and salt stability.

## 2. Sanitization

- [x] 2.1 [P] Add `src/sanitizer.ts` with shell canonicalization, path classes,
  extension extraction, salted hashing, and secret redaction.
- [x] 2.2 [P] Add `src/sanitizer.test.ts` covering assignments, quoting, URLs,
  paths, headers, tokens, private-key markers, long encoded values, project,
  home, tmp, system, and external path classes.
- [x] 2.3 [P] Document the canonicalization rules and lossy behavior in the
  module header comment.

## 3. Capture pipeline

- [x] 3.1 Add `src/permission-store.ts` with asked/replied upsert operations,
  unique-permission-id handling, late replies, and orphan replies.
- [x] 3.2 Extend the event handler in `src/index.ts` to pass the full asked and
  replied payload to the capture path while keeping the existing
  `PermissionTracker` counters unchanged.
- [x] 3.3 Persist save patterns from `always` replies in canonical form and
  keep them distinguishable from the presented resource.
- [x] 3.4 Implement fail-open behavior: log capture errors without blocking the
  session, prompt, or metric accounting.
- [x] 3.5 Add `src/permission-store.test.ts` and extend `src/index.test.ts` for
  asked/replied sequences, duplicate delivery, late and orphan replies, save
  patterns, and a closed database.

## 4. Configuration and retention

- [x] 4.1 [P] Add `permission_capture` defaults (`enabled: true`,
  `retention_days: 90`, `store_raw: false`) to `src/defaults.ts` and parse and
  validate them in `src/config.ts`.
- [x] 4.2 [P] Add `src/config.test.ts` cases for defaults, disabling, custom
  retention, invalid values, and `store_raw` opt-in.
- [x] 4.3 Implement retention cleanup on startup and at most once per day while
  the plugin is active; never delete session measurements.
- [x] 4.4 Add cleanup tests with synthetic old and new events.

## 5. Reporting

- [x] 5.1 [P] Add `scripts/permission-report.ts` that opens the database
  read-only and prints JSON with the window, totals, and grouped friction rows.
- [x] 5.2 [P] Add a `make permission-report` target and document the JSON
  output shape.
- [x] 5.3 Add a test or fixture that validates the report JSON shape against a
  temporary database.

## 6. Documentation

- [x] 6.1 Update `README.md` with contract version 1, `permission_contract`,
  `permission_events`, `v_permission_friction`, configuration keys, retention,
  sanitization rules, and the no-backfill limitation.
- [x] 6.2 Add example queries for top canonical resources, wait percentiles,
  always grants, and non-reusable saved patterns.
- [x] 6.3 Document the companion consumer in `ansible-role-ai`
  (`session-retro-loop`) and the minimum supported contract version.

## 7. Verification

- [x] 7.1 Run `bun test --coverage` and confirm the 80% line-coverage gate is
  maintained or improved.
- [x] 7.2 Run `make lint` and `bun run build`.
- [x] 7.3 Run `openspec validate permission-capture --strict`.
- [x] 7.4 Verify the plugin still records session metrics with capture
  disabled and with a database that lacks the permission tables.
- [x] 7.5 Confirm the constitution alignment remains PASS for all five
  principles after implementation.

## 8. Pre-release metadata repair

Live capture showed `project_id`, `agent`, and `model` were null when a
permission ask arrived before the metrics `sessions` row was written.

- [x] 8.1 Backfill missing grouping metadata inside `writeSessionData` after
  the session row is persisted.
- [x] 8.2 Refresh metadata on reply and repair historical null rows at startup.
- [x] 8.3 Add regression tests for late session rows and startup repair, then
  re-run the full test, coverage, lint, build, and strict validation gates.
