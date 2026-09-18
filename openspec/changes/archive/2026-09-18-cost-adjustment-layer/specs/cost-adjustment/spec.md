## ADDED Requirements

### Requirement: Cost Pricing Configuration

The plugin SHALL support an optional `cost_pricing` array in config.yaml
where each entry defines per-token prices for a model LIKE pattern.
Each pricing rule MUST include `model` (a SQL LIKE pattern string),
`input_price` (USD per million tokens), and `output_price` (USD per
million tokens). Each pricing rule MAY include `cache_read_price`,
`cache_write_price`, and `reasoning_price` (all USD per million tokens).
Each pricing rule MAY include a `description` string for documentation.

When `cost_pricing` is absent or empty, the plugin SHALL behave
identically to the current version — no adjusted cost computation
SHALL occur.

#### Scenario: Valid cost pricing configuration

- **GIVEN** config.yaml contains:
  ```yaml
  cost_pricing:
    - model: "%claude-opus-4%"
      input_price: 15.0
      output_price: 75.0
      cache_read_price: 1.5
      description: "Vertex AI pricing"
  ```
- **WHEN** the plugin loads the configuration
- **THEN** the pricing rule SHALL be parsed with model="%claude-opus-4%",
  input_price=15.0, output_price=75.0, cache_read_price=1.5,
  cache_write_price=NULL, reasoning_price=NULL

#### Scenario: Missing required fields in pricing rule

- **GIVEN** config.yaml contains a cost_pricing entry missing
  `input_price`
- **WHEN** the plugin loads the configuration
- **THEN** the malformed rule SHALL be skipped with a logged warning
- **AND** remaining valid rules SHALL be processed normally

#### Scenario: No cost_pricing section

- **GIVEN** config.yaml has no `cost_pricing` key
- **WHEN** the plugin loads the configuration
- **THEN** `cost_pricing` SHALL default to an empty array
- **AND** the plugin SHALL operate identically to versions without
  this feature

### Requirement: Cost Pricing Validation

The plugin SHALL validate each cost pricing rule during config loading.
A pricing rule SHALL be skipped (with a logged warning) if any of the
following are true:
- `model` is not a non-empty string
- `input_price` is not a finite positive number
- `output_price` is not a finite positive number
- Any optional price field (`cache_read_price`, `cache_write_price`,
  `reasoning_price`) is present but not a finite non-negative number

Unrecognized fields within a pricing rule SHALL be silently ignored,
consistent with existing config validation behavior.

#### Scenario: Duplicate model patterns

- **GIVEN** config.yaml contains two pricing rules with the same
  `model` value (e.g., both use `%claude-opus-4%`)
- **WHEN** the plugin loads the configuration
- **THEN** only the first occurrence SHALL be kept
- **AND** subsequent duplicates SHALL be skipped with a logged warning

#### Scenario: Negative price value

- **GIVEN** config.yaml contains a pricing rule with
  `input_price: -5.0`
- **WHEN** the plugin loads the configuration
- **THEN** the rule SHALL be skipped with a warning log
- **AND** no entry SHALL be created for that rule

#### Scenario: Non-numeric price value

- **GIVEN** config.yaml contains a pricing rule with
  `output_price: "expensive"`
- **WHEN** the plugin loads the configuration
- **THEN** the rule SHALL be skipped with a warning log

### Requirement: Cost Pricing Table Schema

The database SHALL include a `cost_pricing` table with the following
columns:
- `model_pattern` (TEXT, PRIMARY KEY) — SQL LIKE pattern
- `priority` (INTEGER, NOT NULL) — lower value = higher priority,
  derived from array index in config.yaml
- `input_price` (REAL, NOT NULL) — USD per million input tokens
- `output_price` (REAL, NOT NULL) — USD per million output tokens
- `cache_read_price` (REAL) — USD per million cache read tokens,
  NULL means zero cost
- `cache_write_price` (REAL) — USD per million cache write tokens,
  NULL means zero cost
- `reasoning_price` (REAL) — USD per million reasoning tokens,
  NULL means fall back to output_price
- `description` (TEXT) — optional human-readable label
- `updated_at` (INTEGER) — epoch milliseconds when the row was synced

The table SHALL be created in the V4 schema migration using
`CREATE TABLE IF NOT EXISTS`.

#### Scenario: Table exists after V4 migration

- **GIVEN** a database at schema version 3
- **WHEN** the plugin starts and applies the V4 migration
- **THEN** the `cost_pricing` table SHALL exist
- **AND** `PRAGMA user_version` SHALL be 4

### Requirement: Cost Pricing Sync on Startup

The plugin SHALL sync cost pricing rules from config.yaml to the
`cost_pricing` table on every startup. The sync SHALL use a full
replace strategy: DELETE all existing rows, then INSERT each valid
pricing rule from the config with priority equal to its zero-based
array index.

The sync SHALL be idempotent — running the plugin twice with the same
config SHALL produce the same table contents. The sync SHALL NOT
modify any other table.

#### Scenario: Config changes between startups

- **GIVEN** the `cost_pricing` table contains 3 rules from a previous
  startup
- **WHEN** the user edits config.yaml to contain 2 different rules
  and restarts the plugin
- **THEN** the `cost_pricing` table SHALL contain exactly 2 rows
  matching the current config
- **AND** no stale rules from the previous config SHALL remain

#### Scenario: Empty cost_pricing config

- **GIVEN** config.yaml has `cost_pricing: []` or no `cost_pricing`
  key
- **WHEN** the plugin starts
- **THEN** the `cost_pricing` table SHALL be empty (all rows deleted)

### Requirement: Adjusted Cost View (Cumulative)

The database SHALL include a view `v_adjusted_costs` that computes
per-session adjusted costs by joining the `sessions`, `measurements`,
and `cost_pricing` tables. The view SHALL expose:

- `session_id` — from sessions
- `model` — from sessions
- `classification` — from sessions
- `budget_tag` — from sessions
- `project_id` — from sessions
- `original_cost` — the `cost` metric value from measurements
- `adjusted_cost` — recomputed from token counts and the first
  matching pricing rule, or `original_cost` when no rule matches
- `cost_difference` — `adjusted_cost - original_cost`
- `recorded_at_epoch` — recorded_at / 1000 (epoch seconds)
- `recorded_at_iso` — ISO-8601 timestamp string

Model matching SHALL use SQL LIKE against `cost_pricing.model_pattern`.
When multiple pricing rules match, the rule with the lowest `priority`
value SHALL be selected (first match wins, consistent with
classification rule semantics).

The adjusted cost formula SHALL be:
```
(tokens_input * input_price / 1000000) +
(tokens_output * output_price / 1000000) +
(tokens_cache_read * COALESCE(cache_read_price, 0) / 1000000) +
(tokens_cache_write * COALESCE(cache_write_price, 0) / 1000000) +
(tokens_reasoning * COALESCE(reasoning_price, output_price) / 1000000)
```

When `reasoning_price` is NULL, it SHALL fall back to `output_price`.
When `cache_read_price` or `cache_write_price` is NULL, they SHALL
default to 0.

#### Scenario: Pricing rule matches a session model

- **GIVEN** the `cost_pricing` table contains a rule with
  model_pattern="%claude-opus-4%", input_price=15.0,
  output_price=75.0, priority=0
- **AND** a session with model="google-vertex-anthropic/claude-opus-4-6@default"
  has measurements: cost=0.42, tokens_input=5000, tokens_output=1000,
  tokens_reasoning=0, tokens_cache_read=0, tokens_cache_write=0
- **WHEN** `v_adjusted_costs` is queried for that session
- **THEN** original_cost SHALL be 0.42
- **AND** adjusted_cost SHALL be (5000 * 15.0 / 1000000) + (1000 * 75.0 / 1000000)
  = 0.075 + 0.075 = 0.15
- **AND** cost_difference SHALL be 0.15 - 0.42 = -0.27

#### Scenario: No pricing rule matches

- **GIVEN** the `cost_pricing` table contains rules that do not match
  the session's model string
- **WHEN** `v_adjusted_costs` is queried for that session
- **THEN** adjusted_cost SHALL equal original_cost
- **AND** cost_difference SHALL be 0

#### Scenario: Multiple rules match, first wins

- **GIVEN** the `cost_pricing` table contains:
  - priority=0, model_pattern="%claude-opus-4%", input_price=15.0
  - priority=1, model_pattern="%claude%", input_price=10.0
- **AND** a session has model="claude-opus-4-6@default"
- **WHEN** `v_adjusted_costs` is queried
- **THEN** the pricing with priority=0 (input_price=15.0) SHALL be used

### Requirement: Adjusted Cost Delta View (Time-Series)

The database SHALL include a view `v_adjusted_cost_deltas` that
computes per-delta adjusted costs by joining `sessions`,
`measurement_deltas`, and `cost_pricing`. The view SHALL expose:

- `session_id` — from sessions
- `model` — from sessions
- `classification` — from sessions
- `budget_tag` — from sessions
- `project_id` — from sessions
- `original_cost_delta` — the `cost` delta from measurement_deltas
- `adjusted_cost_delta` — recomputed from token deltas and the first
  matching pricing rule, or `original_cost_delta` when no rule matches
- `cost_delta_difference` — `adjusted_cost_delta - original_cost_delta`
- `recorded_at_epoch` — recorded_at / 1000 (epoch seconds)
- `recorded_at_iso` — ISO-8601 timestamp string

The same model matching, priority, and formula semantics as
`v_adjusted_costs` SHALL apply, but operating on delta values from
`measurement_deltas` instead of cumulative values from `measurements`.

#### Scenario: Daily cost aggregation with adjusted deltas

- **GIVEN** a multi-day session has cost deltas spread across 3 days
- **AND** a matching pricing rule exists
- **WHEN** a Grafana query aggregates adjusted_cost_delta by day
- **THEN** each day's adjusted cost SHALL reflect the token deltas
  for that day multiplied by the user-defined prices

### Requirement: Default Config Includes Pricing Example

The default config.yaml written on first run SHALL include a
commented-out `cost_pricing` section with example entries showing
the available fields. The example SHALL demonstrate at minimum:
- A rule with all price fields populated
- A rule with only required fields (model, input_price, output_price)
- A rule with a description field

The example SHALL use realistic model patterns and prices.

#### Scenario: First-run config includes pricing documentation

- **GIVEN** no config.yaml exists
- **WHEN** the plugin starts and writes the default config
- **THEN** config.yaml SHALL contain a commented-out `cost_pricing`
  section with example entries
- **AND** the examples SHALL be valid YAML if uncommented

## MODIFIED Requirements

### Requirement: MetricsConfig Interface

Previously: `MetricsConfig` included `version`, `classification_rules`,
and `budget_rules`.

The `MetricsConfig` interface SHALL be extended with an optional
`cost_pricing` array of `CostPricingRule` objects. The `loadConfig()`
function SHALL parse and validate this array using the same pattern as
`budget_rules` — absent or non-array values default to an empty array,
individual malformed rules are skipped with warnings.

### Requirement: Schema Version

Previously: Schema version was 3, adding `measurement_deltas` and
budget views.

Schema version SHALL be incremented to 4. The V4 migration SHALL:
1. Create the `cost_pricing` table
2. Create the `v_adjusted_costs` view
3. Create the `v_adjusted_cost_deltas` view

All statements SHALL use IF NOT EXISTS for idempotency. The migration
SHALL NOT modify any existing tables or views.

## REMOVED Requirements

None.
