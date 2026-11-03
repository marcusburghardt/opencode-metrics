## Why

OpenCode 2.0 introduces a new plugin API (`@opencode/plugin` with
`Plugin.define()`) replacing the V1 API (`@opencode-ai/plugin` with bare async
functions). The metrics plugin must be ported to the V2 API to continue
collecting session metrics. The internal data pipeline (classification, DB
writes, pricing) is fully decoupled from the SDK via the `SDKClient` adapter
interface and requires no changes to those modules. Behavior changes are
confined to the extractor and the SDK adapter (see "What Changes").

## What Changes

### Breaking: host and plugin API

- **BREAKING**: Plugin registration changes from `const plugin: Plugin = async (input) => { return { event } }` to `Plugin.define({ id: "opencode-metrics", setup(ctx) })` from `@opencode/plugin`.
- **BREAKING**: The plugin dependency changes from `@opencode-ai/plugin` (V1) to `@opencode/plugin@2.2.5`, moves from `devDependencies` to runtime `dependencies` (the import is a value, not a type), and is marked external in the bundle.
- **BREAKING**: The minimum supported host is OpenCode 2.2. Releases up to `0.4.x` remain the only option for OpenCode V1 hosts.

### Behavior changes users will notice (three)

- Session diff statistics change source: `files_changed` comes from the distinct union of assistant `snapshot.files`; `lines_added` and `lines_deleted` are recorded as 0 until upstream restores session diff data.
- Agent and model are now read from the session's current selection instead of the first user message, which can change classification for sessions that switch agent mid-session.
- Project attribution becomes per-session (`session.projectID` plus `session.location.directory`) so sessions from other projects are not misattributed. Historical rows are not retroactively corrected.

### Implementation changes (two, not user-visible)

- `createSDKAdapter()` is rewritten for the V2 plugin context (`ctx.session.get()`, `ctx.session.context()`, `ctx.location`). The per-message cost/token aggregation loop is removed because `Session.Info` now carries aggregated `cost` and `tokens`.
- Event subscription moves from the `Hooks.event` callback to a typed `ctx.event.subscribe({ types: ["session.status", "session.idle", "session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"], signal })` async iterable, with per-session debounce so duplicate terminal events produce one capture. V2 event payloads are read from `event.data` (`sessionID`, `status.type`), not `event.properties`. Logging moves from `client.app.log()` to `console.info/warn/error`; V2 exposes no logging method on the plugin context.

### Packaging and tooling

- The local plugin loaders (`make install` template and `.opencode/plugins/opencode-metrics.ts`) are flat default-export files, the proven V2 form (a directory containing `index.ts` is also accepted).
- `scripts/check.sh` loader and log assertions are updated for the new layout; otherwise `make check` would report a false failure on a correct V2 install.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `metrics-collection`: Plugin registration, event subscription, SDK client adapter, project attribution, diff statistics, and logging change to the V2 API. Adds requirements for stream resilience, agent/model provenance, log-content restriction, and malformed-payload handling.
- `metrics-storage`: Tool output is now flattened from `state.content`; the metric catalog descriptions reflect the current derivation of `files_changed` and the V2 line-count limitation, and are upserted so existing databases receive them. The sessions table gains the `parent_session_id` column required by the pre-existing `metrics-storage` and `subagent-linking` specs (schema version 6, with an idempotent v5→v6 migration, an index, and `v_sessions` exposure).
- `ci-release`: The npm install prerequisite becomes OpenCode 2.2+, release-please ownership of the changelog/version is made explicit including the breaking-change marker, and the published artifact must be installed and loaded before promotion.
- `user-documentation`: Installation, verification, metric reference, upgrade, and troubleshooting requirements change; adds migration-guide and breaking-release communication requirements.
- `session-classification`: `agent` and `model` provenance changes to the session's current selection; `first_user_message` is defined to exclude non-conversation messages.
- `historical-backfill`: The "reads all sessions" claim is narrowed to the legacy tables, with the 2026-10-30 cutoff stated.

## Impact

- **Files modified**: `src/index.ts` (plugin registration + SDK adapter), `src/extractor.ts` (session-level project and location fields, project-resolution precedence, snapshot-derived `files_changed`), `src/db.ts` (metric catalog descriptions upserted), `package.json` (dependency + build), `Makefile` (build external + install loader + uninstall target), `.opencode/plugins/opencode-metrics.ts` (default-export loader file), `scripts/check.sh` (loader path, registration, version guard, log location), `.github/workflows/ci_checks.yml` (bundle externality assertion, coverage ratchet), `.github/workflows/ci_release.yml` and `.github/workflows/ci_publish.yml` (non-`latest` publish + artifact verification + promotion gate), `README.md`, `QUICK_START.md`, `openspec/config.yaml` (project context), `bun.lock` (new dependency + integrity hashes).
- **Files owned by release-please (do not hand-edit)**: `CHANGELOG.md`, `package.json` version field, `.release-please-manifest.json`. Release note content is drafted in this change's `release-notes.md` and reconciled against the generated release PR. A one-time `docs:` remediation commit is permitted only to fold pre-existing stale entries into their released sections (see the `ci-release` delta).
- **Files unchanged**: `src/config.ts`, `src/artifacts.ts`, `src/pricing.ts`, `src/defaults.ts` -- all operate on the local `SDKClient` interface, not the SDK directly. `src/writer.ts` changes only to persist the new `parent_session_id` field.
- **Adjacent hygiene in scope**: the CI bundle assertion, `make uninstall`, the loader-format wording, and `openspec/config.yaml` refresh are small tooling fixes required to keep this migration's own gates honest; they are called out here rather than split into a separate change because the migration invalidates them.
- **Tests**: `src/index.test.ts` is rewritten (V2 adapter, subscription loop, cleanup, setup failure, deterministic subscription hooks). `src/extractor.test.ts` gains project-precedence, snapshot-union, and parentID-propagation cases. `src/db.test.ts` gains catalog-description upsert and v5→v6 migration cases, `src/writer.test.ts` gains `parent_session_id` cases, and `src/classifier.test.ts` gains `parent_session_id` rule cases. Tests for `config`, `artifacts`, `pricing` pass unchanged.
- **Downstream**: `ansible-role-ai` pins and re-enables the metrics plugin after `0.5.0` is published. This is tracked as a release gate in `tasks.md`, not an open-ended note.

## Out of Scope

- **V1 compatibility.** The plugin targets OpenCode V2 only. No dual
  `Plugin.define` + `server()` entrypoint and no V1 adapter will be
  maintained. The release is a breaking change. The `0.4.x` line remains
  installable for OpenCode V1 hosts; no further releases are planned on that
  line.
- **Session diff statistics.** V2's `Session.Info` no longer carries the diff
  summary, and the plugin context does not expose `session.diff` (verified
  against `@opencode/plugin` 2.2.5: `SessionDomain` is a `Pick` of
  `SessionApi` that excludes `diff`). `files_changed` is derived from the
  distinct union of assistant `snapshot.files`; `lines_added` and
  `lines_deleted` are recorded as 0 until upstream restores session diff data.
  This is a known limitation, not a regression to work around. Measurements
  and the provenance for these claims are recorded in `evidence.md`.
- **Historical backfill for OpenCode V2.** OpenCode's legacy `session`,
  `message`, and `part` tables stop at 2026-10-30; sessions created since then
  exist only in `session_v2`, `session_message`, and `session_part`.
  `scripts/backfill.ts` still reads the legacy tables, so it cannot close the
  V2-era gap. No tracking change is filed yet; the limitation is documented in
  README and QUICK_START as part of this change.
- **Retroactive project re-attribution.** Rows written before this change keep
  the project they were recorded under. No migration rewrites them.

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

All metrics output (measurement records, metric names/units/aggregation) is unchanged. The schema gains one additive `parent_session_id` column plus its index and view exposure, required by the pre-existing `metrics-storage` and `subagent-linking` specs.
Machine-parseable data formats are preserved. The three behavior changes that
affect stored values are stated as requirements with scenarios, and the
stream-resilience requirement makes a stopped subscription observable.
The metric catalog descriptions change, but metric names, units, and
aggregation types do not.

### IV. Testability

**Assessment**: PASS

The adapter pattern enables isolated testing of the data pipeline without a
running OpenCode instance. A coverage strategy with unit, integration, and
entry-point integration levels and a numeric target is defined in `design.md`
§8, with the ratchet enforced by `scripts/coverage-gate.ts` in
`.github/workflows/ci_checks.yml` (task 8.20).

### V. Security by Default

**Assessment**: PASS

This change adds one runtime dependency and the constitution's requirements
are met, not waived:

- **Justification**: `@opencode/plugin` is the only way to register a V2
  plugin; no existing toolchain package provides `Plugin.define`. The
  alternative considered was a locally declared ambient type, rejected because
  `Plugin` is a value import, not a type.
- **Pinning**: the dependency is pinned to the exact version `2.2.5`, not a
  range, and removed from `devDependencies` so the runtime resolution matches
  the build resolution.
- **Integrity**: `bun.lock` carries content hashes and is committed as part of
  this change; CI installs with `--frozen-lockfile`.
- **Least privilege / attack surface**: the package is marked external so it
  is not vendored into `dist`; the plugin's file permissions are unchanged
  (`0o644` files, `0o755` directories).
- **Input validation**: V2 event payloads are new external input and are
  validated per the `Graceful Handling of Missing Data` requirement.
  `session.location.directory` SHALL be ignored unless it is an absolute path,
  falling back to the instance location.
- **Data handling**: log output SHALL NOT contain tool output, message text,
  file contents, or tool arguments (`metrics-collection` "Log content
  restriction").
- **Residual risk**: the plugin now executes third-party code at runtime, and
  Dependabot can propose changes to a runtime dependency. PRs touching
  `@opencode/plugin` therefore require manual V2 verification before merge.
