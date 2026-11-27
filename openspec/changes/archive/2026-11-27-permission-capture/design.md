## Context

`src/permissions.ts` tracks only cumulative counts and wait time per session.
`handlePermissionEvent` in `src/index.ts` receives `permission.asked` and
`permission.replied` payloads but passes only the session id, permission id, and
timestamp to the tracker. The payload also contains:

- `action` (for example `shell` or `external_directory`)
- `resources` (one or more matched resources)
- `save` (optional patterns persisted when the user replies `always`)
- `source` (optional tool message/id)
- `reply` (`once`, `always`, or `reject` on the reply event)

The metrics database uses `bun:sqlite` with a schema version tracked in
`PRAGMA user_version` (currently 6) and additive migrations. Session metrics are
cumulative rows in `measurements`; permission events are different: they are
discrete observations, so they need their own table and view.

## Goals / Non-Goals

### Goals

- Persist one sanitized row per permission request with its outcome.
- Expose a stable, versioned contract for local consumers.
- Keep the existing prompt and wait metrics unchanged.
- Make capture safe, bounded, and disableable.

### Non-Goals

- Approving, rejecting, delaying, or automating permissions.
- Reconstructing history that was never captured.
- Storing raw commands, paths, or message text by default.
- Replacing Grafana or the role's retrospective analysis.

## Decisions

### 1. Event table, not measurement rows

Permission events are discrete and need resource-level grouping, reply
outcomes, and per-event timestamps. Storing them in `measurements` would either
lose that detail or create an unbounded metric catalog. A dedicated
`permission_events` table keeps the dimensional metrics model intact and lets
the friction view aggregate without touching existing queries.

### 2. Contract version 1 and a local salt

`permission_contract` holds one row with `version = 1` and a randomly generated
per-install `salt`. The salt makes the resource hash stable for recurrence
detection while avoiding a plain hash of a possibly sensitive command. If the
salt is missing or the version is unsupported, consumers fall back to
session-level metrics.

### 3. Sanitize before persistence

A dedicated sanitizer module performs all normalization:

- Shell: remove leading assignments and quoting, then keep the command head and
  at most one subcommand token (`git push`, `make test`, `gh pr view`).
- Files and directories: map to a path class (`project`, `home`, `tmp`,
  `system`, `external`) and, for files, the extension. Never store the full
  path.
- Hash: `sha256(salt + "\0" + raw_resource)` truncated to a stable hex length.
- Redaction: strip authorization headers, tokens, private-key markers, email
  addresses in credentials, and long encoded values. If a resource cannot be
  sanitized confidently, store only the action and hash.

Canonicalization is intentionally lossy. The consumer only needs recurrence and
risk class, not the original command.

### 4. Upsert and ordering semantics

`permission.asked` inserts a row with `replied_at = NULL`, `reply = NULL`, and
`wait_ms = NULL`. `permission.replied` updates the matching row by permission
id. Duplicate asks upsert without resetting a recorded reply. A reply with no
matching ask is ignored, matching the existing tracker behavior. Wait time is
`replied_at - asked_at` when both are present and non-negative.

### 5. Keep the existing tracker as the counter

The existing `PermissionTracker` remains the source of the cumulative prompt
and wait metrics. The capture path is a separate write that receives the same
events. This keeps metric semantics unchanged and makes capture failure
independent of metric accounting. Both paths fail open: a database error is
logged and never blocks the session or prompt.

### 6. Capture settings and retention

Add configuration with safe defaults:

```yaml
permission_capture:
  enabled: true
  retention_days: 90
  store_raw: false
```

Cleanup runs on startup and at most once per day while the plugin is active.
It deletes events older than the retention window. Disabling capture stops new
writes but leaves existing rows and the view intact; the JSON report still
reads historical rows.

### 7. Standalone JSON report

`scripts/permission-report.ts` opens the metrics database read-only and prints
JSON for a requested window and optional project. It is the composability
surface for consumers that cannot query SQLite directly and the observable
quality artifact for the contract. The view remains the primary interface for
the role helper.

### 8. Security and permissions

- Database file permissions remain owner-only (`0o600`) and the directory
  `0o700` where created by the plugin.
- No raw resource is stored unless `store_raw` is explicitly enabled; even then
  secrets are redacted.
- The salt is stored in the database, not in logs or configuration.
- No new dependencies are introduced.

### 9. Test and coverage strategy

- Unit: sanitizer classes and redaction, hash stability, config defaults and
  invalid values, upsert and late-reply logic.
- Integration: temporary SQLite database, synthetic asked/replied sequences,
  friction view output, retention cleanup, report JSON shape, fail-open on a
  closed database.
- Coverage: keep the existing 80% line-coverage gate; new modules are included
  in `bun test --coverage` and must not reduce the measured total.

## Risks / Trade-offs

- **Lossy canonicalization** -> consumers see `git push`, not the destination.
  Accepted: the contract only needs recurrence and risk class.
- **Salt loss** -> recurrence grouping breaks if the database is rebuilt.
  Accepted: the contract is local and additive; a new salt starts a new series.
- **Plugin API changes** -> event field names may vary. The capture path
  validates types and stores what is present; unknown fields are ignored.
- **Storage growth** -> bounded by permission volume and retention; the event
  table has indexes on time and canonical resource.
- **Privacy** -> even canonical resources can hint at activity. Raw storage is
  off by default, the database is private, and capture can be disabled.

## Migration

Additive schema migration V6 → V7:

1. Create `permission_contract` if missing and seed version 1 plus a salt.
2. Create `permission_events` and its indexes if missing.
3. Create or replace `v_permission_friction`.
4. Set `PRAGMA user_version = 7`.

Existing tables, metrics, views, and consumers are untouched. No backfill is
possible; history begins when capture is enabled.
