# Design

## Context

The plugin uses a deliberate adapter pattern (`createSDKAdapter`) that maps the
OpenCode SDK client to a local `SDKClient` interface. All data processing
modules (`extractor.ts`, `classifier.ts`, `config.ts`, `db.ts`, `writer.ts`,
`artifacts.ts`, `pricing.ts`) operate exclusively on this local interface.
Only `src/index.ts` touches the SDK directly.

See proposal.md for motivation. Verified against `@opencode/plugin@2.2.5` and
the OpenAPI document served by OpenCode 2.2.5, the V2 plugin API differs from
V1 as follows:

- `@opencode-ai/plugin` (V1) -> `@opencode/plugin` (V2)
- `Plugin` function -> `Plugin.define({ id, setup(ctx) })`
- `PluginInput.client` -> domain methods on the plugin context
- `Hooks.event` callback -> `ctx.event.subscribe()` async iterable
- `input.project` / `input.directory` -> `ctx.location.project` /
  `ctx.location.directory`
- event payloads live on `event.data`, not `event.properties`
- `client.app.log` -> `console.*` (the V2 `ctx.app` exposes only `name`,
  `version`, `channel`)

## Goals / Non-Goals

**Goals:**

- Port the plugin to compile and run under OpenCode V2 (2.2.x).
- Preserve the `SDKClient` adapter boundary so the data pipeline stays
  independently testable.
- Maintain existing metrics collection, classification, and storage behavior,
  with the two documented exceptions (per-session project attribution, session
  diff statistics).
- Keep the cleanup mechanism (abort the event subscription on plugin unload).

**Non-Goals:**

- Adding new V2-only features (tools, commands, transforms, websearch, etc.).
- Changing the SQLite schema, metric definitions, or classification logic.
- Changing the `bun:sqlite` runtime dependency.
- Supporting V1 and V2 simultaneously.
- Recovering the post-upgrade backfill gap (tracked in `backfill-v2-source`).

## Decisions

### 1. Rewrite scope: `src/index.ts` plus a narrow `src/extractor.ts` change

**Decision:** Rewrite `createSDKAdapter()` and the plugin entry point in
`src/index.ts`. In `src/extractor.ts`, add `projectDirectory` to `SessionInfo`
and change project resolution to prefer session-level data over
`project.current()`.

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
async loop. Treat `event.data.status.type === "idle"` as the capture trigger
and read the session ID from `event.data.sessionID`. Return `() =>
controller.abort()` from `setup()` as the cleanup function.

**Rationale:** `session.status` preserves current behavior exactly (V1 also
used idle transitions), and the `types` filter avoids decoding every event.
V2 also emits `session.idle`, but switching to it would be an unnecessary
behavior change. The abort pattern is the documented V2 cleanup mechanism.

**Alternative considered:** `session.idle`. Rejected for behavior parity; it
carries only `sessionID` and does not express busy/retry transitions.

### 3. Logging: console methods

**Decision:** Replace `client.app.log({ body: { service, level, message } })`
with `console.info()`, `console.warn()`, and `console.error()`, keeping the
`[opencode-metrics]` prefix.

**Rationale:** `ctx.app` exposes no logging method. Console output is captured
by the server process log. The exact capture behavior is verified during the
manual V2 test rather than assumed.

### 4. SDK adapter: map the V2 context onto the unchanged `SDKClient` output

**Decision:** `createSDKAdapter(ctx)` maps:

| `SDKClient` member | V2 source | Mapping |
| --- | --- | --- |
| `session.get(id)` | `ctx.session.get({ sessionID: id })` | `cost` and `tokens.*` are already aggregated; `agent`, `model`, `title`, `parentID`, `projectID`, `time.created`, `time.updated` map directly. `agent`/`model` now reflect the session's current selection instead of the first user message. |
| `session.messages(id)` | `ctx.session.context({ sessionID: id })` | Translate V2 message shapes (below). |
| `project.current()` | `ctx.location` | Fallback only; the extractor prefers the session's own project data. |
| `app.log(message)` | `console.info` | Keeps the extractor's warning path unchanged. |

Message translation:

- `Session.Message.Info` uses `type`, not `role`; `SDKClient.MessageInfo.role`
  is populated from it.
- User messages carry a single `text` field, not parts. Emit one text part.
- Assistant messages carry `content[]` with `text`, `reasoning`, and `tool`
  entries. Emit `type: "text"` parts from text content (skip reasoning) and
  `type: "tool"` parts from tool content, using `name`, `state.input`, and a
  flattened `state.content`.
- Tool output is `Tool.Content[]`; join `type: "text"` entries with newlines so
  artifact regexes receive a string, as in V1.
- Only `user` and `assistant` messages are returned. V2 also emits markers
  (`session.*.selected`, `idle`) and `synthetic`/`system`/`shell` messages in
  the context; including them would inflate `messages_total` and could make a
  system reminder the "first user message".

Diff statistics:

- `files_changed` = size of the union of `snapshot.files` across assistant
  messages in the session.
- `lines_added` and `lines_deleted` = 0. V2 removed the diff summary from
  `Session.Info`, and `ctx.session` does not expose `session.diff` (the
  `SessionDomain` type is a `Pick` of `SessionApi` that omits it). The
  upstream gap is tracked outside this change.

**Rationale:** This keeps the pipeline contract intact while translating the
shapes that genuinely changed. Removing the aggregation loop is a
simplification enabled by V2, not a behavior change: the same cumulative
numbers now come straight from the session row.

### 5. Per-session project attribution

**Decision:** `SessionInfo` gains `projectDirectory?: string`, sourced from
`session.location.directory`. `extractSessionData()` resolves:

- `projectId = session.projectID ?? project.id ?? "unknown"`
- project path = `session.projectDirectory ?? project.path`

`project.current()` remains the fallback for sessions without location data.

**Rationale:** V2 serves sessions across projects. Preferring the session's own
data prevents cross-project misattribution. `ctx.location.project.canonical`
remains useful as a fallback path for the plugin's own project.

### 6. Dependency and bundling

**Decision:** Add `@opencode/plugin` at the exact version `2.2.5` to
`dependencies`, remove `@opencode-ai/plugin`, and build with
`--external @opencode/plugin`.

**Rationale:** `Plugin` is a value import, so the package must resolve at
runtime. Pinning matches the targeted OpenCode release and avoids pre-release
drift. Bundling the package would pull `effect` and six other packages into
`dist`.

### 7. Setup failure isolation

**Decision:** Wrap initialization (directory, database, config, pricing sync)
in `setup()` with a try/catch that logs via `console.error()` and returns a
no-op cleanup function. The event loop is also wrapped so an unexpected stream
error logs and stops without rejecting into the runtime.

**Rationale:** The spec requires that no internal error escape to OpenCode. A
throwing `setup()` is the remaining path that could surface.

### 8. Testing strategy

**Decision:**

- Keep the `handleSessionIdle` tests and the `SDKClient` mock factory.
- Replace V1 adapter tests with V2 fixtures built from `Session.Info` and
  `Session.Message.Info` shapes, including tool content flattening and marker
  filtering.
- Drive the entry point with a fake context whose `event.subscribe` returns a
  controllable async generator; assert idle filtering, error isolation, and
  that cleanup aborts the signal.
- Add extractor tests for session-level project precedence and fallback.
- Manual verification on OpenCode 2.2.5 with `make build` and the local
  loader.

**Rationale:** The adapter and entry point are the only V2-coupled code, so
they need V2-shaped fixtures. Everything downstream keeps its existing tests.

## Risks / Trade-offs

- **Upstream diff statistics.** V2 does not populate the session diff summary
  for new sessions (`summary_files` is NULL for 164 of 165 observed V2
  sessions), and the plugin context does not expose `session.diff`. Accepted:
  `files_changed` comes from snapshots and line counts stay 0 until upstream
  restores the data.
- **Message shape drift.** V2 message content is a typed union that may gain
  variants. The adapter ignores unknown content types rather than failing.
- **Agent/model semantics.** Using the session's current `agent`/`model`
  instead of the first user message can change classification for sessions
  that switch agents mid-session. Documented in the spec delta.
- **Console capture.** The plugin relies on the server capturing console
  output. If it does not, logs are less visible; the metrics themselves are
  unaffected. Verified manually.
- **Version coupling.** `@opencode/plugin@2.2.5` must stay compatible with the
  targeted OpenCode release. The version is pinned, not ranged.
- **Setup isolation.** If the runtime treats a rejected `setup()` as fatal,
  the try/catch is what prevents an OpenCode startup failure. Covered by a
  test.
