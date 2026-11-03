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

Implements `specs/metrics-collection/spec.md`, `specs/metrics-storage/spec.md`,
`specs/ci-release/spec.md`, `specs/user-documentation/spec.md`,
`specs/session-classification/spec.md`, and `specs/historical-backfill/spec.md`.
See `design.md` §4–§9 for the mapping, version policy, and test strategy.

## 1. Dependency and Build Manifest

Keep the V1 dependency until the import is gone (group 5) so the tree stays
buildable at every step.

- [x] 1.1 In `package.json`: add `@opencode/plugin` at exact version `2.2.5` to `dependencies`, add `--external @opencode/plugin` to the `build` script, and leave `@opencode-ai/plugin` in place until group 5
- [x] 1.2 [P] Update the `Makefile` `build` target to pass `--external @opencode/plugin`
- [x] 1.3 Run `bun install` and commit the resulting `bun.lock` diff (this is the integrity record for the new dependency)
- [x] 1.4 Confirm the lockfile resolves exactly `@opencode/plugin@2.2.5` and record the resolved version in the PR description

## 2. Data Model and Catalog

- [x] 2.1 Add `projectDirectory?: string` to `SessionInfo` in `src/extractor.ts`
- [x] 2.2 Add `snapshotFiles?: string[]` to `MessageInfo` in `src/extractor.ts`
- [x] 2.3 Resolve `projectId` as `session.projectID ?? project?.id ?? "unknown"`
- [x] 2.4 Resolve the project path as `session.projectDirectory ?? project?.path`, ignoring a non-absolute `projectDirectory`
- [x] 2.5 Use the resolved path for `repoContext` artifact resolution
- [x] 2.6 Derive `filesChanged` as the distinct union of `snapshotFiles` across assistant messages (repo-relative, POSIX separators); leave `linesAdded`/`linesDeleted` at 0
- [x] 2.7 Add extractor tests for session-first precedence, absolute-path validation, instance fallback, snapshot union (including overlapping paths), and empty snapshots
- [x] 2.8 Confirm existing extractor tests still pass
- [x] 2.9 Update `METRIC_DEFINITIONS` descriptions in `src/db.ts` per the `metrics-storage` catalog table, keeping metric names/units/aggregation identical
- [x] 2.10 Change catalog seeding to upsert descriptions on `metric_name` conflict, and add a `db.test.ts` case asserting an existing v4 database receives the updated `lines_added` description

## 3. V2 SDK Adapter

- [x] 3.1 Change `createSDKAdapter` to accept the V2 plugin context
- [x] 3.2 Map `session.get` from `ctx.session.get({ sessionID })` without loading or caching messages; map `parentID`, `projectID`, `title`, `time.created`, `time.updated`, `agent`, `model`
- [x] 3.3 Map `session.messages` from `ctx.session.context({ sessionID })`, translating `type` to `role` and filtering to `user` and `assistant`
- [x] 3.4 Map user `text` to a single text part
- [x] 3.5 Map assistant `content[]` text and tool entries; use tool `name`, `state.input`, and flattened `state.content` text joined with newlines
- [x] 3.6 Populate `projectDirectory` from `session.location.directory` and `snapshotFiles` from each assistant `snapshot.files`
- [x] 3.7 Implement `project.current()` from `ctx.location` (id and `project.canonical` path) as the fallback only
- [x] 3.8 Implement `app.log` at warn level via `console.warn` so the extractor warning path keeps its severity
- [x] 3.9 Skip unknown content variants and absent tool content instead of throwing (produce `""` for empty tool output)

## 4. Plugin Entry Point and Lifecycle

- [x] 4.1 Replace the default plugin function with `Plugin.define({ id: "opencode-metrics", setup(ctx) })`
- [x] 4.2 Extract shared initialization (database, config, pricing sync, caches) into a helper used by `setup` (see `design.md` §7)
- [x] 4.3 Wrap initialization in a try/catch that logs via `console.error`, does not start the subscription, and returns a no-op cleanup
- [x] 4.4 Replace the `Hooks.event` callback with a background `ctx.event.subscribe({ types: ["session.status"], signal })` loop that awaits each event before consuming the next
- [x] 4.5 Read `event.data.sessionID` and `event.data.status.type`; keep the idle filter and validate the payload shape before use
- [x] 4.6 Wrap the subscription loop in a try/catch that logs stream errors, makes at most three subscribe attempts (two resubscriptions) with a doubling backoff, and logs a terminal-stop line distinguishable from normal completion
- [x] 4.7 Return `() => controller.abort()` from `setup` as the cleanup function
- [x] 4.8 Replace every `client.app.log` call with `console.info` / `console.warn` / `console.error`, keeping the `[opencode-metrics]` prefix and logging metadata only
- [x] 4.9 Keep `handleSessionIdle` and its classification caches unchanged
- [x] 4.10 Accept optional injected `{ sleep, retryBaseDelayMs, maxSubscribeAttempts, pluginVersion }` in `setup`, and implement the `>=2.2.5 <3.0.0` version check (log + no-op cleanup + no subscription on mismatch). Read the runtime version from a single helper used by both `setup` and `scripts/check.sh`; the helper MUST accept an injectable resolution root (default: the module's own directory) so tests and `check.sh` can point it at a fixture tree. Prereleases outside the range count as out-of-range

## 5. Remove the V1 Dependency

Sequential by definition — this is the point where the tree stops importing
`@opencode-ai/plugin`.

- [x] 5.1 Confirm no file imports `@opencode-ai/plugin`
- [x] 5.2 Remove `@opencode-ai/plugin` from `devDependencies` in `package.json`
- [x] 5.3 Run `bun install` and commit the lockfile update
- [x] 5.4 Run `bun build` and confirm `dist/index.js` contains no bundled `@opencode/plugin` or `effect`
- [x] 5.5 Add a CI assertion in `.github/workflows/ci_checks.yml` that fails the build if `dist/index.js` resolves `@opencode/plugin` or `effect`

## 6. Loaders, Install, and Diagnostics

- [x] 6.1 Move the local loader to `.opencode/plugins/opencode-metrics/index.ts` with a default export (matching the install layout)
- [x] 6.2 Update the `make install` target to emit a directory (`~/.config/opencode/plugins/opencode-metrics/index.ts`) with a default export, removing any legacy `opencode-metrics.ts` first
- [x] 6.3 Make `make install` idempotent and set permissions explicitly (directory `0o755`, file `0o644`)
- [x] 6.4 Add a `make uninstall` target that removes both the legacy file and the directory loader
- [x] 6.5 Update the install target's printed instructions to reference adding the directory to the `plugins` array and to mention `make uninstall`
- [x] 6.6 Update `scripts/check.sh` loader detection: accept default-export files and directories, report a legacy named-export file as a migration warning, and surface the resolved `@opencode/plugin` version (flag a guard-rejected version as FAIL)
- [x] 6.7 Update `scripts/check.sh` log matching to the `console.*` output shape produced by OpenCode 2.2.5 (validated in task 11.3), and derive `LOG_DIR` from the same XDG logic as `DATA_DIR`
- [x] 6.8 Add a `scripts/check.sh` check that the plugin is present in the project's `opencode.json` `plugins` list

## 7. Project Context

- [x] 7.1 Update `openspec/config.yaml`: `Plugin API: @opencode/plugin` (V2 `Plugin.define`, `ctx.event.subscribe`, context domain methods, no logging API), and fix the `opencode.json` key wording to `plugins`

## 8. Tests

- [x] 8.0 Preserve the `handleSessionIdle` suite and the `makeClient` factory in `src/index.test.ts`; map every deleted V1 test to the delta scenario it covered
- [x] 8.1 Rewrite `src/index.test.ts` adapter tests with V2 `Session.Info` and `Session.Message.Info` fixtures
- [x] 8.2 Add adapter tests for user text mapping, assistant text/tool mapping, output flattening, empty tool content, unknown content variants, and marker/synthetic filtering
- [x] 8.3 Add an adapter test proving cost and tokens come from `session.get` without loading messages
- [x] 8.4 Add adapter tests for `parentID` present and absent, and for `project.current()` fallback
- [x] 8.5 Replace V1 entry-point tests with a fake context whose `event.subscribe` returns a controllable async generator that receives the controller's signal
- [x] 8.6 Test idle filtering, non-status event filtering, malformed payload skipping, and error isolation inside the loop
- [x] 8.7 Test sequential handling: an instrumented generator asserts the second event is consumed only after the first handler settles, and `SUM(measurement_deltas.delta)` equals the cumulative value
- [x] 8.8 Test resubscription with the injected recording `sleep`: a stream failing on every attempt produces three attempt-failure lines, two resubscribe lines, and one terminal-stop line, then exits; assert the delay sequence `[500, 1000]`, and with `retryBaseDelayMs = 6000` assert `[6000, 8000]` (cap); assert a successful subscription resets the attempt budget; and assert normal iterator completion logs the completion line without `console.error`
- [x] 8.9 Test that cleanup aborts the signal, does not log the abort as an error, and that a non-abort error *is* logged; include the case where an error is named `AbortError` while `signal.aborted === false` (must be logged)
- [x] 8.10 Test that cleanup during an in-flight capture leaves no partial session row and no orphan `measurement_deltas` entry
- [x] 8.11 Test that initialization failure returns a no-op cleanup, logs via console, and does not subscribe; induce failure deterministically by pointing `XDG_DATA_HOME` beneath a regular file (e.g. `$(mktemp -d)/blocker/nested` where `blocker` is a file) so recursive `mkdir` fails with `ENOTDIR`
- [x] 8.12 Test DB-write failure and SDK-query failure: `console.error` called, no rejection escapes, and a later idle event still persists
- [x] 8.13 Test the end-to-end capture path with a fake context and sandboxed `XDG_DATA_HOME`: sessions, projects, measurements and `measurement_deltas` rows; then a second idle event updates cumulatively
- [x] 8.14 Test agent/model provenance: first user message carries `agent: "plan"`, current selection is `build` / `anthropic/x`, a rule matches `agent: build` — assert stored agent/model and the resulting classification
- [x] 8.15 Test the version guard with an injected out-of-range `pluginVersion`: `console.error` names the supported range, cleanup is a no-op, `event.subscribe` was not called
- [x] 8.16 Test log-content restriction: a failing capture whose tool output contains a marker string never passes that string to `console.*`
- [x] 8.17 Test first-time initialization permissions (`0o755`/`0o644`) under a fixed `process.umask()` that is restored afterwards
- [x] 8.18 Add `XDG_DATA_HOME` sandboxing (`mkdtemp` + restore) to every entry-point test; no test may touch the real data directory
- [x] 8.19 Run `bun test` and confirm all suites pass, including unchanged modules
- [x] 8.20 Add `scripts/coverage-gate.ts` (reads the coverage report, enforces a project total of 80% and an 80% per-file floor for `src/index.ts` and `src/extractor.ts`, prints measured values, exits non-zero on regression), wire it into `.github/workflows/ci_checks.yml`, and record the pre-change baseline in `evidence.md` §4
- [x] 8.21 Test the version resolver against a fixture tree passed as the helper's resolution root: `2.2.4` (fail), `2.2.5` (pass, inclusive lower bound), `3.0.0` (fail, exclusive upper bound), `3.0.0-rc.1` (fail), missing, and unparseable; assert the parsed version and that `setup` with that same root does not subscribe for the failing and unreadable cases (`event.subscribe` never called)

## 9. Documentation

README tasks are ordered; the `QUICK_START.md` rewrite (9.11) follows them,
with only the README-only wording normalization parallelized.

- [x] 9.1 Update the README prerequisite from V1 to OpenCode V2 (2.2+)
- [x] 9.2 Update the README install examples for the published package and local-directory loading, including that a local checkout needs runtime dependencies installed
- [x] 9.3 Document the session diff limitation inline at the metric reference rows (`lines_added`/`lines_deleted`), the "Lines changed over time" query, and the code-impact guidance
- [x] 9.4 Document that V1 users must pin the previous line, naming `0.4.x` explicitly, with the pin command
- [x] 9.5 Rewrite the README upgrade section: host requirement first, pin/rollback, three behavior changes, what stops being populated, and that historical rows are not re-attributed
- [x] 9.6 Add the README migration guide (audience, prerequisites, ordered steps, verification, rollback)
- [x] 9.7 Update the README troubleshooting section for the V2 failure modes: unsupported host, loader present but not registering, nothing collected after upgrade, and missing console log lines
- [x] 9.8 Update the README verification section to lead with a database query and treat the log line as secondary
- [x] 9.9 Add the backfill coverage caveat to README and state that `make backfill` does not close the V2-era gap
- [x] 9.10 Refresh the README verification output expectations (table list, `PRAGMA user_version`) while the section is open
- [x] 9.11 Update `QUICK_START.md`: host prerequisite, directory loader path, remove the "restart to activate" guidance, add the code-impact zero-baseline caveat, add the backfill coverage caveat, and correct the expected backfill output
- [x] 9.12 [P] Normalize `plugins` (not `plugin`) in `README.md` only (`QUICK_START.md` is covered by 9.11)
- [x] 9.13 Update the README Uninstalling section: remove the loader entry, remove a locally installed loader directory, and reference `make uninstall`
- [x] 9.14 Refresh the README metric reference table from the updated `METRIC_DEFINITIONS` so it matches the catalog, including `cost` (own session only), `files_changed` (assistant snapshots), `messages_total` (conversation messages), and the line-count limitation

## 10. Release

- [x] 10.1 [P] Draft `release-notes.md` in this change with sections: breaking changes (host + plugin API), changed (project attribution, agent/model provenance, `files_changed` source), known limitations (line counts 0, backfill gap, write gap), and upgrade notes
- [ ] 10.2 Do NOT hand-edit `CHANGELOG.md`, `package.json` version, or `.release-please-manifest.json`; release-please owns them
- [ ] 10.3 Land the change with a breaking-change marker (`feat!:` subject or a `BREAKING CHANGE:` footer) so release-please emits a breaking section and bumps 0.4.1 to 0.5.0 via `bump-minor-pre-major`
- [ ] 10.4 Verify the release-please PR: version is 0.5.0, the changelog contains a breaking-changes section, and `package.json` matches `.release-please-manifest.json`
- [ ] 10.5 Reconcile the generated release PR body against `release-notes.md` and add the hand-written upgrade section to the GitHub Release
- [ ] 10.6 Fold the stale `## [Unreleased] (2026-09-18)` entries in `CHANGELOG.md` into their released sections in a dedicated `docs:` commit (the one-time remediation exception in the `ci-release` delta); delete nothing
- [ ] 10.7 Confirm the automated gate ran during the real release: record the 10.12 script output and the resulting dist-tags (`latest` unchanged until promotion) in `evidence.md`
- [ ] 10.8 After promoting, add the 0.4.x deprecation notice directing V1 hosts to pin `0.4.1`
- [ ] 10.9 [P] Open the `ansible-role-ai` change re-enabling the plugin with an explicit `0.5.x` pin, plus a version/OpenCode-compatibility note in the README ansible sections
- [x] 10.10 Record the rollback procedure (move `latest` back, deprecate the broken version, publish a patch, and recover a release whose artifact failed verification) in the README release section, referenced from `release-notes.md`
- [x] 10.11 Change the `publish` job in `.github/workflows/ci_release.yml` and the publish step in `.github/workflows/ci_publish.yml` to publish with a non-`latest` dist-tag
- [x] 10.12 Add `scripts/verify-published-artifact.sh <version>`: unpack the published tarball into a fresh `mktemp -d` project and `npm install --omit=dev` there; assert (1) the installed package's `package.json` lists `@opencode/plugin` in `dependencies`, (2) `import('@opencode/plugin')` succeeds from that install tree, and (3) `dist/index.js` exists and, imported as an ES module from that tree, its default export is an object (not a function) with `id === "opencode-metrics"` and `typeof setup === "function"`. A textual search of the bundle SHALL NOT satisfy this step. If `setup` is invoked, use a stub `ctx` (`event.subscribe` returns an empty async generator, other members are recording no-ops) under a sandboxed `XDG_DATA_HOME`, and report setup failure distinctly from registration failure. Exit non-zero on any failed assertion; call it as a blocking step in both publish paths
- [x] 10.13 Add a promotion step that asserts `latest` is unchanged after publish and moves it only after 10.12 passes; record the script invocation in `evidence.md`

## 11. Verification

### Automated (completes without a human)

- [x] 11.1 Run `make build`, `make test`, and `make lint` (CI parity)
- [x] 11.2 Run `make check` against a local install and confirm it reports PASS for the V2 loader layout
- [ ] 11.3 Confirm the `console.*` line shape emitted by the plugin matches the `scripts/check.sh` pattern; record the observed shape in `evidence.md` §3

### Evidence recording (human-gated, reproducible artifacts required)

- [ ] 11.4 Record `evidence.md` §1, §2, and §6: the V2 session-diff query (against `session_v2`), the legacy/V2 table cutoff check, and proof that the resolved plugin-API package version is readable from the location the runtime guard reads it (with dates and OpenCode version)
- [ ] 11.5 Record `evidence.md` §5: compare `Session.Info.cost`/`tokens` for a parent session with and without a sub-agent; if the values include children, re-scope the `Automatic Metrics Capture` cost requirement before release

### Human-gated (change is not Done until a human records the evidence)

- [ ] 11.6 Start OpenCode 2.2.5 in this repository and confirm the plugin appears in the active plugin list and logs initialization; record the log file/stream in `evidence.md` §3
- [ ] 11.7 Complete a prompt/response cycle and confirm a new session row with cost and tokens (paste the row into `evidence.md`)
- [ ] 11.8 Confirm a sub-agent session records `parent_session_id`
- [ ] 11.9 Confirm `files_changed` is populated and line counts are 0
- [ ] 11.10 Confirm a session in another project is attributed to that project
- [ ] 11.11 Reload or remove the plugin and confirm the subscription aborts without an error log line
- [ ] 11.12 Confirm a V1 host attempting to load `0.5.0` fails to load while OpenCode still starts
- [ ] 11.13 Human merges the release PR and publishes the release; this is outside agent scope and is the boundary between the automated pipeline and release

## 12. Governance

- [x] 12.1 Verify constitution alignment against `proposal.md` §Constitution Alignment, including Principle V (Security by Default)

## Out of Scope

- Recovering the V2-era backfill gap (no tracking change filed yet).
- Retroactively re-attributing historical session rows.
- A `peerDependencies` install model for `@opencode/plugin` (candidate follow-up).
- V1 compatibility or a dual entrypoint.
- A maintenance branch and release-please target for future `0.4.x` patches; `0.4.x` receives no further planned releases beyond a critical fix.

<!-- spec-review: passed -->

<!-- code-review: passed -->
