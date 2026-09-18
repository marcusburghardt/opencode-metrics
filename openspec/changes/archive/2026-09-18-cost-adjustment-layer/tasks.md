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

## 1. Config Layer — CostPricingRule Type and Validation

- [x] 1.1 Add `CostPricingRule` interface to `src/config.ts`: `model`
  (string), `input_price` (number), `output_price` (number), optional
  `cache_read_price`, `cache_write_price`, `reasoning_price` (number),
  optional `description` (string). Extend `MetricsConfig` with
  `cost_pricing: CostPricingRule[]`.

- [x] 1.2 Add `validateCostPricingRule()` to `src/config.ts`. Validate:
  `model` is non-empty string; `input_price` and `output_price` are
  finite positive numbers; optional price fields, when present, are
  finite non-negative numbers. Return typed `CostPricingRule | null`
  (null = skip with warning). Follow the same pattern as
  `validateBudgetRule()`.

- [x] 1.3 Update `loadConfig()` in `src/config.ts` to parse the
  `cost_pricing` array. If absent or non-array, default to `[]`.
  Validate each entry with `validateCostPricingRule()`, skipping
  malformed entries with logged warnings. Detect duplicate `model`
  values: track seen model strings and skip subsequent duplicates
  with a logged warning (first occurrence wins).

- [x] 1.4 Update `DEFAULT_CONFIG_YAML` in `src/defaults.ts` to include
  a commented-out `cost_pricing` section with examples: one rule with
  all price fields, one with only required fields, one showing
  `description`. Use realistic model patterns and prices. Include a
  comment clarifying that all price fields are in USD per million tokens.

- [x] 1.5 Add unit tests for cost pricing validation in
  `src/config.test.ts`: valid rule, missing model, missing input_price,
  missing output_price, negative price, non-numeric price, optional
  fields present and absent, unrecognized fields ignored, duplicate
  model patterns (second is skipped with warning).

## 2. Database Schema — V4 Migration

- [x] 2.1 Increment `SCHEMA_VERSION` to 4 in `src/db.ts`. Add
  `cost_pricing` table creation to `createSchema()`:
  `CREATE TABLE IF NOT EXISTS cost_pricing (model_pattern TEXT PRIMARY KEY,
  priority INTEGER NOT NULL, input_price REAL NOT NULL, output_price
  REAL NOT NULL, cache_read_price REAL, cache_write_price REAL,
  reasoning_price REAL, description TEXT, updated_at INTEGER)`.

- [x] 2.2 Add `v_adjusted_costs` view creation to `createSchema()` in
  `src/db.ts`. Use a CTE with conditional aggregation to pivot token
  metrics (cost, tokens_input, tokens_output, tokens_reasoning,
  tokens_cache_read, tokens_cache_write) from `measurements`. Use a
  second CTE to match pricing via `sessions.model LIKE
  cost_pricing.model_pattern` with `ROW_NUMBER() OVER (PARTITION BY
  session_id ORDER BY priority)` for first-match-wins. Expose:
  session_id, model, classification, budget_tag, project_id,
  original_cost, adjusted_cost (COALESCE formula), cost_difference,
  recorded_at_epoch, recorded_at_iso.

- [x] 2.3 Add `v_adjusted_cost_deltas` view creation to `createSchema()`
  in `src/db.ts`. Same CTE pattern as `v_adjusted_costs` but reading
  from `measurement_deltas` and pivoting delta values. Expose:
  session_id, model, classification, budget_tag, project_id,
  original_cost_delta, adjusted_cost_delta, cost_delta_difference,
  recorded_at_epoch, recorded_at_iso.

- [x] 2.4 Add V3→V4 migration guard in `initDatabase()` following the
  existing pattern (if currentVersion < 4). The migration is handled by
  `createSchema()` IF NOT EXISTS, but the version bump must be guarded.

- [x] 2.5 Add schema migration tests in `src/db.test.ts`: V4 creates
  cost_pricing table; v_adjusted_costs view is queryable;
  v_adjusted_cost_deltas view is queryable; PRAGMA user_version is 4.

## 3. Pricing Sync Module

- [x] 3.1 [P] Create `src/pricing.ts` with `syncCostPricing(db, rules)`
  function. Implementation: DELETE FROM cost_pricing, then INSERT each
  rule with priority = array index, updated_at = Date.now(). Handle
  empty array (just DELETE). Add SPDX header.

- [x] 3.2 [P] Create `src/pricing.test.ts` with unit tests: sync with
  rules populates table; sync with empty array clears table; sync is
  idempotent (same config twice = same rows); priority reflects array
  order; re-sync replaces previous rules; updated_at is set.

## 4. SQL View Integration Tests

- [x] 4.1 Add integration tests for `v_adjusted_costs` in
  `src/db.test.ts`: seed sessions, measurements (cost + all 5 token
  metrics), and cost_pricing; assert adjusted_cost computation matches
  spec formula; assert fallback to original_cost when no pricing rule
  matches; assert cost_difference = adjusted - original; assert
  first-match-wins with multiple matching rules.

- [x] 4.2 Add integration tests for `v_adjusted_cost_deltas` in
  `src/db.test.ts`: seed measurement_deltas with token deltas and cost
  delta; seed cost_pricing; assert adjusted_cost_delta computation;
  assert fallback behavior; verify time-series aggregation use case.

- [x] 4.3 Add edge case tests in `src/db.test.ts`: NULL optional price
  fields (cache_read_price, cache_write_price default to 0;
  reasoning_price falls back to output_price); empty cost_pricing table
  (all sessions use original cost); session with zero token counts.

## 5. Plugin Startup Integration

- [x] 5.1 Update `src/index.ts` to import and call `syncCostPricing()`
  after `loadConfig()` and `initDatabase()`. Pass `db` and
  `config.cost_pricing`. Log a message with the number of pricing
  rules synced. Wrap the call in try/catch — if sync fails, log the
  error and continue (the plugin operates without adjusted cost views).

- [x] 5.2 Add integration test in `src/index.test.ts` (or extend
  existing): verify that `handleSessionIdle` still works correctly
  when cost_pricing is configured (no regression on core metrics
  collection path). Also verify that if `syncCostPricing()` throws
  during startup (e.g., database locked), the plugin logs the error
  and continues operating without adjusted cost views.

## 6. Documentation

- [x] 6.1 [P] Update `README.md` with a "Cost Adjustment" section:
  explain why adjusted costs exist, show config.yaml example with
  `cost_pricing`, list the `v_adjusted_costs` and
  `v_adjusted_cost_deltas` views with column descriptions, provide
  example Grafana SQL queries (daily adjusted cost, cost difference
  by model).

- [x] 6.2 [P] Update `openspec/specs/metrics-storage/spec.md` to add
  the Cost Pricing Table Schema, Adjusted Cost View, and Adjusted Cost
  Delta View requirements from the delta spec.

- [x] 6.3 [P] Update `CHANGELOG.md` with a cost-adjustment entry
  documenting the new `cost_pricing` config section, `cost_pricing`
  table, and `v_adjusted_costs` / `v_adjusted_cost_deltas` views.

## 7. Verification

- [x] 7.1 Run `make lint` and fix any lint issues in new/modified files.
- [x] 7.2 Run `make test` and verify all tests pass with no coverage
  regression below the 80% line coverage threshold.
- [x] 7.3 Verify constitution alignment: confirm no new external
  dependencies added, all new code is testable in isolation, all new
  outputs are machine-parseable (SQL views return structured data),
  pricing table is a self-describing artifact.

<!-- spec-review: passed -->
<!-- code-review: passed -->
