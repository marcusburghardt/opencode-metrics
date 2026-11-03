# Spec Delta

## MODIFIED Requirements

### Requirement: Classification Context Fields

<!-- Previously: the source of `agent` and `model` was not specified; V1
derived them from the first user message. -->

ClassificationContext SHALL include the following fields available for
matching in classification rule conditions: agent, model, first_user_message,
part_content, bash_commands, message_count, project_name, and
parent_session_id. The project_name field SHALL contain the project directory
name. The parent_session_id field SHALL contain the parent session ID string
or an empty string when the session has no parent. Unknown fields SHALL return
undefined (no match).

On OpenCode V2, `agent` and `model` SHALL be sourced from the session's
current selection rather than from the first user message. Classification
therefore MAY differ from the V1 result for a session that switches agent or
model mid-session. `first_user_message` SHALL remain the first user-authored
conversation message and SHALL NOT be taken from synthetic, system, shell, or
marker messages.

#### Scenario: project_name used in classification rule

- **GIVEN** config.yaml defines a classification rule with condition:
  field: project_name, values: [infra-scripts]
- **AND** the session is in the infra-scripts project
- **WHEN** the session is classified
- **THEN** the condition SHALL match against the project directory name

#### Scenario: Custom rule matches sub-agent sessions

- **GIVEN** config.yaml defines a classification rule with condition:
  field: parent_session_id, pattern: '.+'
- **AND** a session has parent_session_id = "sess-abc-123"
- **WHEN** the session is classified
- **THEN** the condition SHALL match because parent_session_id is non-empty

#### Scenario: Custom rule matches root sessions only

- **GIVEN** config.yaml defines a classification rule with condition:
  field: parent_session_id, values: [""]
- **AND** a session has no parent (parent_session_id is empty string in
  context)
- **WHEN** the session is classified
- **THEN** the condition SHALL match because parent_session_id is empty

#### Scenario: Mid-session agent switch changes classification input

- **GIVEN** a session starts with agent `plan` and later uses agent `build`
- **AND** a rule matches `field: agent, values: [build]`
- **WHEN** the session is classified
- **THEN** the rule SHALL match, because the current selection is `build`
- **AND** this difference from V1 behavior SHALL be documented for users

#### Scenario: Synthetic message does not become first_user_message

- **GIVEN** a session whose earliest message is a synthetic or system message
- **WHEN** the session is classified
- **THEN** first_user_message SHALL come from the first user-authored message
- **AND** SHALL NOT be the synthetic or system message
