# Tasks

## 1. Dependency and Build

- [ ] 1.1 Remove `@opencode-ai/plugin` from `package.json` devDependencies
- [ ] 1.2 Add `@opencode/plugin` at exact version `2.2.5` to `dependencies` (not devDependencies)
- [ ] 1.3 Update the build script in `package.json` and the `Makefile` build target to pass `--external @opencode/plugin`
- [ ] 1.4 Run `bun install` and confirm the lockfile resolves `@opencode/plugin@2.2.5`
- [ ] 1.5 Run `bun build` and confirm `dist/index.js` does not bundle `@opencode/plugin` or `effect`

## 2. Extractor Project Resolution

- [ ] 2.1 Add `projectDirectory?: string` to `SessionInfo` in `src/extractor.ts`
- [ ] 2.2 Resolve `projectId` as `session.projectID ?? project?.id ?? "unknown"`
- [ ] 2.3 Resolve the project path as `session.projectDirectory ?? project?.path`
- [ ] 2.4 Use the resolved path for `repoContext` artifact resolution
- [ ] 2.5 Add extractor tests for session-first precedence and instance fallback
- [ ] 2.6 Confirm existing extractor tests still pass

## 3. V2 SDK Adapter

- [ ] 3.1 Change `createSDKAdapter` to accept the V2 plugin context
- [ ] 3.2 Map `session.get` from `ctx.session.get({ sessionID })` without re-aggregating cost or tokens
- [ ] 3.3 Map `session.messages` from `ctx.session.context({ sessionID })`, translating `type` to `role` and filtering to `user` and `assistant`
- [ ] 3.4 Map user `text` to a single text part
- [ ] 3.5 Map assistant `content[]` text and tool entries; use tool `name`, `state.input`, and flattened `state.content` text
- [ ] 3.6 Populate `projectDirectory` from `session.location.directory`
- [ ] 3.7 Populate diff stats: `filesChanged` from the union of assistant `snapshot.files`, line counts 0
- [ ] 3.8 Implement `app.log` with `console.info` so the extractor warning path is unchanged
- [ ] 3.9 Remove the V1 HeyAPI response unwrapping and the message cache used only for aggregation

## 4. Plugin Entry Point and Lifecycle

- [ ] 4.1 Replace the default plugin function with `Plugin.define({ id: "opencode-metrics", setup(ctx) })`
- [ ] 4.2 Extract shared initialization (database, config, pricing sync, caches) into a helper used by `setup`
- [ ] 4.3 Wrap initialization in a try/catch that logs via `console.error` and returns a no-op cleanup
- [ ] 4.4 Replace the `Hooks.event` callback with a background `ctx.event.subscribe({ types: ["session.status"], signal })` loop
- [ ] 4.5 Read `event.data.sessionID` and `event.data.status.type`; keep the idle filter
- [ ] 4.6 Wrap the subscription loop in a try/catch that logs stream errors and does not log aborts
- [ ] 4.7 Return `() => controller.abort()` from `setup` as the cleanup function
- [ ] 4.8 Replace every `client.app.log` call with `console.info` / `console.warn` / `console.error`
- [ ] 4.9 Keep `handleSessionIdle` and its classification caches unchanged

## 5. Local Loaders and Install

- [ ] 5.1 Change `.opencode/plugins/opencode-metrics.ts` to a default export
- [ ] 5.2 Update the `make install` target to emit a directory (`~/.config/opencode/plugins/opencode-metrics/index.ts`) with a default export
- [ ] 5.3 Update the install target's printed instructions to reference adding the directory to the `plugins` array
- [ ] 5.4 Verify the local loader loads under OpenCode 2.2.5

## 6. Tests

- [ ] 6.1 Rewrite `src/index.test.ts` adapter tests with V2 `Session.Info` and `Session.Message.Info` fixtures
- [ ] 6.2 Add adapter tests for user text mapping, assistant text/tool mapping, output flattening, and marker filtering
- [ ] 6.3 Add an adapter test proving cost and tokens come from `session.get` without loading messages
- [ ] 6.4 Replace V1 entry-point tests with a fake context whose `event.subscribe` returns a controllable async generator
- [ ] 6.5 Test idle filtering, non-status event filtering, and error isolation inside the loop
- [ ] 6.6 Test that cleanup aborts the signal and that abort is not logged as an error
- [ ] 6.7 Test that initialization failure returns a no-op cleanup and logs via console
- [ ] 6.8 Run `bun test` and confirm all suites pass, including unchanged modules
- [ ] 6.9 Run `bunx biome check .` and fix any lint findings

## 7. Documentation and Release

- [ ] 7.1 Update the README prerequisite from V1 to OpenCode V2 (2.2+)
- [ ] 7.2 Update the README install examples for published and local-directory loading
- [ ] 7.3 Document the session diff limitation (`files_changed` only; line counts 0 until upstream)
- [ ] 7.4 Document that V1 users must stay on the previous release line
- [ ] 7.5 Update `CHANGELOG.md` with the breaking change and bump the version to `0.5.0`
- [ ] 7.6 Confirm the release-please configuration produces the expected major/minor bump for a breaking change
- [ ] 7.7 Add an upgrade note covering the write gap between the V1 plugin stopping and V2 delivery

## 8. Verification

- [ ] 8.1 Run `make build` and start OpenCode 2.2.5 in this repository
- [ ] 8.2 Confirm the plugin appears in the active plugin list and logs initialization
- [ ] 8.3 Complete a prompt/response cycle and confirm a new session row with cost and tokens
- [ ] 8.4 Confirm a sub-agent session records `parent_session_id`
- [ ] 8.5 Confirm `files_changed` is populated and line counts are 0
- [ ] 8.6 Confirm a session in another project is attributed to that project
- [ ] 8.7 Reload or remove the plugin and confirm the subscription aborts without error
