## Why

The plugin tracks cost, tokens, and code impact per session, but has
no visibility into the **value produced** by each session. A $60
multi-day session and a $2 quick session are equally opaque in terms
of deliverables. Without tracking what artifacts a session produces
(PRs created, PRs reviewed, issues addressed), there is no way to
compute cost-per-PR, identify which review sessions are most expensive,
or correlate cost with tangible output.

Evidence from the existing database shows rich PR/issue activity:
- 105 sessions created PRs (`gh pr create`)
- 127 sessions reviewed PRs (`gh pr view/diff/checks`)
- 82 sessions referenced issues (`gh issue`)
- Some sessions handled multiple PRs: one session reviewed 23 PRs
  and created 2 in a single session

This data is already available in OpenCode's internal database
(bash tool call commands and outputs in the `part` table) but is
not captured by the metrics plugin.

## What Changes

### Option C: Count metrics + artifact detail table

Two complementary data layers:

1. **Count metrics** (`prs_created`, `prs_reviewed`, `issues_referenced`)
   added to the existing 12-metric measurements table. These are simple
   numeric counts that work with existing Grafana panels and the
   dimensional model. Consumers can immediately query "sessions by
   PR count" or "cost per PR" using familiar measurement joins.

2. **Artifact detail table** (`session_artifacts`) storing the specific
   PR/issue references (org/repo, PR number, URL). This enables
   drill-down queries like "show me all sessions that touched PR #474"
   or "total cost of reviewing PRs in the complytime repo."

Both layers are populated from the same extraction logic: parsing
bash tool call commands for `gh pr create/view/diff/checks` and
`gh issue` patterns, and extracting PR URLs from tool call outputs.

### Implementation scope

- Add `session_artifacts` table and `v_session_artifacts` view to the
  schema
- Add 3 new metric definitions (`prs_created`, `prs_reviewed`,
  `issues_referenced`) to the catalog
- Extend the live plugin's extraction logic to count PR/issue activity
  from message parts
- Extend the backfill script to extract PR/issue data from historical
  sessions
- Add README query examples for cost-per-PR, value-per-session, etc.

## Capabilities

### New Capabilities

- `session-artifact-tracking`: Per-session tracking of PRs created,
  PRs reviewed, and issues referenced, with both count metrics and
  detailed artifact references.

### Modified Capabilities

- `metrics-collection`: The live plugin extracts PR/issue counts and
  references from bash tool call parts during idle events.
- `metrics-storage`: Schema gains `session_artifacts` table, view,
  and 3 new metric definitions.

### Removed Capabilities

(none)

## Impact

- **Files modified**: `src/db.ts` (schema), `src/extractor.ts`
  (PR/issue extraction), `src/writer.ts` (artifact writes),
  `src/index.ts` (wire extraction to write path), `scripts/backfill.ts`
  (historical extraction), `README.md` (queries), test files
- **Files added**: (none — all changes are in existing files)
- **Backward compatibility**: Full. New table and metrics are additive.
  Existing queries and views are unchanged.
- **Dependencies**: None new.
- **Breaking changes**: None.
- **Storage**: ~1 row per PR/issue interaction per session. At current
  usage (~3 PR interactions/day), negligible.

## Constitution Alignment

Assessed against the Unbound Force org constitution.

### I. Autonomous Collaboration

**Assessment**: PASS

The `session_artifacts` table is self-describing: each row contains
the session_id, artifact type, reference URL, and timestamp. Any
consumer can discover PR/issue associations without consulting the
plugin. The metric_definitions catalog documents the 3 new metrics.

### II. Composability First

**Assessment**: PASS

The artifact tracking is additive — consumers that don't know about
it are unaffected. The count metrics (`prs_created`, etc.) work with
all existing measurement views and queries. The detail table is an
optional drill-down layer.

### III. Observable Quality

**Assessment**: PASS

The `v_session_artifacts` view provides machine-parseable output with
ISO-8601 timestamps. PR references are normalized URLs enabling
cross-session aggregation. The count metrics are verifiable: the
number of `session_artifacts` rows of type `pr-created` for a session
must equal the `prs_created` measurement value.

### IV. Testability

**Assessment**: PASS

PR/issue extraction is a pure text-parsing operation on bash command
strings and tool outputs — testable with fixture data. The extraction
logic requires no network, no SDK, and no external services. The
count-equals-detail invariant is testable in isolation.
