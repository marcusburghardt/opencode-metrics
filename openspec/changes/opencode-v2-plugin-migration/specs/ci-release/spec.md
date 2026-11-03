# Spec Delta

## MODIFIED Requirements

### Requirement: Scoped npm package name

<!-- Previously: the npm install scenario was written for "a user with
OpenCode v1.18+", which is no longer a supported host for the current
release line. -->

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

### Requirement: Automated release via release-please

<!-- Previously: stated only that a `feat:` commit bumps the minor version,
with no ownership rule and no breaking-change marker. -->

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

<!-- Previously: the publish job's only post-publish check was
`npm view … version`, which proves the tarball exists, not that it loads. -->

The repository MUST publish to npm when a release is created, and NO release
may reach the `latest` dist-tag without the install-and-load verification
below. Every publish path — the `publish` job in `ci_release.yml` (which runs
for release-please releases) and `ci_publish.yml` (the manual/out-of-band
fallback) — MUST publish under a non-`latest` dist-tag and MUST run the same
verification. Promoting `latest` is a separate maintainer step performed only
after verification passes.

#### Scenario: GitHub Release published

- **GIVEN** a GitHub Release for tag `v0.2.0`
- **WHEN** the `ci_publish.yml` workflow triggers
- **THEN** it MUST run `make build` and `npm publish --access public --tag next`
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

#### Scenario: Missing NPM_TOKEN

- **GIVEN** the `NPM_TOKEN` secret is not configured
- **WHEN** `ci_publish.yml` runs
- **THEN** the `npm publish` step MUST fail with an authentication error

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
