## Why

OpenCode's Task tool spawns sub-agent sessions that each carry their
own cost, token usage, and duration. The SDK already exposes
`parentID` on every session, and the plugin already extracts it
(`src/index.ts:103`), but the value is silently dropped before
reaching the database (`src/extractor.ts:362-373`). Without storing
the parent-child relationship, there is no way to:

- See the **total cost** of an orchestrated task (parent + all
  sub-agents, recursively).
- Identify which **sub-agent type** is the most expensive across all
  sessions.
- Compare a session's **own cost** vs its **fully-loaded cost**
  (including sub-agents).
- Link the most expensive sub-agents back to their parent sessions
  for investigation.

This blocks meaningful cost analysis in Grafana for any workflow that
uses multi-agent coordination (forge sessions, divisor reviews,
cobalt-crush implementations, gaze test generation).

## What Changes

1. **Schema V4 migration**: Add `parent_session_id TEXT` column and
   `idx_sessions_parent` index to the `sessions` table. Update the
   `v_sessions` convenience view to expose the new column.

2. **Pipeline propagation**: Carry `parentID` from the SDK adapter
   through `ExtractedData` and `SessionRecord` into the database
   write path.

3. **Classification context**: Make `parent_session_id` available as
   a field in `ClassificationContext` so users can write custom rules
   referencing it. No changes to default built-in rules. Sub-agent
   detection is deterministic via `parent_session_id IS NOT NULL` --
   no configuration required.

4. **Grafana query reference**: Document example recursive CTE
   queries for the companion dashboard (ansible-role-ai), covering
   total cost aggregation, per-agent-type breakdown, parent linkage,
   and own-vs-loaded cost comparison.

## Capabilities

### New Capabilities
- `subagent-linking`: Store parent-child session relationships via
  `parent_session_id`, enabling recursive cost aggregation queries.

### Modified Capabilities
- `metrics-storage`: Schema V4 adds `parent_session_id` column,
  index, and updated `v_sessions` view.
- `metrics-collection`: Extraction pipeline propagates `parentID`
  from SDK session data into the stored session record.
- `session-classification`: `ClassificationContext` gains
  `parent_session_id` field for optional use in custom rules.

### Removed Capabilities
- None.

## Impact

- **Database schema**: V3 -> V4 migration. Additive column + index,
  no destructive changes. Existing sessions get
  `parent_session_id = NULL` (correct for root sessions, benign for
  historical sub-agents whose parentID was never stored).
- **Files changed**: `db.ts`, `writer.ts`, `extractor.ts`,
  `classifier.ts`, `defaults.ts` (field accessor only), plus their
  corresponding test files.
- **Companion repo** (ansible-role-ai): Out of scope. A Grafana
  query reference section in the change documentation provides
  actionable SQL templates for dashboard adaptation.
- **Backward compatibility**: No breaking changes. The new column is
  nullable. Existing configs, queries, and workflows continue to
  work unmodified.
- **Semantic version**: MINOR bump (new capability, no breaking
  changes).

## Constitution Alignment

Assessed against the Unbound Force org constitution.

### I. Autonomous Collaboration

**Assessment**: PASS

The change adds a new data dimension (`parent_session_id`) to an
existing self-describing artifact (the SQLite database). The column
carries enough metadata for any consumer (Grafana, Python scripts,
future agents) to interpret parent-child relationships without
consulting the producing plugin. No synchronous inter-agent
communication is introduced.

### II. Composability First

**Assessment**: PASS

The plugin continues to work standalone. The `parent_session_id`
column is nullable -- sessions without a parent (root sessions,
historical data) remain fully functional. No new dependencies are
introduced. The companion Grafana dashboard can adopt the new
queries independently; this change does not require it.

### III. Observable Quality

**Assessment**: PASS

All output remains machine-parseable (SQLite rows with a new column).
The `v_sessions` view exposes the field alongside existing columns.
Recursive CTE queries produce standard SQL result sets consumable
by any SQLite-compatible tool. The new column's presence is verified
by automated schema tests.

### IV. Testability

**Assessment**: PASS

Coverage strategy: unit tests for each pipeline stage (extractor,
writer, db migration, classifier field access), plus an integration
test validating the recursive CTE query against a seeded database
with multi-level parent-child sessions. All tests run against
in-memory SQLite -- no external services or network access required.

### V. Security by Default

**Assessment**: PASS

No new dependencies introduced. The `parent_session_id` value
originates from the OpenCode SDK (trusted internal source), not
from external user input. No new permissions, secrets, or file
access patterns are required.
