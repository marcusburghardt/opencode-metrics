## Why

OpenCode V2 changed where it stores session history. The legacy `session`,
`message`, and `part` tables stop receiving rows at the V1 to V2 upgrade and
are frozen, while new sessions are written to `session_v2`,
`session_message`, and `session_part`. On this machine the legacy `session`
table ends at 2026-10-30, and 164 sessions created since then exist only in
`session_v2`.

`scripts/backfill.ts` still reads the legacy tables. As a result it cannot
import any session created after the upgrade, and future backfill runs would
silently report success while importing nothing new. The metrics collected by
the live plugin after the V2 port will be correct, but the post-upgrade gap
stays empty until the backfill understands the V2 source layout.

This work is deliberately separate from the plugin port
(`opencode-v2-plugin-migration`) so each change stays independently
reviewable and testable.

## What Changes

- **Schema detection**: inspect the source database at startup and choose the
  V2 reader when `session_v2` exists, keeping the legacy reader for older
  databases.
- **Session source**: read sessions, cost, tokens, agent, model, timestamps,
  and summary columns from `session_v2` instead of `session`.
- **Message source**: read message and part data from `session_message` and
  `session_part`, decoding the JSON `data` column into the same intermediate
  shapes the extraction helpers already use.
- **Diff summary limitation**: `session_v2.summary_files`,
  `summary_additions`, and `summary_deletions` are NULL for V2-era sessions
  (164 of 165 observed), so backfilled V2 sessions record 0 for
  `files_changed`, `lines_added`, and `lines_deleted`. This is an upstream
  data gap, not a backfill defect, and MUST NOT be worked around by
  fabricating values.
- **Existing behavior preserved**: `--dry-run`, `--since`, `--with-deltas`,
  classification, budget tags, artifact extraction, and idempotent upserts
  keep working for both source layouts.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `historical-backfill`: the backfill source adapter supports OpenCode V2
  tables in addition to the legacy V1 tables, and reports which layout it
  selected.

## Impact

- **Files modified**: `scripts/backfill.ts` (source adapter, message/part
  readers), `scripts/backfill.test.ts` (V2 fixtures alongside V1 fixtures),
  `README.md` (backfill section note on V2 sources and the diff limitation).
- **Files unchanged**: `src/**` plugin code, `metrics.db` schema, Grafana
  dashboards. The destination contract is unchanged.
- **Data**: recovers the post-upgrade session gap and makes future backfills
  correct. No destructive migration; upserts remain idempotent.
- **Dependencies**: none added.

## Constitution Alignment

Assessed against the Unbound Force org constitution.

### I. Autonomous Collaboration

**Assessment**: PASS

The backfill continues to consume OpenCode's database and produce
self-describing metrics rows in the same schema. The V2 layout is read
directly rather than through a new runtime dependency on OpenCode.

### II. Composability First

**Assessment**: PASS

The script remains standalone. Legacy and V2 support coexist behind one
source adapter, so the script keeps working against either database without
requiring the plugin to be installed.

### III. Observable Quality

**Assessment**: PASS

The backfill already reports imported counts and supports `--dry-run`. This
change adds the detected source layout to that output, and the diff-summary
limitation is recorded rather than hidden.

### IV. Testability

**Assessment**: PASS

The source adapter is selected from database shape, so both layouts can be
exercised with fixture databases in unit tests. No live OpenCode instance is
required.
