# Evidence Log

Reproducible observations backing claims made in `proposal.md` and
`design.md`. Recorded on 2026-11-03 against OpenCode 2.2.5
(`opencode --version`) on this host.

## 1. Session diff data exists upstream but is not exposed to plugins

**Claim**: `lines_added`/`lines_deleted` are recorded as 0 because the V2
plugin context does not expose session diff data.

**Type-level fact (authoritative)**: `@opencode/plugin@2.2.5`'s `SessionDomain`
is `Pick<SessionApi, "list" | "create" | "get" | "remove" | "switchAgent" |
"switchModel" | "prompt" | "generate" | "command" | "compact" | "synthetic" |
"interrupt" | "update" | "move" | "context">`. `SessionApi.diff` exists on the
raw client but is **not** in that pick, and `ctx` exposes no raw client.

**Data check** — the summary columns *are* populated upstream, which is why
the limitation is about API exposure, not missing data:

```sql
SELECT COUNT(*) AS total,
       SUM(CASE WHEN summary_files IS NULL THEN 1 ELSE 0 END) AS null_summary_files
FROM session_v2;
```

**Recorded**:

- Date: 2026-11-03
- OpenCode version: 2.2.5
- Output: `total = 1918`, `null_summary_files = 257`
- Interpretation: ~87% of V2 sessions carry a diff summary in OpenCode's own
  database, but the plugin API cannot read it. Revisit if upstream adds `diff`
  to `SessionDomain`.

## 2. Legacy tables stop before the V2 era

**Claim**: `scripts/backfill.ts` (legacy tables) cannot import recent
sessions.

**Query**:

```sql
SELECT MAX(time_created) FROM session;         -- legacy table (epoch ms)
SELECT COUNT(*) FROM session_v2;               -- V2 table
```

**Recorded**:

- Date: 2026-11-03
- `MAX(time_created)` legacy: `1793279026040` (2026-10-29)
- `session_v2` row count: `1918`
- Metrics DB sessions at the same time: `1672`
- Note: these are different populations (the metrics DB also holds
  backfilled legacy sessions), so the difference is an upper bound on the
  uncollected V2-era set, not an exact gap.

## 3. Plugin log output is NOT captured in OpenCode's log directory

**Claim**: `console.*` output from a plugin reaches the operator somehow.

**Procedure**: restarted OpenCode 2.2.5 with the plugin loaded and ran a
session, then searched the log directory.

**Recorded**:

- Date: 2026-11-03
- `msg="loading plugin" id=…/.opencode/plugins/opencode-metrics.ts` appears in
  `~/.local/share/opencode/log/opencode.log` — the plugin loads.
- `grep "[opencode-metrics]" ~/.local/share/opencode/log/*.log` returns
  **no lines from 2026-11-03**; the newest match is `2026-10-29`, i.e. from
  the V1 `client.app.log` implementation.
- Conclusion: on 2.2.5, plugin `console.*` output goes to the server process
  stdout/TUI, **not** to `~/.local/share/opencode/log/`. Consequences applied:
  `scripts/check.sh` now flags a stale log section, and the README leads
  verification with a database query.

## 4. Coverage baseline

**Command**: `make test` (the gate runs `scripts/coverage-gate.ts` when lcov is
produced in CI).

**Recorded** 2026-11-03:

- Overall `src/` line coverage: 96.6%
- `src/index.ts`: 97.9%
- `src/extractor.ts`: 99.1%
- Tests: 325 pass / 0 fail / 865 assertions

## 5. Cost and tokens are the session's own values, excluding children

**Claim**: `Session.Info.cost`/`tokens` exclude sub-agent sessions, so
recursive aggregation does not double-count.

**Query** (a session with non-zero cost and many children):

```sql
SELECT id, parent_id, cost FROM session_v2
WHERE id = '<parent>' OR parent_id = '<parent>';
SELECT SUM(cost), COUNT(*) FROM session_v2 WHERE parent_id = '<parent>';
```

**Recorded** 2026-11-03 for parent `ses_e5f3bc8f7ffeg7RBQTM1gUR14L`:

- Parent `cost`: `79.1541`
- Sum of 39 children: `69.4879`
- Verdict: **exclusive**. A tree-inclusive parent would be ≈148.6; it is
  79.15, so the parent reports only its own cost. Recursive views
  (79.15 + 69.49 = 148.64) are therefore correct.
- Caveat: some providers report `cost = 0` (observed on `enmaas` sessions,
  e.g. this change's own session tree), so cost is provider-dependent. That is
  upstream behavior, unchanged by this port.

## 6. The plugin API version is readable at runtime

**Claim**: `setup()` can determine the resolved `@opencode/plugin` version with
the package marked external in `dist`.

**Procedure**:

```bash
bun src/version.ts --root .
```

**Recorded** 2026-11-03:

- Resolution method: read the resolved package's `package.json` from the
  module's own directory (injectable root).
- Resolved version: `2.2.5`
- Works from the built bundle with the package external: yes (`make check`
  reports `PASS Plugin API version: 2.2.5`).

## 7. Live capture verification (2026-11-03)

Plugin loaded via the project-local loader; one session plus one delegated
sub-agent:

| session | parent | classification | files_changed | lines_added |
|---|---|---|---|---|
| `ses_e5f0017bbffe…` | — | openspec-workflow | 39 | 0 |
| `ses_e5dcdee59ffe…` | `ses_e5f0017bbffe…` | multi-agent | 15 | 0 |

- Session count in `metrics.db` went 1669 → 1672.
- `files_changed` is populated from assistant `snapshot.files`.
- `lines_added` is 0, as specified.
- Sub-agent rows carry `parent_session_id`.
- Classification runs on the live path.
- Cross-project attribution and the V1-host behavior are recorded in §8
  and §9.

## 8. Cross-project attribution (2026-11-06, task 11.10)

**Claim**: a session started in another project is stored under that
project's id and worktree, not under the plugin repository.

**Query**:

```sql
SELECT s.session_id, s.project_id, p.name, p.worktree
FROM sessions s JOIN projects p ON p.project_id = s.project_id
WHERE p.worktree NOT LIKE '%opencode-metrics%'
ORDER BY s.started_at DESC LIMIT 5;
```

**Recorded**:

- Session `ses_e4f3b4448ffe5HFObQFIRWPr4f`
- Metrics DB project: id `bca8c24f1305ed5b92e80b88bbe405e4c41db7e7`,
  name `complyctl`, worktree `/home/maburgha/GIT/ProdSec/complyctl`
- OpenCode source `session_v2` row: same id, directory
  `/home/maburgha/GIT/ProdSec/complyctl`, same project id
- Interpretation: attribution follows the session's own project, not the
  directory where the plugin process was launched.

## 9. Real-release gate and promotion (2026-11-06, tasks 10.7 and 11.13)

**Release**: `v0.5.1` (0.5.0 was tagged but never published to npm).

- Release PR #11 was merged by a human; release-please created `v0.5.1`.
- Run `42215758640` (`CI Release`): OIDC publish succeeded; `Verify publish`
  passed; `Verify published artifact` failed because `npm pack` ran before the
  tarball propagated. `latest` remained `0.4.1` (promotion never ran).
- Fix landed in `75c1cf0`: the verification script retries `npm pack`, and
  both publish workflows skip publishing when the version already exists.
- Recovery run `42218338914` (`CI Publish`, `tag=v0.5.1`): publish step
  skipped, `Verify published artifact` passed, `latest` unchanged assertion
  passed, promotion passed.
- Local reproduction of the blocking gate:

  ```text
  $ bash scripts/verify-published-artifact.sh 0.5.1
  PASS published package.json declares @opencode/plugin@2.2.5
  PASS @opencode/plugin resolves and exports Plugin.define
  PASS dist/index.js default-exports { id: "opencode-metrics", setup: [function] }
  PASS setup runs against a stub context and creates the metrics database
  Verified @mburghardt/opencode-metrics@0.5.1
  ```

- Dist-tags before recovery: `latest = 0.4.1`, `next = 0.5.1`
- Dist-tags after recovery: `latest = 0.5.1`, `next = 0.5.1`
- Not exercised: loading the V2-only package on an OpenCode V1 host
  (task 11.12); no V1 CLI build is published on npm for a reproducible test.
