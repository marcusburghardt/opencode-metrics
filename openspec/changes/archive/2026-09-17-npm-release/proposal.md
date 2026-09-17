## Why

The plugin was developed privately and has just been made public on GitHub.
It cannot be installed by external users because:

1. **npm name conflict** — `package.json` uses the name `opencode-metrics`,
   which is already taken on npm by an unrelated project
   (`nxxxsooo/opencode-metrics`). Anyone following the README's "From npm"
   instructions would install the wrong package.

2. **No CI pipeline** — There are no GitHub Actions workflows. Contributors
   cannot verify that lint, tests, and builds pass before merging.

3. **No automated release** — There is no mechanism to tag releases, generate
   changelogs, or publish to npm. Releases would require manual steps that
   are error-prone and undocumented.

4. **Documentation has placeholders** — README and QUICK_START reference
   `your-org/opencode-metrics` and `your-org/ansible-role-ai` instead of
   real URLs. The config filename is listed as `config.json` but OpenCode
   uses `opencode.json`.

## What Changes

### Package identity

Rename the npm package from `opencode-metrics` to
`@mburghardt/opencode-metrics` (scoped to the maintainer's npm account).
Users install via:

```jsonc
{ "plugins": ["@mburghardt/opencode-metrics"] }
```

### CI pipeline

Add three GitHub Actions workflows:

- **`ci_checks.yml`** — Lint, test, and build on every PR and push to main.
- **`ci_release.yml`** — `release-please` bot opens a release PR when
  conventional commits land on main. Merging that PR creates a tag and
  GitHub Release.
- **`ci_publish.yml`** — Publishes to npm on `release: published` events.

All actions pinned by commit SHA. Bun runtime pinned to a specific version.

### Dependency management

Add Dependabot configuration to keep GitHub Actions and npm dependencies
current with weekly update PRs using conventional commit prefixes.

### Documentation fixes

- Replace all `your-org` placeholders with real GitHub and npm identifiers.
- Fix `config.json` references to `opencode.json` (OpenCode's actual filename).
- Update all install instructions to use the scoped package name.

## Capabilities

### New Capabilities

- `ci-checks`: Automated lint, test, and build verification on PRs and
  pushes to main.
- `release-automation`: Automated version bumps, changelog generation, git
  tagging, and GitHub Release creation via release-please.
- `npm-publish`: Automated publishing to npm registry on each release.
- `dependency-updates`: Automated weekly PRs for GitHub Actions and npm
  dependency updates via Dependabot.

### Modified Capabilities

- `package-identity`: npm package name changes from `opencode-metrics` to
  `@mburghardt/opencode-metrics`. All documentation updated to match.
- `install-docs`: Installation instructions updated with correct URLs,
  scoped package name, and verified config file references.

### Removed Capabilities

None.

## Impact

- **Users**: Install path changes from `"opencode-metrics"` to
  `"@mburghardt/opencode-metrics"`. Since this is the first public release,
  there are no existing external users to migrate.
- **Contributors**: PRs now require passing CI checks (lint, test, build).
- **Maintainer**: Releases become push-to-main driven. No manual tagging
  or npm publish steps required.
- **ansible-role-ai**: The `ai_opencode_plugins` variable value must use
  the scoped name. Documentation links updated to real URLs.
- **Secrets**: One new repository secret required: `NPM_TOKEN` (already
  configured).

## Constitution Alignment

Assessed against the project constitution (`.specify/memory/constitution.md`).

### I. Autonomous Collaboration

**Assessment**: N/A

This change adds CI/CD infrastructure and documentation fixes. It does not
modify how agents collaborate or produce artifacts. The plugin's event-driven
architecture (subscribing to `session.status` and writing to SQLite) is
unchanged.

### II. Composability First

**Assessment**: PASS

The plugin remains independently installable via npm or local checkout. The
scoped package name does not introduce any new dependencies. CI workflows
are additive infrastructure — removing them would not affect the plugin's
runtime behavior.

### III. Observable Quality

**Assessment**: PASS

This change directly strengthens observable quality by adding automated CI
checks (lint, test, build) that run on every PR. Release-please generates
changelogs from conventional commits, providing machine-readable release
history. The existing test suite and coverage reporting are now enforced in
CI rather than being voluntary.

### IV. Testability

**Assessment**: PASS

No new runtime code is introduced, so no new test coverage is required. The
existing test suite is now automatically executed in CI. The `--frozen-lockfile`
flag ensures CI reproduces the exact dependency tree from the lockfile.

### V. Security by Default

**Assessment**: PASS

- All GitHub Actions are pinned by commit SHA, not mutable tags, per the
  constitution's supply chain integrity requirement.
- Workflow permissions follow least privilege: `contents: read` by default,
  elevated only where required (release-please needs `contents: write` and
  `pull-requests: write`).
- The NPM_TOKEN secret is scoped to the `@mburghardt` npm scope only.
- Dependabot keeps dependencies current, reducing exposure to known CVEs.
