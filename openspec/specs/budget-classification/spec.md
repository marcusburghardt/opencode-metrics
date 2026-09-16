## Requirements

### Requirement: Config-driven budget rules

The plugin SHALL support a `budget_rules` section in config.yaml,
structurally identical to `classification_rules`. Each rule SHALL
have a `budget_tag` (string), `conditions` (array, AND logic), and
optional `exclude` (array, OR logic). Rules SHALL be evaluated in
order; the first matching rule's `budget_tag` SHALL be assigned to
the session. If no rule matches, the session's budget_tag SHALL be
NULL.

#### Scenario: Budget tag assigned by first matching rule

- **GIVEN** config.yaml defines budget_rules:
  [{ budget_tag: Q3-platform, conditions: [...] },
   { budget_tag: Q4-security, conditions: [...] }]
- **AND** a session matches both rules
- **WHEN** the session is budget-classified
- **THEN** the budget_tag SHALL be "Q3-platform" (first match)

#### Scenario: No budget rules match

- **GIVEN** config.yaml defines budget_rules that do not match a
  session
- **WHEN** the session is budget-classified
- **THEN** the budget_tag SHALL be NULL
- **AND** the session SHALL still be work-type classified normally

#### Scenario: Budget rules use pattern matching

- **GIVEN** config.yaml defines a budget rule with condition:
  field: first_user_message, pattern: '\[Q3-platform\]'
- **AND** the engineer starts a session with the message
  "[Q3-platform] fix the login bug"
- **WHEN** the session is budget-classified
- **THEN** the budget_tag SHALL be "Q3-platform"

#### Scenario: Budget rules use project_name matching

- **GIVEN** config.yaml defines a budget rule with condition:
  field: project_name, values: [auth-service, api-gateway]
- **AND** the session is in the auth-service project
- **WHEN** the session is budget-classified
- **THEN** the budget_tag SHALL be the configured budget_tag

#### Scenario: Budget rules use exclude conditions

- **GIVEN** config.yaml defines a budget rule with
  conditions: [field: project_name, values: [auth-service]]
  exclude: [field: agent, values: [explore]]
- **AND** the session is in the auth-service project with agent
  "explore"
- **WHEN** the session is budget-classified
- **THEN** the rule SHALL NOT match (exclude triggers)
- **AND** the session SHALL fall through to subsequent budget rules

#### Scenario: Empty budget_rules list

- **GIVEN** config.yaml defines budget_rules: []
- **WHEN** any session is budget-classified
- **THEN** the budget_tag SHALL be NULL for all sessions
- **AND** the plugin SHALL operate normally with no budget tracking

### Requirement: Budget rule validation

The plugin SHALL validate budget_rules entries using the same
validation logic as classification_rules. Invalid rules SHALL be
skipped with a warning log. The budget_tag field SHALL be a
non-empty string. budget_tag SHOULD be limited to 128 characters.
Conditions and exclude arrays SHALL follow the same validation
contract as classification rules.

#### Scenario: Invalid regex in budget rule

- **GIVEN** config.yaml defines a budget rule with an invalid regex
  pattern in a condition
- **WHEN** the plugin loads the configuration
- **THEN** the plugin SHALL log a warning identifying the invalid
  rule and the regex error
- **AND** SHALL skip the invalid budget rule
- **AND** SHALL continue evaluating remaining valid budget rules

#### Scenario: Missing budget_tag field

- **GIVEN** config.yaml defines a budget rule without a budget_tag
  field
- **WHEN** the plugin loads the configuration
- **THEN** the plugin SHALL skip the malformed rule with a warning

#### Scenario: budget_rules section missing from config

- **GIVEN** config.yaml does not contain a budget_rules key
- **WHEN** the plugin loads the configuration
- **THEN** the plugin SHALL use an empty budget_rules list (no
  budget tracking)
- **AND** SHALL NOT log a warning (this is the normal default state)

### Requirement: Budget classification cache

Budget classification results SHALL be cached per session using the
same caching strategy as work-type classification. The budget
classification cache SHALL be bounded to a maximum of 1000 entries
using LRU eviction. The cache SHALL be invalidated when the
session's message count changes.

#### Scenario: Cache hit on repeated idle events

- **GIVEN** a session was budget-classified as "Q3-platform" with
  10 messages
- **WHEN** the same session fires idle again with 10 messages
- **THEN** the cached budget_tag "Q3-platform" SHALL be returned
  without re-evaluating budget rules

#### Scenario: Cache miss on new messages

- **GIVEN** a session was budget-classified as NULL with 2 messages
- **WHEN** the session fires idle with 8 messages
- **THEN** the cache SHALL be invalidated
- **AND** the session SHALL be re-classified against budget rules

#### Scenario: Budget cache eviction under pressure

- **GIVEN** the budget classification cache contains 1000 entries
- **WHEN** a new session requires budget classification
- **THEN** the least recently used budget cache entry SHALL be evicted
- **AND** the new budget classification result SHALL be cached

### Requirement: Budget classification in backfill

The backfill script SHALL apply budget_rules to historical sessions
using the same classifyBudget() function as the live plugin. The
budget_tag SHALL be written to the sessions table for each backfilled
session. Budget classification during backfill SHALL be idempotent.
Re-running backfill with updated budget_rules SHALL re-evaluate and
overwrite previously assigned budget_tags.

#### Scenario: Historical session receives budget tag

- **GIVEN** config.yaml defines a budget rule matching the
  auth-service project
- **AND** the source database contains historical sessions in
  auth-service
- **WHEN** the backfill script processes those sessions
- **THEN** the sessions SHALL be written with the matching budget_tag
