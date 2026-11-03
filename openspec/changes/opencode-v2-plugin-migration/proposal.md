## Why

OpenCode 2.0 introduces a new plugin API (`@opencode/plugin` with
`Plugin.define()`) replacing the V1 API (`@opencode-ai/plugin` with bare async
functions). The metrics plugin must be ported to the V2 API to continue
collecting session metrics. The internal data pipeline (extraction,
classification, DB writes, pricing) is fully decoupled from the SDK via the
`SDKClient` adapter interface and requires no changes beyond session-level
project resolution.

## What Changes

- **BREAKING**: Plugin registration changes from `const plugin: Plugin = async (input) => { return { event } }` to `Plugin.define({ id: "opencode-metrics", setup(ctx) })` from `@opencode/plugin`.
- **BREAKING**: The plugin dependency changes from `@opencode-ai/plugin` (V1) to `@opencode/plugin@2.2.5`, moves from `devDependencies` to runtime `dependencies` (the import is a value, not a type), and is marked external in the bundle.
- **BREAKING**: `createSDKAdapter()` is rewritten for the V2 plugin context (`ctx.session.get()`, `ctx.session.context()`, `ctx.location`). The per-message cost/token aggregation loop is removed because `Session.Info` now carries aggregated `cost` and `tokens`.
- Event subscription changes from the `Hooks.event` callback to a typed `ctx.event.subscribe({ types: ["session.status"], signal })` async iterable. V2 event payloads are read from `event.data` (`sessionID`, `status.type`), not `event.properties`.
- Logging changes from `client.app.log()` to `console.info/warn/error`; V2 exposes no logging method on the plugin context.
- Init-time context (`input.project`, `input.directory`) is replaced by `ctx.location`, and project attribution becomes per-session (`session.projectID` plus `session.location.directory`) so sessions from other projects are not misattributed.
- Session diff statistics change source: `files_changed` comes from the union of assistant `snapshot.files`; `lines_added` and `lines_deleted` are recorded as 0 until upstream restores session diff data.
- The local plugin loaders (`make install` template and `.opencode/plugins/opencode-metrics.ts`) change to a default export, as V2 requires.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `metrics-collection`: Plugin registration, event subscription, SDK client adapter, and logging all change to use V2 API. Project attribution moves to session-level data in the extractor; the rest of the data pipeline is unchanged.

## Impact

- **Files modified**: `src/index.ts` (plugin registration + SDK adapter), `src/extractor.ts` (session-level project and location fields, project-resolution precedence), `package.json` (dependency + build), `Makefile` (build external + install loader), `.opencode/plugins/opencode-metrics.ts` (default-export loader), `README.md`, `CHANGELOG.md`.
- **Files unchanged**: `src/classifier.ts`, `src/config.ts`, `src/db.ts`, `src/writer.ts`, `src/artifacts.ts`, `src/pricing.ts`, `src/defaults.ts` -- all operate on the local `SDKClient` interface, not the SDK directly.
- **Tests**: `src/index.test.ts` is rewritten (V2 adapter, subscription loop, cleanup, setup failure). `src/extractor.test.ts` gains project-precedence cases. Tests for `classifier`, `config`, `db`, `writer`, `artifacts`, `pricing` pass unchanged.
- **Downstream**: Once merged and published, `ansible-role-ai` can re-enable the metrics plugin in its default `ai_opencode_plugins` list.

## Out of Scope

- **V1 compatibility.** The plugin targets OpenCode V2 only. No dual
  `Plugin.define` + `server()` entrypoint and no V1 adapter will be
  maintained. The release is a breaking change.
- **Session diff statistics.** V2's `Session.Info` no longer carries the diff
  summary, and the plugin context does not expose `session.diff` (verified
  against `@opencode/plugin` 2.2.5: `SessionDomain` is a `Pick` of
  `SessionApi` that excludes `diff`). `files_changed` is derived from the
  union of assistant `snapshot.files`; `lines_added` and `lines_deleted` are
  recorded as 0 until upstream restores session diff data. This is a known
  limitation, not a regression to work around.
- **Historical backfill for OpenCode V2.** OpenCode's legacy `session`,
  `message`, and `part` tables stop at 2026-10-30; sessions created since
  then exist only in `session_v2`, `session_message`, and `session_part`.
  `scripts/backfill.ts` still reads the legacy tables, so it cannot close the
  ~164-session gap. Tracked as the separate `backfill-v2-source` change.

## Constitution Alignment

Assessed against the Unbound Force org constitution.

### I. Autonomous Collaboration

**Assessment**: PASS

The plugin continues to produce self-describing metrics in a SQLite database.
The adapter pattern ensures the data pipeline's output format is unchanged.

### II. Composability First

**Assessment**: PASS

The `SDKClient` adapter interface isolates all SDK-specific code. Only the outer
shell changes; internal modules remain standalone and independently testable.

### III. Observable Quality

**Assessment**: PASS

All metrics output (SQLite schema, views, measurement records) is unchanged.
Machine-parseable data formats are preserved.

### IV. Testability

**Assessment**: PASS

The adapter pattern enables isolated testing of the data pipeline without a
running OpenCode instance. Only the adapter itself and the plugin entry point
require V2-specific test fixtures.
