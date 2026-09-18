## MODIFIED Requirements

### Requirement: Automatic Metrics Capture

The extraction pipeline SHALL propagate the SDK session's `parentID`
field into the stored session record as `parent_session_id`. When
`parentID` is undefined or null, `parent_session_id` SHALL be stored
as NULL.

Previously: The SDK adapter extracted `parentID` but the extraction
function did not propagate it into `SessionRecord` or the database.

#### Scenario: Sub-agent session captures parent_session_id

- **GIVEN** the SDK returns a session with parentID = "sess-abc-123"
- **WHEN** the plugin processes the session idle event
- **THEN** the session record written to the database SHALL have
  parent_session_id = "sess-abc-123"

#### Scenario: Root session has NULL parent_session_id

- **GIVEN** the SDK returns a session with parentID = undefined
- **WHEN** the plugin processes the session idle event
- **THEN** the session record written to the database SHALL have
  parent_session_id = NULL

## REMOVED Requirements

None.
