## Context

The opencode-metrics plugin is functional but has no CI, no release
automation, and no published npm package. The project has just been made
public on GitHub and needs infrastructure to support external contributors
and users.

The design follows patterns from two reference repositories:
- `marcusburghardt/ansible-role-ai` — release-please + Dependabot model
- `complytime/complyctl` — SHA-pinned actions with preflight gates

## Goals / Non-Goals

### Goals

- Automated CI checks (lint, test, build) on every PR
- Automated releases via release-please (conventional commits drive
  version bumps and changelogs)
- Automated npm publishing on each GitHub Release
- Dependency freshness via Dependabot (GitHub Actions + npm)
- Correct documentation for first-time users

### Non-Goals

- Coverage enforcement in CI (tracked for follow-up; the 80% target
  remains advisory until a dedicated change adds threshold gating.
  Constitution IV notes this gap — see follow-up below)
- Branch protection rules (GitHub settings, not repo files)
- Container image builds or supply chain attestations (no container
  artifacts in this project)
- Publishing to registries other than npm
- Pre-commit hooks (future work)

## Decisions

### D1: Scoped npm package name — `@mburghardt/opencode-metrics`

The unscoped name `opencode-metrics` is already taken on npm by an
unrelated project. Using a scoped name under `@mburghardt` avoids the
conflict, clearly identifies ownership, and is fully supported by
OpenCode's plugin resolution (confirmed in OpenCode docs: scoped
packages work in the `plugin` array).

If the project grows, the name can be migrated to an org scope later.

### D2: release-please for version management

release-please is preferred over manual `workflow_dispatch` tagging
because:

- The project already uses conventional commits, which release-please
  consumes natively.
- It automates `package.json` version bumps, changelog generation, and
  tag creation with zero manual steps.
- The `"release-type": "node"` setting handles `package.json` updates
  automatically (vs. `"simple"` which only creates tags).
- `"bump-minor-pre-major": true` keeps the version below `1.0.0` per
  the maintainer's preference for pre-1.0 maturity signaling.

The ansible-role-ai repository uses the same pattern, providing a
proven reference within the maintainer's own projects.

### D3: Two-stage release pipeline

```
push to main (conventional commits)
       |
       v
ci_release.yml (release-please)
  opens PR: "chore(main): release 0.2.0"
  - bumps package.json
  - generates CHANGELOG.md
       |
       v
maintainer merges release PR
       |
       v
release-please creates tag + GitHub Release
       |
       v
ci_publish.yml (on: release published)
  - bun install --frozen-lockfile
  - make build
  - npm publish --access public
       |
       v
@mburghardt/opencode-metrics@0.2.0 on npm
```

The two-stage design (separate release and publish workflows)
provides a clean separation of concerns:
- `ci_release.yml` manages git history (tags, changelogs) using only
  `GITHUB_TOKEN`.
- `ci_publish.yml` manages package distribution using `NPM_TOKEN`.
- Each workflow has the minimum permissions for its job.

This follows the Security by Default principle: the npm token is only
exposed in the publish workflow, never in the release or CI workflows.

### D4: SHA-pinned GitHub Actions

All actions are pinned by commit SHA with a version comment:

| Action | Version | SHA |
|--------|---------|-----|
| `actions/checkout` | v7.0.1 | `3d3c42e5aac5ba805825da76410c181273ba90b1` |
| `oven-sh/setup-bun` | v2.2.0 | `0c5077e51419868618aeaa5fe8019c62421857d6` |
| `googleapis/release-please-action` | v5.0.0 | `45996ed1f6d02564a971a2fa1b5860e934307cf7` |
| `actions/setup-node` | v7.0.0 | `820762786026740c76f36085b0efc47a31fe5020` |

This satisfies the constitution's supply chain integrity requirement.
Dependabot's `github-actions` ecosystem updates these SHAs weekly.

### D5: Bun + Node dual setup in publish workflow

The publish workflow uses both `setup-bun` (for `bun install` and
`make build`) and `setup-node` (for `npm publish` authentication).
This is necessary because:

- Bun handles the build toolchain (the project's `bun.lock` and
  `bun:sqlite` imports require Bun).
- `setup-node` configures the `.npmrc` with `NODE_AUTH_TOKEN` for
  npm registry authentication. Bun's `bunx npm publish` does not
  reliably handle npm auth tokens in CI.

Node version is pinned to `22` (current LTS).

### D6: Frozen lockfile in CI

All `bun install` steps use `--frozen-lockfile` to ensure CI fails
immediately if `bun.lock` is out of sync with `package.json`. This
prevents silent dependency drift between what developers test locally
and what CI builds.

### D7: Separate CI jobs (not matrix)

The CI workflow uses three separate jobs (`lint`, `test`, `build`)
rather than a build matrix. This provides:

- Independent failure signals (a lint failure is immediately
  distinguishable from a test failure in the GitHub PR checks UI).
- Parallel execution (all three jobs run concurrently).
- Simpler workflow file (no matrix configuration).

The tradeoff is slight duplication of the checkout + setup steps
across jobs, which is acceptable for three jobs.

## Risks / Trade-offs

### R1: npm token expiration

Granular npm tokens have a maximum TTL. If the token expires without
renewal, the publish workflow will fail. Future improvement: use npm
OIDC trust (requires npm org plan).

**Mitigations**:
- Calendar reminder for token renewal.
- The publish workflow includes a post-publish verification step
  (`npm view @mburghardt/opencode-metrics@<version> version`) that
  turns a silent failure into a visible workflow failure.

**Recovery procedure** (if publish fails after a GitHub Release is
created):
1. Fix the root cause (renew token, fix build).
2. Re-trigger manually: delete the GitHub Release, then re-create
   it to fire the `release: published` event again. Alternatively,
   add `workflow_dispatch` as a secondary trigger to
   `ci_publish.yml` for manual re-runs.
3. Manual fallback: `git checkout <tag> && bun install --frozen-lockfile && make build && npm publish --access public`.

### R2: Bun version drift

Pinning `bun-version: "1.4.2"` means CI may diverge from what
contributors use locally. Dependabot does not update `setup-bun`
inputs, only the action SHA itself. Mitigation: Bun has strong
backward compatibility; the maintainer updates the pinned version
when bumping `devDependencies`.

### R3: Coverage enforcement deferred

Constitution IV requires coverage ratchets enforced by automated
tests. This change introduces CI that runs `make test` (which
includes `bun test --coverage`) but does not enforce a threshold.
The 80% target in the Makefile is advisory. A follow-up change
should add threshold gating (e.g., parse coverage output and fail
if below target). This is an acknowledged partial compliance with
Constitution IV.

### R4: No branch protection

This change adds CI checks but does not configure GitHub branch
protection rules (those are repo settings, not files). Without
branch protection, CI failures are advisory — contributors can still
merge failing PRs. The maintainer should enable branch protection
for `main` requiring the `lint`, `test`, and `build` status checks
after CI is verified working.
