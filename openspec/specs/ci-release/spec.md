## Purpose

Define the release, publish, verification, and promotion gates for the npm package.

## Requirements

### Requirement: Scoped npm package name

The npm package MUST be published under the scoped name
`@mburghardt/opencode-metrics`. The `name` field in `package.json` MUST be set
to `@mburghardt/opencode-metrics`. Releases from `0.5.0` onward MUST declare
OpenCode V2 (2.2+) as the minimum supported host in the README prerequisite and
in the release notes. Releases up to and including `0.4.x` MUST remain
installable for OpenCode V1 hosts.

#### Scenario: Package identity in package.json

- **GIVEN** the `package.json` file
- **WHEN** a contributor inspects the `name` field
- **THEN** it MUST read `@mburghardt/opencode-metrics`

#### Scenario: User installs from npm

- **GIVEN** a user with OpenCode 2.2 or later
- **WHEN** they add `@mburghardt/opencode-metrics` to their `opencode.json`
  `plugins` array
- **THEN** OpenCode MUST resolve and install the package from npm on startup

#### Scenario: User on an unsupported host

- **GIVEN** a user with OpenCode V1 installing plugin `0.5.0` or later
- **WHEN** OpenCode attempts to load the plugin
- **THEN** the plugin SHALL fail to load
- **AND** OpenCode SHALL continue to start without the plugin
- **AND** the troubleshooting documentation SHALL explain the failure and
  direct the user to the `0.4.x` line
- **AND** this scenario SHALL NOT promise a plugin-emitted message from a host
  where the module cannot be imported

### Requirement: CI checks on every PR

The repository MUST run lint, test, and build checks on every pull request
and push to main via a GitHub Actions workflow (`ci_checks.yml`).

#### Scenario: Pull request opened

- **GIVEN** a pull request targeting `main`
- **WHEN** the PR is opened or updated
- **THEN** three jobs MUST execute: `lint` (`make lint`), `test`
  (`make test`), and `build` (`make build`)
- **AND** each job MUST use `bun install --frozen-lockfile` to install
  dependencies

#### Scenario: CI check failure visible on PR

- **GIVEN** a pull request where `make test` fails
- **WHEN** a reviewer checks the PR status
- **THEN** the CI status check MUST show as failed

### Requirement: Automated release via release-please

The repository MUST use `release-please` to automate version management. The
workflow (`ci_release.yml`) MUST trigger on pushes to `main`. Contributors
MUST NOT hand-edit `CHANGELOG.md`, `package.json`, or
`.release-please-manifest.json`; release-please owns those files. The sole
exception is a one-time remediation of content written before release-please
took ownership, performed in a dedicated `docs:` commit that preserves every
entry.

#### Scenario: Feature commit merged

- **GIVEN** a commit with prefix `feat:` merged to `main`
- **WHEN** release-please runs
- **THEN** it MUST open a release PR that bumps the version in `package.json`,
  updates `CHANGELOG.md`, and updates `.release-please-manifest.json`

#### Scenario: Release PR merged

- **GIVEN** a release-please PR (e.g., "chore(main): release 0.2.0")
- **WHEN** the PR is merged
- **THEN** release-please MUST create a git tag and a GitHub Release
- **AND** `package.json` version and `.release-please-manifest.json` MUST
  agree

#### Scenario: Breaking change merged

- **GIVEN** a commit whose subject uses `!` (e.g. `feat!:`) or whose body
  carries a `BREAKING CHANGE:` footer
- **WHEN** release-please runs against a pre-1.0 line with
  `bump-minor-pre-major: true`
- **THEN** the release PR SHALL bump the minor version
- **AND** the generated changelog entry SHALL contain a breaking-changes
  section describing the user-visible impact

#### Scenario: One-time changelog remediation

- **GIVEN** a stale hand-written section exists in `CHANGELOG.md` from before
  release-please took ownership
- **WHEN** a maintainer reconciles it
- **THEN** the change MAY be made in a dedicated `docs:` commit that folds the
  entries into their released sections
- **AND** no changelog entry SHALL be deleted

### Requirement: Automated npm publish on release

The repository MUST publish to npm when a release is created, and NO release
may reach the `latest` dist-tag without the install-and-load verification
below. Every publish path — the `publish` job in `ci_release.yml` (which runs
for release-please releases) and `ci_publish.yml` (the manual/out-of-band
fallback) — MUST publish under a non-`latest` dist-tag and MUST run the same
verification. Promoting `latest` is a separate maintainer step performed only
after verification passes. Both paths SHOULD authenticate with npm trusted
publishing over GitHub OIDC; a long-lived `NPM_TOKEN` SHOULD NOT be required.

#### Scenario: GitHub Release published

- **GIVEN** a GitHub Release for tag `v0.2.0`
- **WHEN** the publish workflow triggers
- **THEN** it MUST run `make build` and
  `npm publish --access public --tag next`
- **AND** the package MUST be available at
  `https://registry.npmjs.org/@mburghardt/opencode-metrics`
- **AND** a maintainer promotion step MUST move `latest` only after the
  published-artifact check passes

#### Scenario: Post-publish verification

- **GIVEN** a successful `npm publish` step
- **WHEN** the publish job runs the verification step
- **THEN** `npm view @mburghardt/opencode-metrics@<version> version` MUST
  return the published version
- **AND** if the verification fails, the workflow MUST exit with a non-zero
  status to signal a partial release

#### Scenario: Missing registry credentials

- **GIVEN** neither a configured trusted publisher nor a valid npm token is
  available
- **WHEN** a publish workflow runs
- **THEN** the `npm publish` step MUST fail with an authentication error
- **AND** the failure MUST occur before any artifact is promoted to `latest`

#### Scenario: Published artifact is installed and loaded before promotion

- **GIVEN** a release candidate published under a non-`latest` dist-tag
- **WHEN** the release gate runs
- **THEN** it SHALL install the published tarball in a clean directory
- **AND** SHALL confirm the plugin API package is declared in the published
  `dependencies` and resolves
- **AND** SHALL confirm `dist/index.js` is present and registers via
  `Plugin.define`
- **AND** `latest` SHALL be promoted only after this check passes

#### Scenario: A published release is revertible

- **GIVEN** a published version is found to be broken
- **WHEN** a maintainer rolls back
- **THEN** the documented procedure SHALL specify moving the `latest`
  dist-tag back, deprecating the broken version, and publishing a patch

### Requirement: Pinned action versions

All GitHub Actions used in workflows MUST be pinned by commit SHA with
a version comment. Mutable tags (e.g., `v4`, `latest`) MUST NOT be used.

#### Scenario: Dependabot updates an action

- **GIVEN** a workflow using
  `actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1  # v7.0.1`
- **WHEN** Dependabot detects a new version of `actions/checkout`
- **THEN** it MUST open a PR updating the SHA and version comment

### Requirement: Pinned Bun version

CI workflows MUST pin the Bun runtime to a specific version via the
`bun-version` input of `oven-sh/setup-bun`. The version MUST NOT be
`latest` or omitted.

#### Scenario: Bun version in CI

- **GIVEN** any workflow step using `oven-sh/setup-bun`
- **WHEN** the step configures the runtime
- **THEN** it MUST specify `bun-version: "1.4.2"` (or whatever the
  current pinned version is)

### Requirement: Dependabot configuration

The repository MUST include a `.github/dependabot.yml` that configures
weekly updates for both `github-actions` and `npm` ecosystems.

#### Scenario: Weekly Dependabot check

- **GIVEN** the Dependabot configuration
- **WHEN** the weekly schedule fires
- **THEN** Dependabot MUST check for updates to GitHub Actions and npm
  packages
- **AND** opened PRs MUST use conventional commit prefixes (`ci` for
  actions, `chore` for npm)

### Requirement: release-please configuration files

The repository MUST contain `release-please-config.json` and
`.release-please-manifest.json` at the root.

#### Scenario: release-please config

- **GIVEN** `release-please-config.json`
- **WHEN** release-please reads the config
- **THEN** it MUST find `"release-type": "node"` to enable automatic
  `package.json` version bumps
- **AND** `"bump-minor-pre-major": true` to keep versions below `1.0.0`
  until a major release is declared

#### Scenario: release-please manifest

- **GIVEN** `.release-please-manifest.json`
- **WHEN** release-please reads the manifest
- **THEN** the current version MUST match the version in `package.json`

### Requirement: Workflow permissions

All workflows MUST set `permissions: {}` at the workflow level (deny by
default) and grant elevated permissions only at the job level where
needed.

#### Scenario: ci_checks.yml permissions

- **GIVEN** the `ci_checks.yml` workflow
- **WHEN** any job runs
- **THEN** it MUST have only `contents: read` permission at the job level

#### Scenario: ci_release.yml permissions

- **GIVEN** the `ci_release.yml` workflow
- **WHEN** the release-please job runs
- **THEN** it MUST have `contents: write` and `pull-requests: write`
  permissions at the job level
- **AND** the publish job MUST have `contents: read` and `id-token: write`
  permissions at the job level

#### Scenario: ci_publish.yml permissions

- **GIVEN** the `ci_publish.yml` workflow
- **WHEN** the publish job runs
- **THEN** it MUST have `contents: read` and `id-token: write` permissions
  at the job level

### Requirement: Documentation references

All documentation MUST reference the correct package name, repository
URLs, and config filenames.

#### Scenario: README install instructions

- **GIVEN** the README.md
- **WHEN** a user reads the "From npm" section
- **THEN** the plugin name MUST be `@mburghardt/opencode-metrics`
- **AND** the config file MUST be referred to as `opencode.json`

#### Scenario: Package name consistency across documentation

- **GIVEN** README.md after all changes
- **WHEN** checking all plugin config examples, install commands, ansible
  `ai_opencode_plugins` lists, uninstall instructions, and troubleshooting
  references
- **THEN** every reference to the npm package name MUST use
  `@mburghardt/opencode-metrics`
- **AND** filesystem paths (`~/.local/share/opencode-metrics/`), the
  project title, log messages, and directory names MUST remain unchanged

#### Scenario: Repository URLs

- **GIVEN** README.md and QUICK_START.md
- **WHEN** a user clicks any link to this repository or ansible-role-ai
- **THEN** the URL MUST resolve to an existing GitHub repository
  (`marcusburghardt/opencode-metrics` and
  `marcusburghardt/ansible-role-ai`)
