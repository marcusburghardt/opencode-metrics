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

# Tasks

Implements `specs/historical-backfill/spec.md`. See `design.md` for the source
schema evidence, the `BackfillSource` seam, and the part-loading fallback.

## 1. Source Detection and Reader Seam

- [x] 1.1 Add `SourceLayout`, `SourceSchemaError`, and `BackfillSource` to `scripts/backfill.ts`; add `parent_id` to `SourceSession`
- [x] 1.2 Implement `detectSourceLayout(db)` with the V2-first rules from `design.md` §D1, reporting every missing table in the error
- [x] 1.3 Implement `createSourceReader(db)` returning a legacy or V2 reader behind the `BackfillSource` interface
- [x] 1.4 Move the existing legacy queries behind the legacy reader without changing their SQL or result shapes
- [x] 1.5 Replace the direct `validateSourceSchema` call in `runBackfill` with layout detection, keeping `validateSourceSchema` exported for compatibility or updating its callers
- [x] 1.6 Replace setup-time `process.exit` calls in `runBackfill` with thrown errors; catch them in the `import.meta.main` entry point and exit 1
- [x] 1.7 Log `Source layout: legacy|v2` after the source path and add the layout to `BackfillStats` and the completion summary
- [x] 1.8 Confirm an ambiguous V2 layout exits before the destination database is initialized or written

## 2. V2 Session Reader

- [x] 2.1 Implement `listProjects()` for V2 using the existing `project` table and `deriveProjectName`
- [x] 2.2 Implement `countSessions(since)` and `listSessions(since, limit, offset)` over `session_v2`, ordered by `time_created` then `id`
- [x] 2.3 Select the V2 session columns listed in `design.md` §D2, including `parent_id` and `summary_*`
- [x] 2.4 Reuse `extractModelId` for the V2 JSON `model` column and tolerate NULL/malformed values
- [x] 2.5 Resolve agent from `session_v2.agent`, then the first assistant message's `data.agent`, then the `empty-session`/`unknown` label
- [x] 2.6 Resolve model from `session_v2.model`, then the first assistant message's `data.model.id`, then the fallback label
- [x] 2.7 Pass `parent_id` to `upsertSession` as `parent_session_id` for both layouts; NULL for root sessions
- [x] 2.8 Preserve the existing zero-message `empty-session` labeling behavior

## 3. V2 Messages and Parts

- [x] 3.1 Add a conversation message query selecting `type IN ('user','assistant')` ordered by `(time_created, seq)`, decoding `data` as JSON
- [x] 3.2 Implement `getMessageCount()` as the count of conversation messages only
- [x] 3.3 Implement `getFirstUserMessage()` from the first user message's `data.text`
- [x] 3.4 Implement the unified part loader: prefer `session_part` rows ordered by `ordinal`; when none exist, use user `data.text` or assistant `data.content`
- [x] 3.5 Implement `getConversationText()` by joining text parts from conversation messages, capped at 50 entries, excluding reasoning and tool parts
- [x] 3.6 Implement `getBashToolCalls()` for V2 tool parts named `bash` or `shell`, reading `state.input.command` and flattening completed `state.content` text entries into `output`
- [x] 3.7 Skip unknown part variants and malformed JSON without throwing; a malformed message contributes no content and follows the per-session warning path
- [x] 3.8 Confirm `session_part` rows, when present, take precedence over embedded content for the same message

## 4. Behavior Preservation and Output

- [x] 4.1 Keep `--since` filtering on `time_created` for both layouts
- [x] 4.2 Keep `--with-deltas` and the catch-up delta path unchanged for V2 sessions
- [x] 4.3 Keep batch transactions, per-session warning/skip behavior, and idempotent upserts unchanged
- [x] 4.4 Count sessions with `summary_files IS NULL` in `BackfillStats.missingSummary` and print the count in the completion summary
- [x] 4.5 Keep `--dry-run` from initializing or writing the destination database, while still printing layout and counts
- [x] 4.6 Confirm the legacy reader produces the same session, metric, classification, and artifact results as before
- [x] 4.7 Confirm the same-file protection and read-only source open still run before any destination work

## 5. Tests

- [x] 5.1 Add a `createV2SourceDb()` fixture builder to `scripts/backfill.test.ts` covering inline content, `session_part` rows, summary values, NULL summaries, parent ids, and agent/model fallbacks
- [x] 5.2 Add detection tests: complete V2, complete legacy, partial V2 with each missing table named, and a database with neither layout
- [x] 5.3 Add session reader tests: project list, count, `--since`, ordering, aggregates, and NULL defaults
- [x] 5.4 Add message tests: conversation filtering, message count, first user text, empty user text, malformed JSON, and unknown types
- [x] 5.5 Add part tests: embedded user text, embedded assistant content, `session_part` precedence, ordinal order, and empty parts
- [x] 5.6 Add tool tests: `bash` and `shell` names, completed output flattening, running/streaming tools with no output, errored tools, and missing command
- [x] 5.7 Add provenance tests: session-level agent/model, message-level fallbacks, `empty-session`, `unknown`, and parent/root `parent_session_id`
- [x] 5.8 Add an end-to-end V2 import test asserting sessions, projects, measurements, artifacts, classification, and budget tags
- [x] 5.9 Add a V2 summary test: NULL summaries record 0 and increment `missingSummary`; populated summaries keep their values
- [x] 5.10 Add idempotency and `--with-deltas` tests for a V2 source
- [x] 5.11 Add a `--dry-run` test proving no destination file or rows are created
- [x] 5.12 Add an ambiguous-layout test proving the destination is untouched and the error names the missing tables
- [x] 5.13 Confirm every existing legacy backfill test passes without modification
- [x] 5.14 Run `bun test` and `make lint`

## 6. Documentation

- [x] 6.1 Update the README backfill section to state that both legacy and V2 layouts are supported and that the layout is reported
- [x] 6.2 Update the README coverage caveat: remove the "cannot import after 2026-10-30" limitation for V2-backed databases
- [x] 6.3 Document the V2 diff-summary limitation in the README backfill section and link it to the `files_changed`/line-count limitation
- [x] 6.4 Update the README verification output and queries to include the `Source layout` line and a V2 session count
- [x] 6.5 Update `QUICK_START.md`: host prerequisite, expected `Source layout: v2` output, and the corrected backfill caveat
- [x] 6.6 Add the ambiguous-layout failure to the README troubleshooting section
- [x] 6.7 Confirm the README no longer claims that `make backfill` reads only legacy tables

## 7. Verification

- [x] 7.1 Run `make build`, `make test`, and `make lint`
- [x] 7.2 Run `make backfill ARGS="--dry-run"` against the local OpenCode database and confirm it reports `Source layout: v2` and a count consistent with `session_v2`
- [x] 7.3 Run a real backfill into a temporary `--dest` directory and verify session, measurement, artifact, and classification rows
- [x] 7.4 Compare one backfilled V2 session against the live plugin's row for cost, tokens, agent, model, project, and parent
- [x] 7.5 Confirm legacy behavior with an existing V1 fixture database or the existing test suite
- [x] 7.6 Record the before/after session counts and the detected layout in the PR description
- [x] 7.7 Review the implementation against `specs/historical-backfill/spec.md` and check off completed tasks

## Out of Scope

- Populating `files_changed` from V2 `snapshot.files`.
- Bulk/streaming source reads or new source indexes.
- Changing the live plugin, destination schema, or Grafana dashboards.
- Re-attributing rows written before this change.
