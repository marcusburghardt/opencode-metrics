## Context

The plugin already extracts `parentID` from the OpenCode SDK at
`src/index.ts:103`, but drops it at the extraction boundary
(`src/extractor.ts:362-373`). The `SessionRecord` type
(`src/writer.ts:13-24`) and the `sessions` table
(`src/db.ts:142-154`) have no field for it. This design adds
end-to-end propagation with minimal changes.

## Goals / Non-Goals

### Goals
- Store `parent_session_id` in the sessions table with an index
  for efficient tree traversal.
- Propagate `parentID` through the full pipeline:
  SDK -> SessionInfo -> ExtractedData -> SessionRecord -> database.
- Make `parent_session_id` available in `ClassificationContext` for
  optional use in custom classification rules.
- Update `v_sessions` view to expose the new column.
- Provide documented Grafana query templates for recursive cost
  aggregation.
- Maintain full backward compatibility (nullable column, no
  breaking changes).

### Non-Goals
- Denormalized columns (`root_session_id`, `depth`) -- derivable
  via recursive CTE; not needed at current scale.
- New convenience views (`v_session_tree`) -- would walk the full
  tree on every query without parameterization; use CTE in queries
  instead.
- Grafana dashboard panel changes (ansible-role-ai scope).
- Backfilling historical parent-child relationships (data was never
  captured).
- Changes to default classification rules -- sub-agent detection is
  structural (`parent_session_id IS NOT NULL`), not rule-based.

## Decisions

### D1: Single column, not a hierarchy table

**Decision**: Add `parent_session_id TEXT` to the existing `sessions`
table rather than creating a separate `session_hierarchy` table.

**Rationale**: The parent-child relationship is a 1:N property of a
session (each session has at most one parent). A separate table would
add JOIN overhead to every query without providing additional value.
The dimensional model convention established in the metrics-storage
spec keeps dimension attributes on the dimension table.

**Constitution**: Composability First -- avoids adding schema
complexity that would burden standalone queries.

### D2: No denormalization (no root_session_id, no depth)

**Decision**: Store only `parent_session_id`. Derive tree depth and
root membership via `WITH RECURSIVE` CTEs at query time.

**Rationale**: SQLite's recursive CTE performance is more than
adequate for the expected dataset size (thousands of sessions, not
millions). Denormalized columns would require maintenance on every
write (computing depth, finding the root) and introduce consistency
risks if the tree is modified.

**Trade-off accepted**: Slightly more complex Grafana queries (CTE
syntax) in exchange for simpler, safer writes.

### D3: No new convenience views

**Decision**: Do not create `v_session_tree` or similar recursive
views. Only update the existing `v_sessions` view to include
`parent_session_id`.

**Rationale**: A recursive view without a WHERE clause would scan
the entire tree on every query. Parameterized recursive queries
belong in the Grafana panel SQL, not in a view.

**Constitution**: Observable Quality -- keeping views simple ensures
stable, predictable query performance for all consumers.

### D4: parent_session_id in ClassificationContext as empty string

**Decision**: Represent a NULL `parent_session_id` as an empty
string `""` in `ClassificationContext`, matching the existing
pattern where string context fields are never undefined.

**Rationale**: The classifier's `getFieldAsString` and `getFieldRaw`
functions return `undefined` for unknown fields (triggering "no
match"). Using `""` for "no parent" allows both pattern matching
(`'.+'` for sub-agents) and values matching (`[""]` for root
sessions) to work correctly within the existing condition evaluation
logic.

### D5: V4 schema migration follows V3 pattern

**Decision**: Use the same migration pattern as V3 (try/catch
around ALTER TABLE ADD COLUMN, followed by PRAGMA user_version
bump).

**Rationale**: SQLite does not support `ALTER TABLE ADD COLUMN IF
NOT EXISTS`. The try/catch pattern is already proven in the V3
budget_tag migration (`src/db.ts:339-346`) and handles both
upgrade and fresh-database scenarios.

### D6: Index on parent_session_id

**Decision**: Create `idx_sessions_parent` on
`(parent_session_id)` during schema creation and migration.

**Rationale**: Recursive CTE queries walk the tree by matching
`s.parent_session_id = t.session_id`. Without an index, each
recursion level scans the full sessions table. The index also
accelerates `WHERE parent_session_id IS NOT NULL` filters for
sub-agent queries.

## Risks / Trade-offs

### Risk: Historical data has no parent linkage

All sessions recorded before this change will have
`parent_session_id = NULL`. This means historical sub-agent sessions
appear as root sessions. This is accepted as unavoidable -- the SDK
provided the data but it was not stored.

**Mitigation**: None needed. Going forward, all new sessions will
have correct linkage. Dashboard queries should note that data
completeness depends on when the V4 schema was deployed.

### Risk: Orphaned sub-agents

If a sub-agent session's idle event fires before the parent session
has ever been recorded (race condition), the `parent_session_id`
will reference a session_id that does not yet exist in the sessions
table. This is safe because there is no FOREIGN KEY constraint --
the parent row will be created on the parent's first idle event.

**Mitigation**: No FK constraint on `parent_session_id`. The column
is a soft reference by design.

### Trade-off: CTE complexity vs denormalization

Recursive CTE queries are more verbose than a simple JOIN on
`root_session_id`. This is accepted because:
- The dataset is small enough that CTE performance is a non-issue.
- Denormalization would require computing root/depth on every write.
- Adding denormalized columns later (V5) is straightforward if
  needed.

## Grafana Query Reference

The following SQL templates enable sub-agent cost analysis in
Grafana dashboards using the frser-sqlite-datasource plugin.

### Total cost of a session including all sub-agents

```sql
WITH RECURSIVE tree AS (
  SELECT session_id FROM sessions WHERE session_id = '$session_id'
  UNION ALL
  SELECT s.session_id FROM sessions s
  JOIN tree t ON s.parent_session_id = t.session_id
)
SELECT ROUND(SUM(m.value), 2) AS total_cost
FROM measurements m
JOIN tree t ON m.session_id = t.session_id
WHERE m.metric_name = 'cost';
```

### Cost per sub-agent type (across all sessions)

```sql
SELECT s.agent,
       ROUND(SUM(m.value), 2) AS total_cost,
       COUNT(DISTINCT s.session_id) AS session_count
FROM sessions s
JOIN measurements m ON m.session_id = s.session_id
WHERE s.parent_session_id IS NOT NULL
  AND m.metric_name = 'cost'
GROUP BY s.agent
ORDER BY total_cost DESC;
```

### Most expensive sub-agents linked to parents

```sql
SELECT p.session_id AS parent_session,
       p.title AS parent_title,
       p.agent AS parent_agent,
       c.session_id AS subagent_session,
       c.agent AS subagent_type,
       c.model AS subagent_model,
       ROUND(m.value, 4) AS subagent_cost
FROM sessions c
JOIN sessions p ON c.parent_session_id = p.session_id
JOIN measurements m ON m.session_id = c.session_id
WHERE m.metric_name = 'cost'
ORDER BY m.value DESC
LIMIT 20;
```

### Own cost vs fully-loaded cost per root session

```sql
WITH RECURSIVE tree(root_id, session_id) AS (
  SELECT session_id, session_id
  FROM sessions WHERE parent_session_id IS NULL
  UNION ALL
  SELECT t.root_id, s.session_id
  FROM sessions s
  JOIN tree t ON s.parent_session_id = t.session_id
)
SELECT r.session_id,
       r.title,
       r.agent,
       ROUND(own.value, 4) AS own_cost,
       ROUND(total.total, 4) AS total_cost,
       ROUND(total.total - own.value, 4) AS subagent_cost
FROM sessions r
JOIN measurements own ON own.session_id = r.session_id
  AND own.metric_name = 'cost'
JOIN (
  SELECT root_id, SUM(m.value) AS total
  FROM tree t
  JOIN measurements m ON m.session_id = t.session_id
  WHERE m.metric_name = 'cost'
  GROUP BY root_id
) total ON total.root_id = r.session_id
WHERE r.parent_session_id IS NULL
  AND own.value > 0
ORDER BY total.total DESC
LIMIT 20;
```

### Daily cost split by root vs sub-agent

```sql
SELECT date(d.recorded_at_epoch, 'unixepoch', 'localtime') AS day,
       CASE WHEN s.parent_session_id IS NULL
            THEN 'root' ELSE 'subagent' END AS session_type,
       ROUND(SUM(d.delta), 4) AS cost
FROM v_measurement_deltas d
JOIN sessions s ON d.session_id = s.session_id
WHERE d.metric_name = 'cost'
GROUP BY day, session_type
ORDER BY day DESC
LIMIT 28;
```
