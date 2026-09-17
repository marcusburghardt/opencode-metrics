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

- [ ] 1.1 Rename package in `package.json`: change `"name"` from
  `"opencode-metrics"` to `"@mburghardt/opencode-metrics"`.
  **Files:** `package.json`
  **Verify:** `node -e "console.log(require('./package.json').name)"` prints
  `@mburghardt/opencode-metrics`.

## 2. Release-please Configuration

- [ ] 2.1 [P] Create `release-please-config.json` at the repo root with
  `"release-type": "node"`, `"bump-minor-pre-major": true`, and changelog
  sections for `feat`, `fix`, `chore`, `docs`, `refactor`.
  **Files:** `release-please-config.json`
  **Verify:** `python3 -c "import json; c=json.load(open('release-please-config.json')); assert c['packages']['.']['release-type']=='node'"`.

- [ ] 2.2 [P] Create `.release-please-manifest.json` at the repo root
  with `{ ".": "0.1.0" }` matching the current `package.json` version.
  **Files:** `.release-please-manifest.json`
  **Verify:** `python3 -c "import json; m=json.load(open('.release-please-manifest.json')); assert m['.']==json.load(open('package.json'))['version']"`.

## 3. GitHub Actions Workflows

- [ ] 3.1 [P] Create `.github/workflows/ci_checks.yml` with three jobs
  (`lint`, `test`, `build`). Each job uses `actions/checkout` and
  `oven-sh/setup-bun` (both SHA-pinned), runs `bun install --frozen-lockfile`,
  then the respective `make` target. Workflow-level permissions: `contents: read`.
  **Files:** `.github/workflows/ci_checks.yml`
  **Verify:** `yamllint .github/workflows/ci_checks.yml` (if available) or
  visual inspection of SHA pins and permission scoping.

- [ ] 3.2 [P] Create `.github/workflows/ci_release.yml` using
  `googleapis/release-please-action` (SHA-pinned). Triggers on `push` to
  `main`. Workflow-level `permissions: {}`, job-level `contents: write` and
  `pull-requests: write`.
  **Files:** `.github/workflows/ci_release.yml`
  **Verify:** grep for SHA pin and `skip-labeling: true`.

- [ ] 3.3 [P] Create `.github/workflows/ci_publish.yml` triggered by
  `release: published`. Uses `actions/checkout`, `oven-sh/setup-bun`,
  `actions/setup-node` (all SHA-pinned). Runs `bun install --frozen-lockfile`,
  `make build`, and `npm publish --access public` with `NODE_AUTH_TOKEN`
  from `secrets.NPM_TOKEN`.
  **Files:** `.github/workflows/ci_publish.yml`
  **Verify:** grep for `NPM_TOKEN`, `--access public`, and SHA pins.

## 4. Dependabot Configuration

- [ ] 4.1 [P] Create `.github/dependabot.yml` with two ecosystems:
  `github-actions` (weekly, prefix `ci`) and `npm` (weekly, prefix `chore`).
  Both use `include: scope` in commit messages.
  **Files:** `.github/dependabot.yml`
  **Verify:** `yamllint .github/dependabot.yml` (if available) or visual
  inspection of ecosystem entries.

## 5. Documentation Fixes

- [ ] 5.1 [P] Update `README.md`:
  - Replace `your-org/opencode-metrics` with `marcusburghardt/opencode-metrics`
  - Replace `your-org/ansible-role-ai` with `marcusburghardt/ansible-role-ai`
  - Replace `"opencode-metrics"` with `"@mburghardt/opencode-metrics"` in
    plugin config examples
  - Replace `npm update opencode-metrics` with
    `npm update @mburghardt/opencode-metrics`
  - Replace `~/.config/opencode/config.json` with
    `~/.config/opencode/opencode.json`
  **Files:** `README.md`
  **Verify:** `grep -c 'your-org' README.md` returns `0`;
  `grep -c 'config\.json' README.md` returns `0` (excluding `opencode.json`
  and `package.json` references).

- [ ] 5.2 [P] Update `QUICK_START.md`:
  - Replace `your-org/opencode-metrics` with
    `marcusburghardt/opencode-metrics` (no GitHub URL present here but
    verify)
  - Replace `your-org/ansible-role-ai` with `marcusburghardt/ansible-role-ai`
  **Files:** `QUICK_START.md`
  **Verify:** `grep -c 'your-org' QUICK_START.md` returns `0`.

## 6. Verification

- [ ] 6.1 Run `make lint` to verify all existing source files still pass.
  **Verify:** exit code 0.

- [ ] 6.2 Run `make test` to verify no regressions from the package rename.
  **Verify:** exit code 0, all tests pass.

- [ ] 6.3 Run `make build` to verify the build produces `dist/index.js`.
  **Verify:** `ls dist/index.js` succeeds.
