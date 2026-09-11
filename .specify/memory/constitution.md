# Project Constitution

## Core Principles

### I. Autonomous Collaboration

Agents MUST collaborate through well-defined artifacts — files,
reports, and schemas — rather than runtime coupling or synchronous
interaction.

- Every agent MUST be able to complete its primary function without
  requiring synchronous interaction with another agent. An agent MAY
  consume another agent's artifacts, but MUST NOT block waiting for
  a response.
- Agent outputs MUST be self-describing: each artifact MUST contain
  enough metadata (producer identity, version, timestamp, artifact
  type) for any consumer to interpret it without consulting the
  producing agent.
- Inter-agent communication MUST use well-defined artifact formats.
  Agents MUST NOT invent ad-hoc exchange formats.
- Agents SHOULD publish artifacts to a well-known location within
  the project repository so other agents can discover them without
  explicit coordination.

**Rationale**: A swarm of autonomous agents cannot rely on real-time
negotiation. Artifact-based communication makes collaboration
asynchronous, auditable, and resilient to individual agent
unavailability.

### II. Composability First

Every agent MUST be independently installable and usable without any
other agent being present. Combining agents MUST produce additive
value without introducing mandatory dependencies.

- An agent MUST deliver its core value when deployed alone. No agent
  MAY require another agent as a hard prerequisite for installation
  or primary operation.
- Agents MUST expose well-defined extension points (configuration,
  artifact consumption, convention packs) for integration rather
  than requiring modification of their internals.
- When two or more agents are deployed together, their combination
  MUST produce value greater than the sum of their individual
  capabilities. This additive value MUST NOT come at the cost of
  standalone functionality.
- Agents SHOULD auto-detect the presence of other agents and
  activate enhanced functionality when peers are available, without
  requiring manual configuration.

**Rationale**: Adoption friction kills tools. Composability ensures
each agent earns its place independently, and the swarm becomes
compelling only when its parts are already individually valuable.

### III. Observable Quality

Every agent MUST produce machine-parseable output alongside any
human-readable output. All quality claims MUST be backed by
automated, reproducible evidence.

- Every agent that produces output MUST support at minimum a JSON
  format. Human-readable output (terminal text, Markdown) is
  RECOMMENDED but MUST NOT be the only format available.
- All artifacts MUST include provenance metadata: which agent
  produced the output, which version, when it was produced, and
  against what input (branch, commit, backlog item).
- Quality claims — accuracy rates, coverage percentages, scoring
  thresholds — MUST be backed by automated regression tests or
  benchmarks that can be re-run by any contributor.
- Metrics MUST be comparable across runs. Output formats MUST be
  stable enough that tooling built on an agent's output does not
  break between minor versions.

**Rationale**: A swarm that cannot measure its own performance
cannot improve. Machine-parseable output enables tracking trends,
making data-driven prioritization decisions, and grounding reviews
in evidence rather than opinion.

### IV. Testability

Every component built within this project MUST be testable in
isolation without requiring external services, network access, or
shared mutable state.

- Test contracts MUST verify observable side effects (return values,
  state mutations, I/O operations) rather than implementation
  details.
- Coverage strategy (unit vs. integration vs. e2e, with specific
  targets) MUST be defined in the implementation plan for all new
  code.
- Coverage ratchets MUST be enforced by automated tests; any
  coverage regression MUST be treated as a test failure and block
  the build.
- Missing coverage strategy in a spec or plan is a CRITICAL-severity
  finding and MUST be resolved before implementation begins.

**Rationale**: AI agents generate code rapidly. If that code is not
structurally testable, the resulting system will quickly collapse
under its own unverified complexity. Testability is a first-class
governance concern because untestable code cannot be reliably
verified by any automated mechanism.

### V. Security by Default

Every component built within this project MUST treat security as a
structural property, not a review-time afterthought. Supply chain
integrity, input validation, and least privilege MUST be enforced
by design.

- Dependencies MUST be verified by content hash (SHA256 or
  equivalent) when downloaded outside a package manager's built-in
  verification. CI pipelines MUST pin actions and reusable workflows
  by commit SHA, not mutable tags.
- All external inputs (user input, API payloads, file contents,
  environment variables used as data) MUST be validated and
  sanitized before reaching any security-sensitive operation.
- Components MUST operate with the minimum permissions necessary.
  Secrets MUST be scoped to the narrowest context needed. File
  permissions MUST default to restrictive values (0o644 for files,
  0o755 for executables and directories).
- Before adding an external dependency, the adopter MUST justify
  that the project's existing toolchain cannot cover the same use
  case. Every dependency is attack surface; the default answer is
  "do not add."

**Rationale**: AI agents make adding dependencies and generating
code trivially fast. Without structural security guardrails, the
attack surface of the system grows with each generation cycle.

## Development Workflow

- All work MUST occur on feature branches. Direct commits to the
  main branch are prohibited except for trivial documentation fixes.
- Every pull request MUST receive at least one approving review
  before merge.
- The CI pipeline MUST pass (build, lint, tests) before a pull
  request is eligible for merge.
- Follow semantic versioning (MAJOR.MINOR.PATCH). Breaking changes
  to public APIs, artifact schemas, or analysis behavior require a
  MAJOR bump.
- Use conventional commit format (`type: description`) to enable
  automated changelog generation.

## Governance

This constitution is the highest-authority document in the project.

- When a project constitution and the org constitution conflict, the
  org constitution prevails. The project constitution MUST be amended
  to resolve the conflict.
- Any change to this constitution MUST be proposed via pull request,
  reviewed, and approved before merge.
- The constitution follows semantic versioning:
  - MAJOR: Principle removal or incompatible redefinition of a MUST
    rule.
  - MINOR: New principle added or materially expanded guidance.
  - PATCH: Clarifications, wording, or non-semantic refinements.

<!-- Customize this constitution for your project's specific needs.
     Run /speckit.constitution to refine principles and add
     project-specific governance rules. -->

**Version**: 1.0.0
<!-- scaffolded by uf v0.17.0 -->
