## MODIFIED Requirements

### Requirement: Classification Context Fields

ClassificationContext SHALL include the following fields available
for matching in classification rule conditions: agent, model,
first_user_message, part_content, bash_commands, message_count,
project_name, and parent_session_id. The parent_session_id field
SHALL contain the parent session ID string or an empty string when
the session has no parent.

Previously: ClassificationContext did not include parent_session_id.

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

## REMOVED Requirements

None.
