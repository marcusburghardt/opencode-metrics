## ADDED Requirements

### Requirement: Scoped npm package name

The npm package MUST be published under the scoped name
`@mburghardt/opencode-metrics`. The `name` field in `package.json` MUST
be set to `@mburghardt/opencode-metrics`.

#### Scenario: Package identity in package.json

- **GIVEN** the `package.json` file
- **WHEN** a contributor inspects the `name` field
- **THEN** it MUST read `@mburghardt/opencode-metrics`

#### Scenario: User installs from npm

- **GIVEN** a user with OpenCode v1.18+
- **WHEN** they add `@mburghardt/opencode-metrics` to their `opencode.json`
  `plugins` array
- **THEN** OpenCode MUST resolve and install the package from npm on startup

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

The repository MUST use `release-please` to automate version management.
The workflow (`ci_release.yml`) MUST trigger on pushes to `main`.

#### Scenario: Feature commit merged

- **GIVEN** a commit with prefix `feat:` merged to `main`
- **WHEN** release-please runs
- **THEN** it MUST open a release PR that bumps the minor version in
  `package.json`, updates `CHANGELOG.md`, and updates
  `.release-please-manifest.json`

#### Scenario: Release PR merged

- **GIVEN** a release-please PR (e.g., "chore(main): release 0.2.0")
- **WHEN** the PR is merged
- **THEN** release-please MUST create a git tag and a GitHub Release

### Requirement: Automated npm publish on release

The repository MUST publish to npm when a GitHub Release is created.
The workflow (`ci_publish.yml`) MUST trigger on `release: published`
events.

#### Scenario: GitHub Release published

- **GIVEN** a GitHub Release for tag `v0.2.0`
- **WHEN** the `ci_publish.yml` workflow triggers
- **THEN** it MUST run `make build` and `npm publish --access public`
- **AND** the package MUST be available at
  `https://registry.npmjs.org/@mburghardt/opencode-metrics`

#### Scenario: Post-publish verification

- **GIVEN** a successful `npm publish` step
- **WHEN** the publish job runs the verification step
- **THEN** `npm view @mburghardt/opencode-metrics@<version> version` MUST
  return the published version
- **AND** if the verification fails, the workflow MUST exit with a
  non-zero status to signal a partial release

#### Scenario: Missing NPM_TOKEN

- **GIVEN** the `NPM_TOKEN` secret is not configured
- **WHEN** `ci_publish.yml` runs
- **THEN** the `npm publish` step MUST fail with an authentication error

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

#### Scenario: ci_publish.yml permissions

- **GIVEN** the `ci_publish.yml` workflow
- **WHEN** the publish job runs
- **THEN** it MUST have only `contents: read` permission at the job level

## MODIFIED Requirements

### Requirement: Documentation references

All documentation MUST reference the correct package name, repository
URLs, and config filenames. Previously: README and QUICK_START used
placeholder values (`your-org`) and incorrect filenames (`config.json`).

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

## REMOVED Requirements

None.
