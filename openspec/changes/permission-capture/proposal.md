## Why

The plugin already subscribes to `permission.asked` and `permission.replied`,
but it discards everything except a prompt count and an approval wait. The
events are ephemeral in OpenCode, so the detail cannot be reconstructed later.

Local measurements show the cost of this blind spot:

- 557 permission prompts across 342 captured sessions, with roughly 646,000
  seconds of cumulative wait.
- 846 persisted permission grants across 10 repositories, including broad
  grants such as `git push *`, `git reset *`, and unusable patterns such as
  `$cmd *`.
- The friction is unevenly distributed: a few canonical command patterns and
  projects account for most prompts, but the current schema cannot identify
  them.

The companion `ansible-role-ai` change `session-retro-loop` needs
event-level permission evidence to rank reductions and detect policy drift.
This change defines and implements contract version 1 for that evidence while
preserving the plugin's existing session metrics.

## What Changes

- Add a versioned `permission_contract` marker, a `permission_events` table,
  and a `v_permission_friction` aggregation view.
- Persist each asked/replied event with session, project, agent, model,
  action, canonical resource, salted resource hash, reply, save patterns,
  source tool/message, timestamps, and wait duration.
- Canonicalize and redact resources before persistence. Raw commands, paths,
  tokens, headers, and message text are not stored by default.
- Add a standalone JSON friction report for consumers that do not query SQLite
  directly.
- Add default-on capture with 90-day retention, an explicit disable switch,
  and owner-only database permissions.
- Keep the existing `permission_prompts` and `permission_wait_seconds`
  cumulative metrics unchanged.
- Add schema migration V6 → V7, tests, and documentation for the contract,
  sanitization rules, retention, and the no-backfill limitation.

## Capabilities

### New Capabilities

- `permission-capture`: Observer-only event capture, canonicalization,
  retention, and a versioned consumer contract.

### Modified Capabilities

- `metrics-storage`: Add the permission contract marker, event table, friction
  view, indexes, and schema migration V6 → V7.
- `metrics-collection`: Persist sanitized permission events alongside the
  existing cumulative prompt and wait metrics.

### Removed Capabilities

(none)

## Impact

- **Files modified**: `src/db.ts` (schema and migration), `src/permissions.ts`
  (event state and sanitized emission), `src/index.ts` (event handling),
  `src/config.ts` and `src/defaults.ts` (capture settings), `README.md`.
- **Files added**: `src/sanitizer.ts`, `src/sanitizer.test.ts`,
  `src/permission-store.ts`, `src/permission-store.test.ts`,
  `scripts/permission-report.ts`, `openspec/changes/permission-capture/`.
- **Backward compatibility**: Additive. Existing tables, metrics, and views
  are unchanged; the database schema version increments to 7.
- **Dependencies**: None new. Uses `bun:sqlite`, `node:crypto`, and the
  existing YAML configuration path.
- **Storage**: Bounded by event volume and 90-day retention; expected to be
  small compared with existing session metrics.
- **Performance**: One upsert per permission event, outside the capture path;
  no additional SDK calls.
- **Security**: Observer-only; fail-open; no raw secrets; owner-only database
  permissions; capture can be disabled.

## Constitution Alignment

Assessed against the Unbound Force org constitution.

### I. Autonomous Collaboration

**Assessment**: PASS

The contract is an asynchronous artifact: a versioned marker table, an event
table, and a view with stable column semantics. The consumer does not need to
call the plugin or wait for it; it reads the local database or the JSON report.
Provenance is recorded per event (session, project, agent, model, timestamps,
contract version, source tool).

### II. Composability First

**Assessment**: PASS

The plugin keeps its full standalone value: session metrics continue to work
when permission capture is disabled or its table is absent. Permission capture
is additive and auto-detected by consumers. No consumer is required for the
plugin to operate.

### III. Observable Quality

**Assessment**: PASS

The friction view and the JSON report are machine-parseable and stable for
minor versions. Contract version 1 is explicit. Every quality claim in this
proposal is backed by local measurements that a contributor can reproduce with
the documented queries and tests.

### IV. Testability

**Assessment**: PASS

The change is testable in isolation with a temporary `bun:sqlite` database and
synthetic events. Unit tests cover sanitization, upsert semantics, and
configuration. Integration tests cover event ingestion, late replies, the
friction view, retention cleanup, and fail-open behavior. The existing 80%
line-coverage gate remains the floor, and new modules must not reduce it.

### V. Security by Default

**Assessment**: PASS

Capture is observer-only and fail-open. Resources are canonicalized and
redacted before persistence; raw storage is disabled by default. The salt is
generated locally and stored with owner-only permissions. No new dependency is
added, and the database file keeps restrictive permissions. Capture can be
disabled without affecting sessions.
