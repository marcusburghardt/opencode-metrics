## Context

The opencode-metrics plugin stores session cost as estimated by OpenCode,
alongside granular token counts (input, output, reasoning, cache_read,
cache_write). The token counts come from API responses and are accurate,
but the dollar cost is computed by OpenCode using internally maintained
list prices that may not match the user's actual provider pricing (e.g.,
Vertex AI, Bedrock, Azure, or negotiated enterprise rates).

Since the raw token data already exists in the database, we can recompute
costs at query time using user-supplied prices without modifying the
collected data.

## Goals / Non-Goals

### Goals
- Allow users to define per-token prices for model patterns in config.yaml
- Compute adjusted costs at query time via SQL views, preserving original
  estimates
- Support both cumulative and delta-based adjusted cost queries for Grafana
  time-series
- Retroactively apply pricing changes to all historical data (token counts
  are immutable, prices are configuration)
- Follow existing project patterns for config validation, schema migration,
  and view naming

### Non-Goals
- Fetching prices from provider APIs automatically (would require network
  access, new dependencies, and API credentials — violates Security by
  Default and Composability principles)
- Modifying the collected `cost` metric in the measurements table (the
  original estimate is preserved as the source of truth)
- Adding pricing logic to the event-handling hot path (adjustment happens
  at query time only)
- Supporting regex patterns for model matching (LIKE patterns are sufficient
  and work natively in SQLite views without application-side matching)

## Decisions

### D1: LIKE Patterns for Model Matching

**Decision**: Use SQL LIKE patterns (e.g., `%claude-opus-4%`) for the
`model_pattern` field instead of exact match or regex.

**Rationale**: LIKE patterns work natively in SQLite views — no
application-side matching is needed. This keeps the adjustment logic
entirely in SQL, which is critical because Grafana queries the database
directly without going through the plugin. Exact match would require
users to know the full model identifier (e.g.,
`google-vertex-anthropic/claude-opus-4-6@default`), which is fragile.
Regex would require SQLite extensions or pre-resolving matches at
startup, adding complexity.

**Constitution**: Composability First — the views are self-contained
SQL artifacts that any consumer can query without the plugin running.

### D2: First-Match-Wins Priority via Array Index

**Decision**: Pricing rule priority is determined by position in the
config.yaml array (index 0 = priority 0 = highest). In SQL, the
first matching rule is selected using
`ROW_NUMBER() OVER (PARTITION BY ... ORDER BY priority)`.

**Rationale**: This mirrors the existing classification rule semantics
where "rules are evaluated in order — first match wins." Users already
understand this pattern. The `priority` column in the `cost_pricing`
table stores the zero-based array index, making the SQL view
deterministic.

### D3: Full Replace Sync Strategy

**Decision**: On every plugin startup, DELETE all rows from
`cost_pricing` and INSERT the current config entries. No incremental
diff or merge.

**Rationale**: The `cost_pricing` table is small (typically <20 rules)
and is configuration-derived, not user-generated data. A full replace
is simple, idempotent, and guarantees the table always reflects the
current config. Incremental sync would add complexity (detecting
renames, reorders, deletions) with no performance benefit for a
table of this size.

### D4: Query-Time Adjustment via SQL Views

**Decision**: Cost adjustment is computed by SQL views, not at write
time. The `measurements` and `measurement_deltas` tables are never
modified.

**Rationale**: This is the core architectural decision.
- **Non-destructive**: Original estimates are preserved for auditing.
- **Retroactive**: Changing prices in config.yaml and restarting the
  plugin immediately adjusts all historical costs at the next query.
- **Decoupled**: The adjustment logic is independent of the data
  collection path — no risk of breaking metric ingestion.

**Constitution**: Autonomous Collaboration — the views are
self-describing artifacts. Observable Quality — both original and
adjusted values are exposed for comparison.

### D5: CTE-Based Pivoting for View Performance

**Decision**: The adjusted cost views use CTEs with conditional
aggregation to pivot token metrics from the EAV (entity-attribute-value)
`measurements` table into columnar form, rather than multiple LEFT JOINs.

**Rationale**: The `measurements` table stores one row per metric per
session (EAV pattern). Computing adjusted cost requires 5 token values
(input, output, reasoning, cache_read, cache_write) plus the original
cost. Using 6 LEFT JOINs would be verbose and potentially slower.
A single CTE with `SUM(CASE WHEN metric_name = 'X' THEN value END)`
pivots all 6 values in one pass over the table.

### D6: Reasoning Price Falls Back to Output Price

**Decision**: When `reasoning_price` is NULL in a pricing rule, the
adjusted cost view uses `output_price` for reasoning tokens.

**Rationale**: Most providers bill reasoning tokens at the output token
rate. Making `reasoning_price` optional with an output_price fallback
means users only need to specify it when the rate actually differs,
reducing configuration burden.

### D7: New File for Pricing Logic

**Decision**: Create `src/pricing.ts` for the `syncCostPricing()`
function. The `CostPricingRule` interface is defined in `src/config.ts`
alongside other config types (`ClassificationRule`, `BudgetRule`).

**Rationale**: The pricing sync is neither a "write" operation
(it operates on a config table, not measurements) nor a "config"
operation (it involves database I/O). A dedicated module for the sync
function follows the Single Responsibility Principle and mirrors the
existing pattern where each module has a clear purpose: `config.ts`
for parsing and type definitions, `writer.ts` for measurement writes,
`extractor.ts` for SDK data extraction, `classifier.ts` for
classification logic. The type definition stays in `config.ts` because
all config types live there (consistent with `ClassificationRule` and
`BudgetRule`).

### D8: Config `model` vs DB `model_pattern` Naming

**Decision**: The config field is named `model` (user-facing simplicity)
while the database column is named `model_pattern` (schema clarity).
The `syncCostPricing()` function maps `rule.model` to the
`model_pattern` column during INSERT.

**Rationale**: Users writing config.yaml think in terms of "which model"
— the field name `model` is intuitive and matches the `sessions.model`
column semantics. The database column `model_pattern` makes it explicit
that the value is a LIKE pattern, not an exact model identifier. This
asymmetry is intentional and contained within a single mapping point
(`syncCostPricing()`), so there is no risk of inconsistency spreading
across the codebase.

## Risks / Trade-offs

### R1: LIKE Pattern Ambiguity

**Risk**: Overly broad LIKE patterns (e.g., `%claude%`) may match
models the user did not intend.

**Mitigation**: First-match-wins semantics let users place specific
patterns before broad ones. The `cost_difference` column makes
mismatches visible. Documentation will include pattern examples and
guidance on ordering rules from specific to general. Note that LIKE
patterns are user-controlled (from local config.yaml) and cannot be
used for SQL injection — they are stored in the `cost_pricing` table
and referenced by parameterized SQL view definitions, not
string-concatenated into queries.

### R2: View Performance on Large Databases

**Risk**: The adjusted cost views use CTEs, window functions, and
LIKE matching, which may be slower than the simple `v_measurements`
view on very large databases.

**Mitigation**: The `cost_pricing` table is typically <20 rows.
The `measurements` table has indexes on `(session_id, metric_name)`
and `(metric_name, recorded_at)`. For Grafana's typical use case
(time-bounded queries with WHERE clauses), performance should be
acceptable. For databases under 50,000 sessions (typical for
single-developer or small-team usage), query performance should be
sub-second. For larger databases, monitor query times and consider
the materialized approach (writing adjusted costs at ingestion time),
which could be added later without breaking the current design.

### R3: SQLite ROW_NUMBER() Compatibility

**Risk**: `ROW_NUMBER()` window function requires SQLite 3.25.0+
(released 2018-09-15).

**Mitigation**: Bun bundles a modern SQLite version (3.38+) so this
is not a concern for the plugin runtime. The Grafana SQLite plugin
(frser-sqlite-datasource) also uses a modern SQLite. The risk is
theoretical only.

### R4: Config Sync Timing

**Risk**: Pricing rules are synced on plugin startup. If the user
edits config.yaml while the plugin is running, the changes are not
picked up until the next restart.

**Mitigation**: This is consistent with how `classification_rules`
and `budget_rules` work today — they are loaded once on startup.
Users already expect to restart the plugin for config changes. Adding
file-watching would be a future enhancement, not a requirement for
this change.
