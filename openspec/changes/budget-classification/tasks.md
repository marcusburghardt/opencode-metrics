<!--
  [P] marks tasks eligible for parallel execution.
  Add [P] when a task: (a) touches different files from
  other [P] tasks in the group, (b) has no dependency
  on prior tasks in the group, (c) can safely execute
  without ordering constraints.
  Do NOT add [P] when tasks modify the same file --
  parallel workers will cause merge conflicts.
  Tasks without [P] run sequentially first, then [P]
  tasks run in parallel.
-->

## 1. Configuration Layer

- [ ] 1.1 Add `BudgetRule` interface to `src/config.ts` with
  `budget_tag: string`, `conditions: ClassificationCondition[]`,
  and optional `exclude: ClassificationCondition[]`. Extend
  `MetricsConfig` with `budget_rules?: BudgetRule[]`. Add
  `validateBudgetRule()` function that reuses `validateCondition()`
  and validates budget_tag is a non-empty string. Update
  `loadConfig()` to parse and validate the `budget_rules` section,
  defaulting to an empty array when absent. Add tests for budget
  rule validation in `src/config.test.ts` covering: valid rules,
  missing budget_tag, invalid regex, missing conditions array, and
  absent budget_rules section.
  **Files**: `src/config.ts`, `src/config.test.ts`

- [ ] 1.2 [P] Update `DEFAULT_CONFIG_YAML` in `src/defaults.ts`
  to include an empty `budget_rules: []` section with commented
  examples showing pattern-based (message prefix), values-based
  (project_name), and combined rules. Update `DEFAULT_CONFIG`
  parsing to include budget_rules. Add test verifying the default
  config parses with an empty budget_rules array.
  **Files**: `src/defaults.ts`

## 2. Classification Engine

- [ ] 2.1 Add `project_name: string` field to
  `ClassificationContext` in `src/classifier.ts`. Update
  `getFieldAsString()` and `getFieldRaw()` to handle the
  "project_name" case. Add tests for project_name field matching
  in `src/classifier.test.ts` (pattern and values).
  **Files**: `src/classifier.ts`, `src/classifier.test.ts`

- [ ] 2.2 Add `classifyBudget()` function to `src/classifier.ts`
  that takes `BudgetRule[]` and `ClassificationContext`, evaluates
  rules using `evaluateRule()`, and returns `string | null` (null
  when no rule matches). Add tests in `src/classifier.test.ts`
  covering: first match wins, no match returns null, exclude
  prevents match, empty rules returns null, pattern and values
  conditions, project_name-based rules.
  **Files**: `src/classifier.ts`, `src/classifier.test.ts`

## 3. Database Schema

- [ ] 3.1 Bump `SCHEMA_VERSION` from 2 to 3 in `src/db.ts`. Add
  a migration block in `initDatabase()` that runs
  `ALTER TABLE sessions ADD COLUMN budget_tag TEXT` when upgrading
  from version < 3. Guard with try/catch for SQLite compatibility.
  Add test in `src/db.test.ts` verifying: fresh database has
  budget_tag column, schema version is 3, and migration from v2
  adds the column without data loss.
  **Files**: `src/db.ts`, `src/db.test.ts`

## 4. Data Pipeline

- [ ] 4.1 Add `budget_tag: string | null` to `SessionRecord` in
  `src/writer.ts`. Update `upsertSession()` to include budget_tag
  in the INSERT and ON CONFLICT DO UPDATE clauses. Add tests in
  `src/writer.test.ts` verifying: session with budget_tag is
  written correctly, session with null budget_tag is written
  correctly, budget_tag is updated on re-upsert.
  **Files**: `src/writer.ts`, `src/writer.test.ts`

- [ ] 4.2 [P] Update `extractSessionData()` in `src/extractor.ts`
  to populate `project_name` in `ClassificationContext` from the
  project's name (directory name). Add test in
  `src/extractor.test.ts` verifying project_name is set in the
  returned context.
  **Files**: `src/extractor.ts`, `src/extractor.test.ts`

## 5. Plugin Integration

- [ ] 5.1 Update `handleSessionIdle()` in `src/index.ts` to:
  (a) create a second `ClassificationCache` instance for budget,
  (b) call `classifyBudget()` with config.budget_rules, (c) set
  `data.session.budget_tag` from the result. Add tests in
  `src/index.test.ts` verifying: budget_tag is set when rules match,
  budget_tag is null when no rules match, budget cache is
  independent of classification cache.
  **Files**: `src/index.ts`, `src/index.test.ts`

## 6. Backfill

- [ ] 6.1 Update `scripts/backfill.ts` to apply
  `classifyBudget()` to each backfilled session using the loaded
  config's budget_rules. Set budget_tag on the session record.
  Add tests verifying: session with matching budget rule receives
  budget_tag, session with no matching rule receives NULL
  budget_tag, re-running backfill with updated budget_rules
  overwrites budget_tag.
  **Files**: `scripts/backfill.ts`

## 7. Documentation

- [ ] 7.1 Update `README.md` to document the budget_rules config
  section. Include: config field reference, worked examples
  (message prefix pattern, project_name values, combined rules),
  example SQL queries for budget-filtered cost analysis (total cost
  per budget, daily cost per budget, cost by budget and
  classification). Add a note that budget_tag is NULL for
  non-tagged sessions.
  **Files**: `README.md`

## 8. Verification

- [ ] 8.1 Run the full test suite (`make test`) and verify all
  existing tests still pass alongside new tests. Verify lint passes
  (`make lint`). Confirm coverage meets the 80% threshold.

- [ ] 8.2 [P] Verify constitution alignment: classifyBudget() is a
  pure function testable in isolation (Testability), budget_tag is
  stored in the same machine-parseable SQLite schema (Observable
  Quality), budget classification is fully optional with no new
  dependencies (Composability First), all config inputs are
  validated (Security by Default).

<!-- spec-review: passed -->
