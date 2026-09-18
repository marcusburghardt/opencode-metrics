## Why

OpenCode estimates session cost by multiplying token counts from API responses
by internally maintained per-token prices. These prices reflect the direct
provider's published list rates (e.g., Anthropic's own pricing). When users
consume models through reseller APIs — Google Vertex AI, Amazon Bedrock,
Azure OpenAI, or any proxy with different pricing — the estimated cost
diverges from the actual invoice. Enterprise and negotiated-rate customers
face the same mismatch.

The token counts themselves are accurate (they come directly from the
provider's API response), so the raw material for correct cost computation
already exists in the metrics database. What is missing is a way for users
to supply their own per-token prices and have costs recomputed at query time,
without altering the original estimates.

## What Changes

Add an optional cost pricing configuration that lets users define per-token
prices for model patterns. The plugin syncs these prices to a SQLite table
on startup. Two new SQL views compute adjusted costs at query time by
multiplying stored token counts by user-defined prices, preserving the
original OpenCode estimate alongside the adjusted value.

## Capabilities

### New Capabilities
- `cost-pricing-config`: YAML configuration section where users define
  per-token prices (input, output, cache read, cache write, reasoning)
  for model LIKE patterns, with priority determined by declaration order.
- `cost-pricing-sync`: Plugin startup logic that syncs pricing rules from
  config.yaml to the `cost_pricing` SQLite table (full replace on each
  startup).
- `adjusted-cost-views`: Two SQL views (`v_adjusted_costs` and
  `v_adjusted_cost_deltas`) that join token measurements with pricing rules
  to compute adjusted costs, falling back to the original OpenCode estimate
  when no pricing rule matches.

### Modified Capabilities
- `schema-migration`: Schema version bumped from V3 to V4 to add the
  `cost_pricing` table and the two new views.
- `config-loading`: `MetricsConfig` interface extended with an optional
  `cost_pricing` array; validation logic added for pricing rule fields.
- `default-config`: Default config.yaml updated with a commented-out
  `cost_pricing` example section.

### Removed Capabilities
- None.

## Impact

- **Database schema**: New table (`cost_pricing`) and two new views.
  Existing tables and views are untouched. Migration is additive and
  idempotent.
- **Config file**: New optional section. Existing configs remain valid
  without changes.
- **Grafana dashboards**: Users can optionally switch cost queries from
  `v_measurements` to `v_adjusted_costs` or `v_adjusted_cost_deltas`.
  Existing queries continue to work unchanged.
- **Backfill script**: No changes needed. Historical sessions already have
  token counts stored, so the adjusted views retroactively apply new pricing
  to all historical data.
- **Plugin startup**: One additional sync call. No impact on event handling
  or session data collection.

## Constitution Alignment

Assessed against the Unbound Force org constitution.

### I. Autonomous Collaboration

**Assessment**: PASS

The cost pricing configuration is a local file artifact (`config.yaml`)
that the plugin reads on startup. The pricing table is a self-describing
SQLite artifact with clear semantics (model pattern, per-token prices,
priority). No synchronous inter-agent communication is introduced. Grafana
and other consumers read the pricing-adjusted views without coordinating
with the plugin at runtime.

### II. Composability First

**Assessment**: PASS

The entire feature is optional. Users who do not configure `cost_pricing`
see no behavioral change — the adjusted views fall back to the original
OpenCode estimate via COALESCE. No new external dependencies are introduced.
The feature composes with the existing config system (same YAML file, same
validation pattern) and the existing SQL view layer (same naming convention,
same epoch/ISO timestamp pattern).

### III. Observable Quality

**Assessment**: PASS

The adjusted views expose both `original_cost` and `adjusted_cost` as
machine-parseable numeric columns, plus a `cost_difference` column for
direct comparison. This makes the adjustment auditable — users can verify
the delta against their actual invoices. The `cost_pricing` table itself
is queryable, so the pricing rules in effect are always inspectable.

### IV. Testability

**Assessment**: PASS

All new components are testable in isolation:
- Config validation: unit tests with valid/invalid YAML inputs.
- Pricing sync: unit tests against an in-memory SQLite database.
- SQL views: integration tests that seed token measurements and pricing
  rules, then assert adjusted cost values.
- No external services, network access, or shared mutable state required.

Coverage strategy: unit tests for config parsing and validation, integration
tests for the sync function and SQL view correctness, targeting the existing
80% line coverage threshold.

### V. Security by Default

**Assessment**: PASS

No new external dependencies are introduced. All user-supplied price
values are validated (finite, positive/non-negative) before database
insertion. LIKE patterns from the user's config are stored in the
`cost_pricing` table and referenced by SQL view definitions — they are
parameterized by the SQLite view, not string-concatenated into queries,
so no SQL injection vector exists. File permissions follow the existing
project patterns. The `cost_pricing` table contains only locally-sourced
configuration data (from the user's own config.yaml), not external input.
