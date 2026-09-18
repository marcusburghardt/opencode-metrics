## Requirements

### Requirement: Config-Driven Classification Rules

The classification engine SHALL evaluate rules defined in config.yaml
in order, returning the first matching rule's name as the session
classification. If no rule matches, the classification SHALL default
to "ad-hoc". Rules SHALL support conditions with regex pattern matching
and exact value list matching, and exclude conditions that disqualify
a match.

#### Scenario: First matching rule wins

- **GIVEN** config.yaml defines rules: [pr-review, implementation]
- **AND** a session matches both pr-review and implementation conditions
- **WHEN** the session is classified
- **THEN** the classification SHALL be "pr-review" (first match)

#### Scenario: Exclude condition prevents match

- **GIVEN** config.yaml defines a pr-review rule with condition
  "PR URL in first user message" and exclude "gh pr create in
  bash commands"
- **AND** a session contains a PR URL in the first message AND
  executed gh pr create
- **WHEN** the session is classified
- **THEN** the pr-review rule SHALL NOT match
- **AND** the session SHALL fall through to the next matching rule

#### Scenario: No rules match

- **GIVEN** config.yaml defines rules that do not match a session
- **WHEN** the session is classified
- **THEN** the classification SHALL be "ad-hoc"

#### Scenario: Custom user-defined rule

- **GIVEN** a user adds a custom rule to config.yaml:
  name: security-review, conditions: [field: agent,
  values: [divisor-guard]]
- **WHEN** a session with agent "divisor-guard" is classified
- **THEN** the classification SHALL be "security-review"

### Requirement: Classification Context Fields

ClassificationContext SHALL include the following fields available
for matching in classification rule conditions: agent, model,
first_user_message, part_content, bash_commands, message_count,
project_name, and parent_session_id. The project_name field SHALL
contain the project directory name. The parent_session_id field
SHALL contain the parent session ID string or an empty string when
the session has no parent. Unknown fields SHALL return undefined
(no match).

#### Scenario: project_name used in classification rule

- **GIVEN** config.yaml defines a classification rule with condition:
  field: project_name, values: [infra-scripts]
- **AND** the session is in the infra-scripts project
- **WHEN** the session is classified
- **THEN** the condition SHALL match against the project directory
  name

#### Scenario: Custom rule matches sub-agent sessions

- **GIVEN** config.yaml defines a classification rule with condition:
  field: parent_session_id, pattern: '.+'
- **AND** a session has parent_session_id = "sess-abc-123"
- **WHEN** the session is classified
- **THEN** the condition SHALL match because parent_session_id is
  non-empty

#### Scenario: Custom rule matches root sessions only

- **GIVEN** config.yaml defines a classification rule with condition:
  field: parent_session_id, values: [""]
- **AND** a session has no parent (parent_session_id is empty string
  in context)
- **WHEN** the session is classified
- **THEN** the condition SHALL match because parent_session_id is
  empty

### Requirement: Default Classification Rules

The plugin SHALL ship with default classification rules covering
common session types. The defaults SHALL be written to config.yaml
on first run and SHALL be user-editable.

#### Scenario: Default rules cover standard workflows

- **GIVEN** the default config.yaml is in use
- **WHEN** sessions with the following characteristics are classified:
- **THEN** a session with a PR URL in the first message and no
  gh pr create SHALL be classified as "pr-review"
- **AND** a session that executed gh pr create SHALL be classified
  as "pr-creation"
- **AND** a session referencing openspec/proposal/design/tasks with
  a plan or build agent SHALL be classified as "openspec-workflow"
- **AND** a session with agent matching divisor-*/cobalt-*/gaze-*
  SHALL be classified as "multi-agent"
- **AND** a session with agent "explore" SHALL be classified as
  "exploration"
- **AND** a session with agent "plan" SHALL be classified as
  "planning"
- **AND** a session with agent "build" (not matching earlier rules)
  SHALL be classified as "implementation"
- **AND** a session matching no other rule SHALL be classified as
  "ad-hoc"

### Requirement: Configuration Validation

The classification engine SHALL validate config.yaml content on load.
Invalid configurations SHALL NOT crash the plugin or the OpenCode
process. The plugin SHALL fall back to default classification rules
when validation fails.

#### Scenario: Invalid YAML syntax

- **GIVEN** config.yaml contains malformed YAML (syntax errors)
- **WHEN** the plugin loads the configuration
- **THEN** the plugin SHALL log a warning identifying the parse error
- **AND** SHALL fall back to default classification rules entirely
- **AND** SHALL continue operating normally

#### Scenario: Invalid regex pattern in rule condition

- **GIVEN** config.yaml contains a rule with an invalid regex pattern
  (e.g., unbalanced parentheses)
- **WHEN** the plugin loads the configuration
- **THEN** the plugin SHALL log a warning identifying the invalid
  rule and the regex compilation error
- **AND** SHALL skip the invalid rule
- **AND** SHALL continue evaluating remaining valid rules

#### Scenario: Unexpected types in rule definition

- **GIVEN** config.yaml contains a rule where conditions is a string
  instead of an array, or values contains a number instead of strings
- **WHEN** the plugin loads the configuration
- **THEN** the plugin SHALL log a warning identifying the type error
- **AND** SHALL skip the malformed rule
- **AND** SHALL continue evaluating remaining valid rules

#### Scenario: Unrecognized fields in config

- **GIVEN** config.yaml contains fields not defined in the schema
- **WHEN** the plugin loads the configuration
- **THEN** the plugin SHALL ignore unrecognized fields silently
- **AND** SHALL process recognized fields normally

### Requirement: Classification Cache

The classification engine SHALL cache classification results per
session_id. Cached results SHALL be returned without re-evaluation
when the session's message count has not changed since the last
classification. The cache SHALL be invalidated when the message
count changes.

#### Scenario: Cache hit on repeated idle events

- **GIVEN** a session was classified as "implementation" after its
  first idle event with 10 messages
- **WHEN** the same session fires idle again with 10 messages
  (user typed but did not send a new prompt)
- **THEN** the cached classification "implementation" SHALL be
  returned without re-evaluating rules or querying session content

#### Scenario: Cache miss on new messages

- **GIVEN** a session was classified as "ad-hoc" after its first idle
  event with 2 messages
- **WHEN** the user sends additional prompts and the session fires
  idle with 8 messages
- **THEN** the cache SHALL be invalidated
- **AND** the session SHALL be re-classified using the updated content

The classification cache SHALL be bounded to a maximum of 1000 entries
using LRU eviction. This prevents unbounded memory growth in the
host OpenCode process during long-running sessions.

#### Scenario: Cache eviction under pressure

- **GIVEN** the classification cache contains 1000 entries
- **WHEN** a new session requires classification
- **THEN** the least recently used cache entry SHALL be evicted
- **AND** the new classification result SHALL be cached
