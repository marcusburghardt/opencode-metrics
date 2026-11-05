## ADDED Requirements

### Requirement: Child Session Count Metric

The plugin SHALL record `child_sessions` for a captured session as the
number of stored sessions whose `parent_session_id` equals the captured
session's id. Grandchildren SHALL NOT be counted; recursive aggregation
remains the responsibility of the existing `parent_session_id` queries.

#### Scenario: Direct children only

- **GIVEN** session "root" has two direct children, and one of those
  children has its own child
- **WHEN** "root" is captured after all three sessions exist
- **THEN** `child_sessions` for "root" SHALL be 2

#### Scenario: Child captured before parent

- **GIVEN** a child session is captured before its parent has been
  captured for the first time
- **WHEN** the parent is later captured
- **THEN** the parent's `child_sessions` SHALL include that child

#### Scenario: Root session

- **GIVEN** a session with no stored sessions referencing it as parent
- **WHEN** it is captured
- **THEN** `child_sessions` SHALL be 0
