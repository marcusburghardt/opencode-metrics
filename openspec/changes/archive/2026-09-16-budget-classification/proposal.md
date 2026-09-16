## Why

Teams using AI tools face a budget management challenge: multiple
engineers work in parallel across multiple repositories, each
accumulating AI spend in isolated local databases. A manager with a
limited AI budget has no way to attribute session costs to specific
budgets (projects, features, sprints) until the surprise arrives at
the end of the billing period.

The opencode-metrics plugin already captures per-session cost data
locally, but sessions are classified only by work type (pr-review,
implementation, etc.). There is no mechanism to tag sessions with a
budget identifier that spans repositories and enables cost
aggregation by budget.

This change adds a **budget classification** dimension to the plugin
so engineers can tag sessions with budget identifiers using the same
flexible rule engine already used for work-type classification. Budget
tagging is orthogonal to work-type classification: a session can be
both an "implementation" session and a "Q3-platform" budget session.

## What Changes

### Config Extension

Add a `budget_rules` section to `config.yaml`, structurally identical
to `classification_rules`. Each rule maps conditions to a
`budget_tag` string. Rules are evaluated in order (first match wins).
Unmatched sessions have a NULL budget_tag.

Engineers choose their own detection logic: prefix patterns in the
first message (`[Q3-platform] fix the login bug`), project name
matching, agent-based rules, or any combination of fields.

### Classification Context Extension

Add `project_name` as a matchable field in `ClassificationContext`.
This enables budget rules (and classification rules) to match on
the project/repository name, which is already available in the
session data but was not previously exposed to the rule engine.

### Schema Extension

Add a nullable `budget_tag TEXT` column to the `sessions` table.
Bump schema version from 2 to 3. Existing sessions retain NULL
for budget_tag (not budget-tracked).

### Budget Classification Engine

Add a `classifyBudget()` function that evaluates budget rules using
the same condition engine (evaluateCondition, evaluateRule) as
work-type classification. Returns `null` when no rules match.

## Capabilities

### New Capabilities
- `budget-classification`: Tag sessions with budget identifiers using
  config-driven rules. Supports pattern, exact-value, and exclude
  conditions on all context fields including the new `project_name`.

### Modified Capabilities
- `session-classification`: ClassificationContext gains `project_name`
  field, usable in both classification_rules and budget_rules.
- `metrics-storage`: Sessions table gains `budget_tag` column. Schema
  version bumps to 3.

### Removed Capabilities
(none)

## Impact

### Files Affected

| File | Change |
|---|---|
| `src/config.ts` | BudgetRule interface, MetricsConfig extension, validation |
| `src/defaults.ts` | Default config YAML gains budget_rules section |
| `src/classifier.ts` | classifyBudget() function, project_name field |
| `src/db.ts` | Schema version 3, ALTER TABLE migration |
| `src/writer.ts` | SessionRecord gains budget_tag |
| `src/extractor.ts` | Thread project_name into ClassificationContext |
| `src/index.ts` | Call classifyBudget() in handleSessionIdle() |
| `scripts/backfill.ts` | Apply budget classification during backfill |
| `README.md` | Budget rules documentation |

### Backward Compatibility

- Existing databases are migrated automatically (ADD COLUMN,
  defaults to NULL).
- Existing config.yaml files without budget_rules continue to work
  (empty budget_rules is the default).
- No existing behavior changes; budget classification is purely
  additive.

## Constitution Alignment

Assessed against the project constitution.

### I. Autonomous Collaboration

**Assessment**: PASS

Budget classification operates entirely within the local plugin.
The budget_tag is stored as a self-describing field in the sessions
table alongside existing metadata. No inter-agent communication
or synchronous coordination is required. The tagged data in SQLite
serves as an artifact that downstream consumers (dashboards, push
scripts) can read independently.

### II. Composability First

**Assessment**: PASS

Budget classification is fully optional. The plugin works identically
without any budget_rules configured (empty list is the default).
No new external dependencies are introduced. The feature extends
the existing rule engine rather than creating a parallel system.
The project_name context field is available to both classification
and budget rule authors, increasing composability.

### III. Observable Quality

**Assessment**: PASS

Budget tags are stored in the same SQLite database with the same
timestamp conventions and dimensional model. They are queryable with
standard SQL. The budget_tag column is immediately available to
Grafana dashboards and any tooling that reads the sessions table.

### IV. Testability

**Assessment**: PASS

classifyBudget() is a pure function operating on the same
ClassificationContext and rule types as the existing classifier. It
is testable in isolation with the same patterns used in
classifier.test.ts. The schema migration is testable via db.test.ts.
Coverage strategy: unit tests for classifyBudget(), budget rule
validation, project_name field resolution, and schema migration.

### V. Security by Default

**Assessment**: PASS

No new external inputs beyond what config.yaml already accepts.
Budget rules go through the same validation pipeline as
classification rules (regex compilation, type checking, field
validation). The budget_tag is a free-form string stored locally;
no new network access or permissions are required.
