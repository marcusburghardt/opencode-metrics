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
-->

## 1. Schema and Data Layer

- [x] 1.1 Add `parent_session_id TEXT` column to the `sessions`
  table in `createSchema()` (`src/db.ts`). Add
  `CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions
  (parent_session_id)`. Update the `v_sessions` view to include
  `parent_session_id`. Bump `SCHEMA_VERSION` from 3 to 4. Add V3->V4
  migration block following the existing try/catch pattern for
  `ALTER TABLE ADD COLUMN` (same as the V2->V3 budget_tag migration).
  The migration SHALL also create the index.

- [x] 1.2 Add `parent_session_id: string | null` to the
  `SessionRecord` interface in `src/writer.ts`. Update
  `upsertSession()` to include `parent_session_id` in the INSERT and
  ON CONFLICT UPDATE columns and parameter array.

## 2. Extraction Pipeline

- [x] 2.1 Update `extractSessionData()` in `src/extractor.ts` to
  propagate `session.parentID` (from `SessionInfo`) into the returned
  `ExtractedData.session` object as `parent_session_id`. When
  `parentID` is undefined or null, set `parent_session_id` to `null`.

## 3. Classification Context

- [x] 3.1 Add `parent_session_id: string` to the
  `ClassificationContext` interface in `src/classifier.ts`. Add a
  case for `"parent_session_id"` in both `getFieldAsString()` and
  `getFieldRaw()` switch statements, returning the string value.

- [x] 3.2 Update the `classificationContext` construction in
  `extractSessionData()` (`src/extractor.ts`) to include
  `parent_session_id` as a string: use the `parentID` value or `""`
  when parentID is null/undefined.

## 4. Tests

- [x] 4.1 [P] Add schema migration tests in `src/db.test.ts`:
  - V3->V4 migration adds `parent_session_id` column.
  - V3->V4 migration creates `idx_sessions_parent` index.
  - Fresh V4 database has the column, index, and
    `parent_session_id` in `v_sessions`.
  - Existing session rows have `parent_session_id = NULL` after
    migration.

- [x] 4.2 [P] Add writer tests in `src/writer.test.ts`:
  - `upsertSession()` writes `parent_session_id` value.
  - `upsertSession()` writes NULL `parent_session_id` for root
    sessions.
  - `upsertSession()` ON CONFLICT updates `parent_session_id`.

- [x] 4.3 [P] Add extractor tests in `src/extractor.test.ts`:
  - `extractSessionData()` propagates `parentID` to
    `session.parent_session_id`.
  - `extractSessionData()` sets `parent_session_id = null` when
    `parentID` is undefined.
  - `extractSessionData()` includes `parent_session_id` in
    `classificationContext` as string (`""` for null parentID).

- [x] 4.4 [P] Add classifier tests in `src/classifier.test.ts`:
  - `getFieldAsString()` returns `parent_session_id` value.
  - `getFieldRaw()` returns `parent_session_id` value.
  - Classification rule with `field: parent_session_id` and
    `pattern: '.+'` matches sub-agent sessions.
  - Classification rule with `field: parent_session_id` and
    `values: [""]` matches root sessions.

- [x] 4.5 Add recursive CTE integration test in `src/db.test.ts`:
  - Seed a 3-level session tree (root -> worker -> sub-agent).
  - Verify recursive CTE returns correct total cost.
  - Verify `parent_session_id IS NOT NULL` filters to sub-agents
    only.

## 5. Verification

- [x] 5.1 Run `make lint` and fix any lint issues.
- [x] 5.2 Run `make test` and verify all tests pass with no
  coverage regression.
- [x] 5.3 Run `make build` and verify the plugin builds cleanly.

## 6. Documentation

- [x] 6.1 Update `GRAFANA_MIGRATION.md` with a new section
  documenting the sub-agent cost attribution queries from the design
  document. Include all five query templates with descriptions.
