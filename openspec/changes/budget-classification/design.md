## Context

The opencode-metrics plugin classifies sessions by work type using a
config-driven rule engine (conditions, exclude, first-match-wins).
This change adds a parallel budget classification axis so sessions
can carry both a work-type classification and a budget identifier.

The existing rule engine (`evaluateCondition`, `evaluateRule`) is
fully reusable. Budget classification requires no new matching logic,
only new data structures and a new entry point that returns
`string | null` instead of always falling back to `"ad-hoc"`.

## Goals / Non-Goals

### Goals
- Add `budget_tag` as a nullable column in the sessions table
- Add `budget_rules` config section with same structure as
  classification rules
- Expose `project_name` as a matchable field in
  ClassificationContext
- Budget classification runs independently of work-type
  classification on every idle event
- Backfill script applies budget rules to historical sessions

### Non-Goals
- Pushing budget-tagged metrics to a remote endpoint (future change)
- Multi-budget tagging (one session = one budget or none)
- Budget limit enforcement or alerts
- Budget registry or centralized budget ID validation

## Decisions

### D1: Separate budget_rules list, not a flag on classification_rules

Budget rules are a separate `budget_rules` array in config.yaml,
not a flag (e.g., `is_budget: true`) on classification rules.

**Rationale**: The two rule lists serve different purposes and have
different semantics. Classification always produces a string (falls
back to "ad-hoc"); budget classification produces `string | null`.
Mixing them in one list would require a discriminator flag and
complicate the type model. Separate lists keep each concern
self-contained and independently documented.

This aligns with **Composability First**: each classification axis
is independently configurable and independently omittable.

### D2: BudgetRule uses budget_tag key, not name

A `BudgetRule` has `budget_tag` as its identifier, while
`ClassificationRule` has `name`. This makes the config.yaml schema
self-documenting: `budget_tag` communicates "this is the value that
will be written to the sessions table", not a display label.

The `conditions` and `exclude` arrays are structurally identical
to `ClassificationRule`. Validation reuses `validateCondition()`.

### D3: NULL for untagged sessions, not a fallback string

When no budget rule matches, `budget_tag` is NULL rather than a
sentinel string like `"untagged"`. This keeps SQL queries natural:
`WHERE budget_tag IS NOT NULL` selects only budget-tracked sessions.
A sentinel string would require knowing its value across all
consumers.

### D4: project_name added to ClassificationContext

The `project_name` field is derived from the project's directory
name (the `name` field in the projects table). It is threaded into
`ClassificationContext` by the extractor and made available to both
classification and budget rules.

This is a non-breaking change: existing rules do not reference
`project_name` and `getFieldAsString`/`getFieldRaw` return
`undefined` for unknown fields, which fails the condition (no match).
Adding the field is purely additive.

### D5: Two cache instances, same class

`ClassificationCache` is used for both work-type and budget caching.
Two separate instances are created in `handleSessionIdle()`. The
cache class is generic enough (it stores `string` keyed by
session ID + message count) that no rename or generalization is
needed. Total cache footprint with budget classification enabled
is two bounded LRU instances (up to 2000 entries combined).

### D6: Schema migration via conditional ALTER TABLE

The migration from schema version 2 to 3 uses
`ALTER TABLE sessions ADD COLUMN budget_tag TEXT`. This is wrapped
in a version check (`if currentVersion < 3`) and uses a try/catch
guard for SQLite versions that do not support
`ADD COLUMN IF NOT EXISTS`.

The column defaults to NULL, which is the correct value for all
existing sessions (no budget tag assigned retroactively).

### D7: Default config ships with empty budget_rules

The default `config.yaml` includes an empty `budget_rules: []`
section with example rules in YAML comments. This follows the
existing pattern for classification_rules: the section is present
and documented, but no rules are active until the engineer
configures them.

This aligns with **Observable Quality**: the schema is
self-documenting. Engineers see the budget_rules section in their
config and understand the capability exists without consulting
external documentation.

## Risks / Trade-offs

### Risk: budget_tag naming collisions across engineers

Multiple engineers may choose different names for the same budget
(e.g., "Q3-platform" vs "q3-platform" vs "q3_platform"). Since
budget tags are free-form strings, there is no validation against
a central registry.

**Mitigation**: This is an acceptable trade-off for the current
scope. A future push mechanism could normalize tags or validate
against a central registry. For now, team convention is sufficient.

### Risk: Single budget_tag per session

A session can only be tagged with one budget. If a session spans
two budget concerns (unlikely but possible), the first matching rule
wins.

**Mitigation**: Budget rules are ordered and engineer-controlled.
If multi-budget tagging is needed in the future, it would require
a junction table (session_budgets) and is out of scope for this
change.

### Trade-off: project_name is a directory name, not a git remote

The `project_name` field uses the directory name (e.g.,
"auth-service") rather than the git remote URL. This is simpler and
sufficient for most cases, but means two engineers with different
directory names for the same repo would need different rules.

**Accepted**: The git remote would be more canonical but requires
additional I/O (reading git config) and introduces a network
dependency if the remote has not been fetched. Directory name is
available without I/O and covers the common case.
