## Why

The opencode-metrics plugin only captures metrics going forward from new
sessions. Users who install the plugin have an existing history of
sessions in OpenCode's internal database
(~/.local/share/opencode/opencode.db) that contains valuable cost,
token, and usage data. Without a backfill mechanism, the Grafana
dashboard starts empty and only becomes useful after days or weeks of
new session data accumulates.

OpenCode's internal database already stores all the raw data needed:
899 sessions, $3,409.71 total cost, token counts, timestamps, agent
types, and git diff stats. A one-time backfill script would immediately
populate the metrics database with this historical data, making the
Grafana dashboard useful from day one.

## What Changes

- Add `scripts/backfill.ts` -- a Bun script that reads historical
  sessions from OpenCode's internal database and writes them into the
  opencode-metrics database using the same schema and classification
  logic as the live plugin.
- Add a `make backfill` Makefile target for easy invocation.
- Update README.md with a "Historical Data Backfill" section covering
  usage, what it does, and how to verify the results.

## Capabilities

### New Capabilities

- `historical-backfill`: One-time import of historical session data from
  OpenCode's internal database into the opencode-metrics database,
  including full session classification using the same rule engine as
  the live plugin.

### Modified Capabilities

(none)

### Removed Capabilities

(none)

## Impact

- **Files added**: `scripts/backfill.ts`
- **Files modified**: `Makefile`, `README.md`
- **Backward compatibility**: Full. The backfill script is additive --
  it uses INSERT ... ON CONFLICT DO UPDATE, making it idempotent and
  safe to run alongside live plugin data.
- **Dependencies**: None new. Uses bun:sqlite (built-in) and imports
  the existing classifier and config modules from `src/`.
- **Breaking changes**: None.
- **Security**: The script reads OpenCode's database in read-only mode.
  It never modifies the source database.
