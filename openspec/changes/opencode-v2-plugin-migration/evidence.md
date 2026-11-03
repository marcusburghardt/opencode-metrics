# Evidence Log

Reproducible observations backing claims made in `proposal.md` and
`design.md`. Record the query, the date, the OpenCode version, and the output.
This file replaces unattributed counts in prose.

## 1. V2-era sessions carry no usable diff summary

**Claim**: the V2 plugin API does not expose session diff data, which is why
`lines_added`/`lines_deleted` are recorded as 0.

**Two-part record**:

a) Type-level fact (authoritative): `@opencode/plugin@2.2.5`'s `SessionDomain`
is a `Pick` of `SessionApi` that omits `diff`. Record the declaration excerpt
or link here.

b) Data check against the **V2** tables (not the legacy `session` table):

```sql
SELECT
  COUNT(*)                                              AS total_sessions,
  SUM(CASE WHEN summary_files IS NULL THEN 1 ELSE 0 END) AS null_summary_files
FROM session_v2;
```

**Recorded**: _pending — task 11.4_

- Date:
- OpenCode version:
- Output:
- Also record whether a `session.diff` event is emitted and subscribable in
  2.2.5. If it is, this limitation is avoidable and the change must be
  re-scoped before release.

## 2. Legacy tables stop at 2026-10-30

**Claim**: sessions created after 2026-10-30 exist only in
`session_v2`/`session_message`/`session_part`, so `scripts/backfill.ts`
(legacy tables) cannot import them.

**Query**:

```sql
SELECT MAX(time_created) FROM session;        -- legacy table
SELECT MIN(time_created) FROM session_v2;     -- V2 table
```

**Recorded**: _pending — task 11.4_

- Date:
- Output:
- Sessions stranded in `session_v2` (count):
- Note: this is a distinct measurement from §1. Do not conflate the counts.

## 3. Console output shape and capture location

**Claim**: `console.info/warn/error` output from the plugin is captured by the
OpenCode server process log, and `scripts/check.sh` can match it.

**Procedure**: run tasks 11.3 and 11.6.

**Recorded**: _pending_

- Log file or stream:
- A captured `[opencode-metrics]` line (verbatim):
- Date / OpenCode version:

## 4. Coverage baseline

**Claim**: `.github/workflows/ci_checks.yml` enforces an 80% line-coverage
ratchet via `scripts/coverage-gate.ts`, with an 80% floor for `src/index.ts`
and `src/extractor.ts`.

**Command**: `bun test --coverage` (before the gate is wired in)

**Recorded**: task 8.20 (coverage gate scoped to first-party `src/` files;
`scripts/` is exercised separately)

- Date: 2026-11-03
- Overall line coverage: 96.6% (`src/`, 1331/1378)
- `src/index.ts` line coverage: 97.9% (283/289)
- `src/extractor.ts` line coverage: 99.1% (218/220)

## 5. Cost/tokens exclude sub-agent sessions

**Claim**: `Session.Info.cost` and `Session.Info.tokens.*` are the session's
own values and exclude child sessions, so recursive `v_*` aggregation does not
double-count.

**Procedure**: pick a parent session that spawned at least one sub-agent.
Compare its `Session.Info.cost`/`tokens` against the sum of its own assistant
messages (V1 semantics), and against the recursive total over the session tree.

**Recorded**: _pending — task 11.5_

- Date:
- OpenCode version:
- Parent `Session.Info.cost`:
- Sum of own assistant-message cost:
- Recursive tree total:
- Verdict: exclusive / inclusive

If **inclusive**, the `Automatic Metrics Capture` requirement that cost and
tokens exclude children does not hold and must be changed before release;
otherwise every recursive cost view double-counts.

## 6. The plugin API version is readable at runtime

**Claim**: `setup()` can determine the resolved `@opencode/plugin` version, so
the `>=2.2.5 <3.0.0` guard is implementable when the package is marked
external in `dist`.

**Procedure**: with the package installed and the bundle built, resolve the
version through the single helper used by both `setup` and `scripts/check.sh`
(e.g. reading the resolved package's `package.json`), and record it.

**Recorded**: _pending — task 11.4_

- Date:
- Resolution method used:
- Resolved version:
- Works from `dist/index.js` with the package external: yes / no

If no version is readable, drop the runtime guard to a `check.sh`-only
diagnostic and remove the guard requirement rather than shipping an
unimplementable check.

## 7. Published-artifact gate and `latest` promotion

**Claim**: no release reaches the `latest` dist-tag without an
install-and-load check of the published tarball.

**Invocation** (run in both publish paths, after
`npm publish --access public --tag next` and the registry-visibility poll):

```sh
bash scripts/verify-published-artifact.sh "<version>"
```

The script packs the published version from the registry, installs it with
`npm install --omit=dev` in a fresh `mktemp -d` project, then asserts from
that install tree:

1. the published `package.json` lists `@opencode/plugin` in `dependencies`;
2. `@opencode/plugin` resolves and exports `Plugin.define`;
3. `dist/index.js` default-exports an object with `id === "opencode-metrics"`
   and a callable `setup` (imported as an ES module — a textual search of the
   bundle does not pass);
4. `setup` runs against a stub context under a sandboxed `XDG_DATA_HOME` and
   creates the metrics database.

Before promotion the workflow re-reads `dist-tags.latest` and fails if it
moved, then promotes:

```sh
npm dist-tag add "@mburghardt/opencode-metrics@<version>" latest
```

**Recorded**: _pending — task 11.13 (real release run)_

- Date:
- Version verified:
- Script output:
- `latest` before publish:
- `latest` after publish (must be unchanged):
- `latest` after promotion:
