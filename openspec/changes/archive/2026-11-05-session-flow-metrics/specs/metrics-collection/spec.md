## ADDED Requirements

### Requirement: Permission Event Subscription

The plugin SHALL subscribe to `permission.asked` and `permission.replied`
events in addition to the session lifecycle event families. Permission
events SHALL be correlated by `sessionID` and permission identifier.
Receiving a permission event MUST NOT trigger a session capture on its own;
it SHALL only update per-session state that the next capture reads.

#### Scenario: Permission events are tracked without an early capture

- **GIVEN** a session is busy and receives a `permission.asked` event
- **WHEN** the plugin handles the event
- **THEN** the permission state for that session SHALL be updated
- **AND** no session capture SHALL be performed for that event

#### Scenario: Unrelated permission event is ignored

- **GIVEN** a `permission.replied` event without a matching open prompt
- **WHEN** the plugin handles the event
- **THEN** the event SHALL be ignored without error
- **AND** existing permission state SHALL remain unchanged

#### Scenario: Subscription still survives event gaps

- **GIVEN** the permission subscription stream ends or fails
- **WHEN** the subscription loop reconnects
- **THEN** lifecycle capture SHALL continue
- **AND** permission state that was already recorded SHALL be preserved
  for the current session
