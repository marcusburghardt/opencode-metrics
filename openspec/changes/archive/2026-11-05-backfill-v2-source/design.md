# Design

## Context

`scripts/backfill.ts` imports historical sessions from OpenCode's internal
database into the metrics database. It currently reads only the legacy
`session`, `message`, and `part` tables. OpenCode V2 writes new sessions to
`session_v2`, `session_message`, and `session_part`, so the script cannot
import anything created after the V1 to V2 cutover.

The live plugin was ported to the V2 API by `opencode-v2-plugin-migration`.
This change makes the backfill read the same V2 data so the post-upgrade gap
can be recovered and future backfills stay correct.

## Observed source schema

Recorded on 2026-11-05 against OpenCode 2.2.5 on this host.

| Table | Rows | Notes |
| --- | ---: | --- |
| `session` | 1669 | Legacy, frozen at the 2026-10-30 cutover |
| `message` | 48997 | Legacy |
| `part` | 199070 | Legacy |
| `session_v2` | 1980 | Current session records |
| `session_message` | 58864 | Current conversation records |
| `session_part` | 0 | Table exists, but is unused on 2.2.5 |

`session_v2` carries cumulative `cost`, all `tokens_*` fields, `agent`,
`model` (JSON), `parent_id`, timestamps, and the `summary_*` diff columns.
`session_message.type` is one of `user`, `assistant`, `system`, `synthetic`,
`agent-switched`, `model-switched`, `compaction`, or `idle`.

The important detail is **where message content lives**. On 2.2.5,
`session_part` is empty and the content is embedded in
`session_message.data`:

```json
// type = "user"
{"time":{"created":...},"text":"...","files":[],"agents":[]}

// type = "assistant"
{"time":{"created":...},"agent":"build",
 "model":{"id":"...","providerID":"...","variant":"..."},
 "content":[{"type":"text","text":"..."},
            {"type":"tool","name":"bash","state":{"status":"completed",
              "input":{"command":"..."},
              "content":[{"type":"text","text":"..."}]}}],
 "snapshot":{"files":["src/a.ts"]}}
```

The delta spec still requires reading `session_part` (other OpenCode versions
may populate it). The design therefore reads parts from `session_part` when
rows exist and falls back to the embedded content when they do not. This is a
compatibility seam, not an optional feature: without the fallback the script
would import zero message text on the version this change targets.

## Goals

- Detect the source layout once and use the correct reader.
- Import V2 sessions, projects, measurements, classifications, budget tags,
  artifacts, and parent links with the same destination contract as the live
  plugin.
- Report the detected layout and the V2 diff-summary limitation.
- Keep every existing CLI flag and the legacy reader behavior unchanged.
- Keep the change testable without a live OpenCode instance.

## Non-goals

- Changing `src/**`, the metrics schema, or the Grafana dashboards.
- Deriving `files_changed` from `snapshot.files`; the spec requires recording
  0 when the summary columns are absent.
- Re-attributing rows written before this change.
- Replacing the per-session query pattern with a bulk loader.

## Decisions

### D1. One reader selected from the database shape

`detectSourceLayout(db)` inspects `sqlite_master` and returns `"v2"` or
`"legacy"`:

- `v2` when `session_v2`, `session_message`, and `session_part` exist.
- `legacy` when `session`, `message`, `part`, and `project` exist and
  `session_v2` does not.
- If `session_v2` or another V2 table is present but the V2 trio is
  incomplete, throw `SourceSchemaError` naming the missing tables.
- Otherwise throw the existing "not an OpenCode database" error.

`createSourceReader(db)` returns a `BackfillSource`:

```ts
interface BackfillSource {
  readonly layout: SourceLayout;
  listProjects(): SourceProject[];
  countSessions(since: number | null): number;
  listSessions(since: number | null, limit: number, offset: number): SourceSession[];
  getMessageCount(sessionId: string): number;
  getFirstUserMessage(sessionId: string): string;
  getConversationText(sessionId: string): string;
  getBashToolCalls(sessionId: string): BashToolCall[];
  getAgentFallback(sessionId: string): string | null;
  getModelFallback(sessionId: string): string | null;
}
```

`runBackfill` holds the classification, metric, delta, and artifact logic and
calls only this interface. `SourceSession` gains `parent_id`.

### D2. V2 session mapping

| Destination field | Source |
| --- | --- |
| `session_id` | `session_v2.id` |
| `project_id` | `session_v2.project_id` |
| `agent` | `session_v2.agent`, then first assistant `data.agent`, then `empty-session` / `unknown` |
| `model` | `extractModelId(session_v2.model)`, then first assistant `data.model.id`, then fallback label |
| `title` | `session_v2.title`, default `untitled` |
| `started_at` | `session_v2.time_created` |
| `ended_at` | `session_v2.time_updated` |
| `parent_session_id` | `session_v2.parent_id` (NULL for roots) |
| `cost`, `tokens_*` | matching `session_v2` columns, default 0 |
| `summary_*` | matching `session_v2` columns, default 0 |

`session_v2.model` is a JSON object; reuse `extractModelId` so both
`{"id":...}` and `{"modelID":...}` shapes resolve.

The legacy reader reads `session.parent_id` as well. Writing the parent link
for legacy sessions is a deliberate parity fix: the destination column and the
`subagent-linking` views already expect it, and leaving it NULL loses the
parent relationship the source has.

### D3. Conversation messages only

The V2 reader selects `type IN ('user', 'assistant')` ordered by
`(time_created, seq)`. `system`, `synthetic`, `agent-switched`,
`model-switched`, `compaction`, and `idle` rows are excluded from message
counts, classification text, and artifact extraction.

The legacy reader keeps its existing `COUNT(*)` over `message` so legacy
results are bit-for-bit unchanged. The two layouts therefore define
`messages_total` slightly differently; this is documented and tested rather
than silently changing legacy history.

### D4. Unified part loader

Both readers expose the same extraction helpers:

- **V2**: `getMessageParts(messageId)` first selects `session_part.data`
  ordered by `ordinal`. If at least one row exists, those parts are
  authoritative. Otherwise it decodes the embedded content:
  - user: `[{ type: "text", text: data.text }]`
  - assistant: `data.content ?? []`
- **Legacy**: the existing `part` queries.

Text extraction, tool extraction, and tool output flattening operate on the
same part array for both layouts, so classification and artifact behavior do
not fork by layout.

Unknown part variants and malformed JSON are skipped. A malformed message row
does not abort the session; it contributes no content and the per-session
warning path records it.

### D5. Classification inputs

- `first_user_message`: the first `user` message's `data.text`.
- `part_content`: text parts from conversation messages, joined with newlines,
  capped at 50 entries. Reasoning and tool parts are excluded.
- `bash_commands`: tool parts named `bash` or `shell` (case-insensitive) whose
  `state.input.command` is a string.
- `message_count`: the layout-specific count from D3.
- `agent`/`model`: the resolved values from D2.

Sessions with zero conversation messages use `empty-session` for both agent
and model when their source columns are absent, matching the current behavior.

### D6. Artifacts from V2 tool parts

`BashToolCall.command` comes from `state.input.command`. `output` comes from
the completed state's `state.content`, keeping only `type: "text"` entries and
joining them with newlines. Streaming and running tools have no output.
Errored tools contribute their command but no fabricated output.

`extractPRsCreated`, `extractPRsReviewed`, and `extractIssuesReferenced` stay
unchanged.

### D7. Diff summaries are reported, not fabricated

V2 sessions use `summary_files`, `summary_additions`, and
`summary_deletions`, with NULL mapped to 0. The reader never derives file or
line counts from `snapshot.files`; the live plugin does that, but the backfill
contract deliberately does not.

`BackfillStats` gains `missingSummary`, incremented when
`summary_files IS NULL`. The completion summary prints it so an operator can
tell an empty diff from a missing one. On 2026-11-05 the live database had 319
NULL, 132 positive, and the remainder zero.

### D8. Errors, exit codes, and testability

`runBackfill` throws `SourceSchemaError` (and ordinary errors) for setup
failures instead of calling `process.exit` internally. The `import.meta.main`
entry point catches, prints the message, and exits 1. This keeps the
destination untouched on an ambiguous layout and lets tests call
`runBackfill` with temporary paths.

Per-session failures keep the current behavior: warn, increment `skipped`,
continue, and still commit the batch.

`--dry-run` does not initialize the destination database. `--since` filters
`time_created` on `session_v2` exactly as it does on `session`. The same-file
protection and read-only source open are unchanged.

### D9. Output

Startup output becomes:

```text
Source: /path/to/opencode.db
Source layout: v2
Filter: sessions created on or after 2026-10-30
Found N sessions to process
```

The completion summary adds `Layout` and `Missing diff summary` beside the
existing session, cost, skipped, elapsed, and classification lines.
`--dry-run` prints the same layout and counts and writes nothing.

### D10. Testing strategy

Add a `createV2SourceDb()` fixture builder to `scripts/backfill.test.ts` with
options for:

- inline user text and assistant content,
- optional `session_part` rows,
- summary values or NULLs,
- parent id,
- agent/model at session or message level.

Tests cover detection, the reader methods, end-to-end import, summary
reporting, `--since`, `--with-deltas`, idempotency, and the ambiguous-layout
error. Legacy fixtures and tests stay unchanged. `runBackfill` is exercised
directly by the new V2 tests; the existing mirrored helper is kept for the
legacy metric assertions to avoid rewriting unrelated tests.

The coverage gate does not include `scripts/**`; the full `bun test` suite and
`make lint` remain the gates for this change.

## Risks and trade-offs

- **Embedded content is version-specific.** The fallback is driven by observed
  2.2.5 data. If a later OpenCode version starts writing `session_part`, the
  part-first branch takes over without a code change.
- **Schema drift.** Detection is table-existence based, not version based.
  Unknown columns are tolerated; missing required tables fail loudly.
- **N+1 queries.** Each session runs a handful of small, indexed queries.
  With roughly 2k sessions this is acceptable and matches the current script.
- **Summary semantics.** `summary_files = 0` is treated as a real zero, not as
  missing data. Only NULL increments `missingSummary`.

## Out of scope

- Populating `files_changed` from V2 snapshots.
- Bulk or streaming source reads.
- Backfilling deltas for sessions older than `--since`.
- Any change to the live plugin or destination schema.
