# Design

## Context

The plugin uses a deliberate adapter pattern (`createSDKAdapter`) that maps the
OpenCode SDK client to a local `SDKClient` interface. All data processing
modules (`extractor.ts`, `classifier.ts`, `config.ts`, `db.ts`, `writer.ts`,
`artifacts.ts`, `pricing.ts`) operate exclusively on this local interface.
Only `src/index.ts` touches the SDK directly.

See `proposal.md` for motivation and `specs/` for the normative requirements.
Verified against `@opencode/plugin@2.2.5` and the OpenAPI document served by
OpenCode 2.2.5, the V2 plugin API differs from V1 as follows:

- `@opencode-ai/plugin` (V1) -> `@opencode/plugin` (V2)
- `Plugin` function -> `Plugin.define({ id, setup(ctx) })`
- `PluginInput.client` -> domain methods on the plugin context
- `Hooks.event` callback -> `ctx.event.subscribe()` async iterable
- `input.project` / `input.directory` -> `ctx.location.project` /
  `ctx.location.directory`
- event payloads live on `event.data`, not `event.properties`
- `client.app.log` -> `console.*` (the V2 `ctx.app` exposes only `name`,
  `version`, `channel`)

## Terminology

Four "project path" concepts appear in V2 and are not interchangeable. This
document uses them as follows:

| Term | Meaning | Source |
| --- | --- | --- |
| session location | the directory of the session being captured | `session.location.directory` |
| instance location | the directory the plugin instance was loaded for | `ctx.location.directory` |
| instance project path | the plugin instance's project root | `ctx.location.project.canonical` |
| `ProjectInfo.path` | the local adapter's project path field | returned by `project.current()` |

`session.location.directory` is the only per-session value. Everything else is
instance-scoped and is therefore a fallback only. `canonical` is treated as a
filesystem path, consistent with how `project.path` is used today.

## Goals / Non-Goals

**Goals:**

- Port the plugin to compile and run under OpenCode V2 (2.2.x).
- Preserve the `SDKClient` adapter boundary so the data pipeline stays
  independently testable.
- Maintain existing metrics collection, classification, and storage behavior,
  with the **three documented behavior changes**: per-session project
  attribution, session diff statistics, and agent/model provenance.
- Keep the cleanup mechanism (abort the event subscription on plugin unload).

**Non-Goals:**

- Adding new V2-only features (tools, commands, transforms, websearch, etc.).
- Changing the SQLite schema beyond adding the `parent_session_id` column
  required by the existing `metrics-storage` and `subagent-linking` specs
  (already specified upstream; not a new capability). Metric
  names/units/aggregation types and classification rule semantics are
  unchanged. (Metric catalog *descriptions* are updated; see the
  `metrics-storage` delta.)
- Changing the `bun:sqlite` runtime dependency.
- Supporting V1 and V2 simultaneously.
- Retroactively re-attributing historical rows or recovering the V2-era
  backfill gap.

## Decisions

### 1. Rewrite scope: `src/index.ts` plus a narrow `src/extractor.ts` change

**Decision:** Rewrite `createSDKAdapter()` and the plugin entry point in
`src/index.ts`. In `src/extractor.ts`, add `projectDirectory` and
`snapshotFiles` to the local message/session shapes, and change project
resolution to prefer session-level data over `project.current()`.

**Rationale:** The adapter pattern covers almost everything. Project
attribution is the exception: V2 is a single background service that observes
sessions from multiple projects, and the docs state that `ctx.location` is the
plugin instance's location, not every session's. `Session.Info` provides
`projectID` and `location.directory`, so the extractor must prefer those.
Without this, sessions from other projects are written under the wrong
`project_id`. The change is small and covered by extractor tests.

### 2. Event subscription: typed `session.status` stream with AbortController

**Decision:** Subscribe with
`ctx.event.subscribe({ types: ["session.status"], signal })` in a background
async loop that `await`s each handler before pulling the next event. Treat
`event.data.status.type === "idle"` as the capture trigger and read the session
ID from `event.data.sessionID`. Return `() => controller.abort()` from
`setup()` as the cleanup function.

**Rationale:** `session.status` preserves current behavior exactly (V1 also
used idle transitions), and the `types` filter avoids decoding every event.
V2 also emits `session.idle`, but switching to it would be an unnecessary
behavior change. Sequential awaiting is required for correctness:
`writeSessionMetrics` computes `delta = new_value - previous_value` from a
read-then-insert, so two overlapping handlers for the same session would both
see the same `previous_value` and double-count the delta. Sequential
processing also bounds the async iterator's buffer. The abort pattern is the
documented V2 cleanup mechanism.

**Alternative considered:** `session.idle`. Rejected for behavior parity; it
carries only `sessionID` and does not express busy/retry transitions.

**Alternative considered:** concurrent handling with per-session write locks.
Rejected as more code for no throughput benefit; capture is a local SQLite
write, not a network call.

### 3. Logging: console methods with restricted content

**Decision:** Replace `client.app.log({ body: { service, level, message } })`
with `console.info()`, `console.warn()`, and `console.error()`, keeping the
`[opencode-metrics]` prefix. Log lines SHALL contain only metric and behavior
metadata (session id, operation, error name and message). They SHALL NOT
include tool output, message text, or file contents.

**Rationale:** `ctx.app` exposes no logging method. Console output is captured
by the server process log. The exact capture behavior is confirmed by tasks
11.3 and 11.6 before release and recorded in `evidence.md` §3; the verification
path documented to users leads with a database query so it does not depend on
that assumption.

**Open question resolved at verification:** if the server does not capture
console output, logging degrades gracefully — the metrics themselves are
unaffected, and README verification points at the database instead.

### 4. SDK adapter: map the V2 context onto the unchanged `SDKClient` output

**Decision:** `createSDKAdapter(ctx)` maps:

| `SDKClient` member | V2 source | Mapping |
| --- | --- | --- |
| `session.get(id)` | `ctx.session.get({ sessionID: id })` | `cost` and `tokens.*` are already aggregated; `agent`, `model`, `title`, `parentID`, `projectID`, `time.created`, `time.updated` map directly. Does **not** load messages. |
| `session.messages(id)` | `ctx.session.context({ sessionID: id })` | Translate V2 message shapes (below). |
| `project.current()` | `ctx.location` | Fallback only; the extractor prefers the session's own project data. |
| `app.log(message)` | `console.warn` | Keeps the extractor's warning path at warn level. |

`session.get()` intentionally does not load messages. This keeps the
"aggregates come straight from the session row" contract literally true and
removes the V1 message cache.

Message translation:

- `Session.Message.Info` uses `type`, not `role`; `SDKClient.MessageInfo.role`
  is populated from it.
- User messages carry a single `text` field, not parts. Emit one text part.
- Assistant messages carry `content[]` with `text`, `reasoning`, and `tool`
  entries. Emit `type: "text"` parts from text content (skip reasoning) and
  `type: "tool"` parts from tool content, using `name`, `state.input`, and a
  flattened `state.content`.
- Tool output is `Tool.Content[]`; join `type: "text"` entries with newlines so
  artifact regexes receive a string, as in V1. Absent or non-text content
  yields `""`.
- Only `user` and `assistant` messages are returned. V2 also emits markers
  (`session.*.selected`, `idle`) and `synthetic`/`system`/`shell` messages in
  the context; including them would inflate `messages_total` and could make a
  system reminder the "first user message".
- Unknown content variants are skipped, never thrown.

- `cost` and `tokens_*` come from `Session.Info` unchanged. The requirement
  states they are the session's own values, excluding children; that premise is
  verified in `evidence.md` §5 before release, and if it does not hold the
  change is re-scoped (the metric would otherwise inflate for parent sessions).

Diff statistics:

- Each assistant message exposes its `snapshot.files` as `snapshotFiles` on the
  local message shape.
- `files_changed` = size of the distinct union of those paths across the
  session, normalized to repo-relative POSIX paths.
- `lines_added` and `lines_deleted` = 0. V2 removed the diff summary from
  `Session.Info`, and `ctx.session` does not expose `session.diff` (the
  `SessionDomain` type is a `Pick` of `SessionApi` that omits it).

**Rationale:** This keeps the pipeline contract intact while translating the
shapes that genuinely changed. Computing the union in the extractor (which
already loads messages) rather than in `session.get()` resolves the conflict
between "no message loads on `session.get`" and "files_changed comes from
messages".

### 5. Per-session project attribution

**Decision:** `SessionInfo` gains `projectDirectory?: string`, sourced from
`session.location.directory`. `extractSessionData()` resolves:

- `projectId = session.projectID ?? project.id ?? "unknown"`
- project path = `session.projectDirectory ?? project.path`

`session.projectDirectory` SHALL be ignored unless it is a non-empty absolute
path; otherwise resolution falls back to `project.path`. The resolved path is
also what `repoContext` uses for artifact extraction (`git -C <path>`), so an
unvalidated relative value would silently disable artifact capture.

`project.current()` remains the fallback for sessions without location data.

**Rationale:** V2 serves sessions across projects. Preferring the session's own
data prevents cross-project misattribution. `ctx.location.project.canonical`
remains useful as a fallback path for the plugin's own project. Historical
rows are not rewritten; that is documented as a limitation.

The schema gains the `parent_session_id` column (and its `v_sessions`
exposure) to satisfy the already-specified `metrics-storage` and
`subagent-linking` requirements that the V2 `parentID` mapping feeds. This is
not a new capability: the column, migration, and view contract are defined
upstream, and the change only wires the adapter's `parentID` through to them.

### 6. Dependency and bundling

**Decision:** Add `@opencode/plugin` at the exact version `2.2.5` to
`dependencies`, remove `@opencode-ai/plugin`, and build with
`--external @opencode/plugin`. Add a runtime compatibility check in `setup()`
that logs an actionable error and returns a no-op cleanup when the resolved
package is outside the supported range.

**Rationale:** `Plugin` is a value import, so the package must resolve at
runtime. Pinning matches the targeted OpenCode release and avoids pre-release
drift. Bundling the package would pull `effect` and six other packages into
`dist`. The runtime check exists because a version mismatch otherwise fails at
import time, outside the `setup()` error boundary.

**Upgrade procedure:** bump the pin, run the human-gated V2 verification
(tasks 11.4–11.10), and release as a normal minor. Dependabot proposals
touching
`@opencode/plugin` require manual V2 verification before merge, because it is
now a runtime dependency.

**Alternative considered:** declare it as a `peerDependency` range. Rejected
for this release because it changes the install story and needs its own
verification path; recorded here as the candidate for a follow-up change.

### 7. Setup failure isolation

**Decision:** Wrap initialization (directory, database, config, pricing sync)
in `setup()` with a try/catch that logs via `console.error()` and returns a
no-op cleanup function. On failure the event subscription is not started. The
event loop is also wrapped so an unexpected stream error logs, backs off, and
retries a bounded number of times before a terminal stop.

**Rationale:** The spec requires that no internal error escape to OpenCode. A
throwing `setup()` is the remaining path that could surface. Initialization is
extracted into a single helper so the try/catch has exactly one entry point and
the caches are created once per successful setup.

### 8. Testing strategy and coverage
**Decision:** Test at three levels, with a numeric target and a CI ratchet.

- **Unit**: adapter mapping (`createSDKAdapter`), message translation, extractor
  project precedence, snapshot-union `files_changed`, writer upserts.
- **Integration**: `handleSessionIdle` against a temporary database created by
  `initDatabase(tempDir)`, covering DB-write failure, SDK-query failure, and
  measurement-delta consistency across two idle events.
- **Entry-point integration**: `setup(fakeCtx)` with a sandboxed
  `XDG_DATA_HOME` (fresh `mkdtemp`, restored after each test) and a
  controllable async generator for `event.subscribe`. Covers idle filtering,
  non-status filtering, error isolation, bounded resubscription, cleanup abort,
  abort-not-logged, and init-failure returning a no-op cleanup.
- **Manual (human-gated)**: only what genuinely needs a real OpenCode process —
  plugin appears in the active plugin list, console capture location, and a
  live reload. Everything else previously listed as manual is covered above.

**Coverage target**: 80% line coverage for the project, with a per-file floor of
80% for `src/index.ts` and `src/extractor.ts` (the two files this change
rewrites). Enforcement mechanism: the test step emits an lcov report,
`scripts/coverage-gate.ts` reads it, enforces the project total and the two
per-file floors, prints the measured values, and exits non-zero on regression.
The baseline is recorded in `evidence.md` §4 and summarized in the PR
description. `design.md` §8 replaces the previous "test inventory" so
Constitution IV's coverage-strategy requirement is met.

**Fixture contract for the subscription loop** (needed to make
abort-not-logged testable): `setup` accepts optional injected
`{ sleep, retryBaseDelayMs, maxSubscribeAttempts, pluginVersion }` so tests run
without real waiting, can observe the delay ladder, and can force a version
mismatch. The fake generator receives the controller's actual
`signal`; after `abort()` it throws a `DOMException("aborted", "AbortError")`
on the next `next()` call. Tests assert (a) the signal passed to `subscribe`
reports `aborted === false` before cleanup and `aborted === true` immediately
after, (b) the loop settles without hanging, (c) `console.error` was not
called, (d) a non-abort error from the same generator *is* logged (positive
control), and (e) an error whose name/message is `AbortError` while
`signal.aborted === false` *is* logged — proving detection is by signal state,
not message text.

**Retry tests** use the injected `sleep` (records the delay, does not wait) and
assert: a stream that fails on every attempt produces three attempt-failure
lines, two resubscribe lines, and one terminal-stop line at error level, then
exits; the recorded delay sequence is `[500, 1000]`; with
`retryBaseDelayMs = 6000` the recorded sequence is `[6000, 8000]`, proving the
cap; a successful subscription followed by a failure resets the attempt budget;
and a generator that `return`s produces the completion line without calling
`console.error`.

**Isolation rule**: no test may read or write the developer's real
`~/.local/share/opencode-metrics`. Entry-point tests MUST set `XDG_DATA_HOME`
to a temporary directory. This also fixes a pre-existing leak in the V1
entry-point tests.

### 9. Version policy: 0.5.0 for a breaking release

**Decision:** Ship the breaking migration as `0.5.0`, produced by
release-please from a `feat!:` commit under `bump-minor-pre-major: true`.

**Rationale:** The constitution requires a MAJOR bump for breaking changes to
public APIs, artifact schemas, or analysis behavior. On a pre-1.0 line the
established convention (encoded in `release-please-config.json`) is that a
breaking change bumps MINOR, and `1.0.0` is reserved as the compatibility
commitment. This is an explicit interpretation of the rule for 0.x, recorded
here so it is a decision rather than an oversight. Enforcing the constitution's
literal wording below 1.0 would require a separate constitution amendment.

**Accepted consequences:** consumers pinned to `^0.x` may auto-upgrade into a
V1-incompatible release. Mitigations: the README upgrade section leads with
the host requirement, `0.4.x` stays installable, and the post-publish
deprecation notice directs V1 hosts to pin.

## Risks / Trade-offs

- **Upstream diff statistics.** V2 does not populate the session diff summary
  for new sessions, and the plugin context does not expose `session.diff`.
  Accepted: `files_changed` comes from snapshots and line counts stay 0 until
  upstream restores the data. Measurements are recorded in `evidence.md`.
- **Message shape drift.** V2 message content is a typed union that may gain
  variants. The adapter ignores unknown content types rather than failing, and
  a scenario covers it.
- **Agent/model semantics.** Using the session's current `agent`/`model`
  instead of the first user message can change classification for sessions
  that switch agents mid-session. This is a documented requirement
  (`metrics-collection` "Agent and model provenance" and the
  `session-classification` delta), not only a risk.
- **Console capture.** The plugin relies on the server capturing console
  output. Verified by tasks 11.3 and 11.6; if it does not, user verification
  falls back to
  a database query and the docs already lead with that.
- **Version coupling.** `@opencode/plugin@2.2.5` must stay compatible with the
  targeted OpenCode release. The version is pinned, not ranged; a runtime
  check makes a mismatch diagnosable instead of mysterious.
- **Setup isolation.** If the runtime treats a rejected `setup()` as fatal,
  the try/catch is what prevents an OpenCode startup failure. Covered by a
  test.
- **Collection loss window.** Sessions started between the V1 plugin stopping
  and the V2 plugin starting are not captured, and `scripts/backfill.ts` cannot
  recover post-2026-10-30 sessions. The upgrade note in README states the
  window and that backfill does not close it.
- **Historical misattribution.** Rows written before this change keep their
  original `project_id`. Project-level totals will shift for new sessions
  without historical correction; documented in the upgrade note.
