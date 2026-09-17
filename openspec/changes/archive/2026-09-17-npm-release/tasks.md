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

## 1. Package Identity

- [x] 1.1 Rename package in `package.json`: change `"name"` from
  `"opencode-metrics"` to `"@mburghardt/opencode-metrics"`.
  **Files:** `package.json`
  **Verify:** `node -e "console.log(require('./package.json').name)"` prints
  `@mburghardt/opencode-metrics`.

## 2. Release-please Configuration

- [x] 2.1 [P] Create `release-please-config.json` at the repo root with
  `"release-type": "node"`, `"bump-minor-pre-major": true`, and changelog
  sections for `feat`, `fix`, `chore`, `docs`, `refactor`.
  **Files:** `release-please-config.json`
  **Verify:** `python3 -c "import json; c=json.load(open('release-please-config.json')); assert c['packages']['.']['release-type']=='node'"`.

- [x] 2.2 [P] Create `.release-please-manifest.json` at the repo root
  with `{ ".": "0.1.0" }` matching the current `package.json` version.
  **Files:** `.release-please-manifest.json`
  **Verify:** `python3 -c "import json; m=json.load(open('.release-please-manifest.json')); assert m['.']==json.load(open('package.json'))['version']"`.

## 3. GitHub Actions Workflows

- [x] 3.1 [P] Create `.github/workflows/ci_checks.yml` with three jobs
  (`lint`, `test`, `build`). Each job uses `actions/checkout` and
  `oven-sh/setup-bun` (both SHA-pinned), runs `bun install --frozen-lockfile`,
  then the respective `make` target. Workflow-level `permissions: {}`,
  job-level `contents: read` on each job.
  **Files:** `.github/workflows/ci_checks.yml`
  **Verify:**
  `grep -q 'permissions: {}' .github/workflows/ci_checks.yml` succeeds;
  `! grep -P 'uses:\s+\S+@v\d' .github/workflows/ci_checks.yml` succeeds
  (no bare version tags).

- [x] 3.2 [P] Create `.github/workflows/ci_release.yml` using
  `googleapis/release-please-action` (SHA-pinned). Triggers on `push` to
  `main`. Workflow-level `permissions: {}`, job-level `contents: write` and
  `pull-requests: write`.
  **Files:** `.github/workflows/ci_release.yml`
  **Verify:** grep for SHA pin and `skip-labeling: true`.

- [x] 3.3 [P] Create `.github/workflows/ci_publish.yml` triggered by
  `release: published`. Uses `actions/checkout`, `oven-sh/setup-bun`,
  `actions/setup-node` (all SHA-pinned). Runs `bun install --frozen-lockfile`,
  `make build`, `npm publish --access public` with `NODE_AUTH_TOKEN`
  from `secrets.NPM_TOKEN`, and a post-publish verification step:
  `npm view @mburghardt/opencode-metrics@${{ github.event.release.tag_name }} version`.
  Workflow-level `permissions: {}`, job-level `contents: read`.
  **Files:** `.github/workflows/ci_publish.yml`
  **Verify:**
  `grep -q 'permissions: {}' .github/workflows/ci_publish.yml` succeeds;
  `grep -q 'NPM_TOKEN' .github/workflows/ci_publish.yml` succeeds;
  `grep -q '\-\-access public' .github/workflows/ci_publish.yml` succeeds;
  `grep -q 'npm view' .github/workflows/ci_publish.yml` succeeds.

## 4. Dependabot Configuration

- [x] 4.1 [P] Create `.github/dependabot.yml` with two ecosystems:
  `github-actions` (weekly, prefix `ci`) and `npm` (weekly, prefix `chore`).
  Both use `include: scope` in commit messages.
  **Files:** `.github/dependabot.yml`
  **Verify:**
  `grep -q 'github-actions' .github/dependabot.yml` succeeds;
  `grep -q 'npm' .github/dependabot.yml` succeeds.

## 5. Documentation Fixes

- [x] 5.1 [P] Update `README.md`:
  - Replace `your-org/opencode-metrics` with `marcusburghardt/opencode-metrics`
  - Replace `your-org/ansible-role-ai` with `marcusburghardt/ansible-role-ai`
  - Replace `"opencode-metrics"` with `"@mburghardt/opencode-metrics"` in
    all plugin config examples (JSON `plugins` arrays and ansible YAML
    `ai_opencode_plugins` lists)
  - Replace `npm update opencode-metrics` with
    `npm update @mburghardt/opencode-metrics`
  - Replace `~/.config/opencode/config.json` with
    `~/.config/opencode/opencode.json`
  - Update uninstall instructions: `"opencode-metrics"` →
    `"@mburghardt/opencode-metrics"` in the plugins array comment
  - Update troubleshooting text: `opencode-metrics` →
    `@mburghardt/opencode-metrics` where it refers to the plugins array
  Note: Do NOT change filesystem paths (`~/.local/share/opencode-metrics/`),
  the project title, log message references (`[opencode-metrics] initialized`),
  `cd opencode-metrics`, or local plugin paths (`./path/to/opencode-metrics`).
  These refer to the project name, not the npm package name.
  **Files:** `README.md`
  **Verify:**
  `grep -c 'your-org' README.md` returns `0`;
  `grep -c '~/.config/opencode/config\.json' README.md` returns `0`;
  `grep -P 'plugins.*opencode-metrics' README.md | grep -v '@mburghardt' | wc -l`
  returns `0` (no unscoped package name in plugin contexts);
  `grep -cP '^\s+-\s+opencode-metrics\s*$' README.md` returns `0`
  (no unscoped name in YAML list items).

- [x] 5.2 [P] Verify `QUICK_START.md` contains no placeholder references.
  QUICK_START.md already uses correct URLs (`marcusburghardt/`). Confirm
  no `your-org` placeholders exist and no unscoped `opencode-metrics`
  references appear in plugin config contexts.
  **Files:** `QUICK_START.md`
  **Verify:**
  `grep -c 'your-org' QUICK_START.md` returns `0`;
  `grep -c 'plugins.*opencode-metrics' QUICK_START.md` returns `0`.

## 6. Verification

- [x] 6.1 Run `make lint` to verify all existing source files still pass.
  **Verify:** exit code 0.

- [x] 6.2 Run `make test` to verify no regressions from the package rename.
  **Verify:** exit code 0, all tests pass.

- [x] 6.3 Run `make build` to verify the build produces `dist/index.js`.
  **Verify:** `ls dist/index.js` succeeds.

<!-- spec-review: passed -->
<!-- code-review: passed -->
