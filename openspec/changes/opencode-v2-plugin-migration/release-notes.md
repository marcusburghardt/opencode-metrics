# Release Notes (draft)

Review text for the release-please PR. Release-please owns `CHANGELOG.md`,
the `package.json` version, and `.release-please-manifest.json`; this file is
the human-authored narrative that must survive into the GitHub Release body.

Target version: **0.5.0** (breaking change on a pre-1.0 line, so release-please
bumps `0.4.1` to `0.5.0` via `bump-minor-pre-major`).

## ⚠ BREAKING CHANGES

### OpenCode V2 is now required

opencode-metrics `0.5.0` targets the OpenCode V2 plugin API
(`@opencode/plugin@2.2.5`, `Plugin.define`). It does not load on OpenCode V1.

- **Supported host**: OpenCode 2.2 or later.
- **OpenCode V1 users**: stay on the `0.4.x` line and pin it explicitly
  (`@mburghardt/opencode-metrics@0.4.1`). `0.4.x` remains installable; no
  further releases are planned on that line.
- Loading `0.5.0` on an OpenCode V1 host fails to load: the host cannot consume
  the `Plugin.define` export, and OpenCode continues to start without the
  plugin. If you cannot upgrade OpenCode, pin
  `@mburghardt/opencode-metrics@0.4.1`.
- Separately, on an OpenCode V2 host whose resolved `@opencode/plugin` package
  falls outside `>=2.2.5 <3.0.0`, the plugin logs an error naming the supported
  range and disables collection instead of crashing.

### Upgrade steps

1. Upgrade OpenCode to 2.2 or later.
2. Upgrade the plugin.
3. If you use a local loader, replace it with the flat default-export file
   (`~/.config/opencode/plugins/opencode-metrics.ts`) or re-run
   `make install`.
4. Verify collection with the database query in the README verification
   section (a log line is not required).

## Changed

### `files_changed` now comes from session snapshots

`files_changed` is now the count of distinct files reported in assistant
session snapshots. It remains populated, but it can include files that were
touched rather than modified, so compare it with pre-0.5.0 values with that in
mind. The companion line counts are covered under Known Limitations.

### Session metrics are attributed to the session's own project

Sessions are now attributed using the session's own project id and location
instead of the plugin instance's directory. Sessions from other projects are
no longer written under the wrong `project_id`.

Historical rows are **not** retroactively corrected. Project-level totals for
new sessions may differ from what you saw before.

### `agent` and `model` come from the session's current selection

`agent` and `model` are read from the session's current selection rather than
from the first user message. For sessions that switch agent or model
mid-session, the stored values — and therefore the classification — can differ
from previous releases.

## Known Limitations

### Line counts are recorded as 0

`lines_added` and `lines_deleted` are recorded as 0 for sessions captured
through the OpenCode V2 plugin API, because V2 does not expose session diff
data to plugins. `files_changed` is still populated, from the distinct files
reported in assistant session snapshots. Code-impact charts will show a flat
zero line for V2-era sessions; this is expected, not data loss.

### Backfill does not cover OpenCode V2 sessions

OpenCode's legacy `session`/`message`/`part` tables stop at 2026-10-30.
`make backfill` reads only those tables, so it cannot import sessions created
after that date. V2-era sessions are collected by the live plugin from the
time it is installed forward.

### Metrics write gap during upgrade

No metrics are written between the V1 plugin stopping and the V2 plugin
starting. Upgrade OpenCode and the plugin in one step to keep the window
short; sessions that run entirely inside the gap are not captured, and
`make backfill` does not recover them.

## Upgrade Notes For Dashboards

- Code-impact panels that aggregate `lines_added`/`lines_deleted` will read 0
  for V2-era sessions. Pre-migration rows keep their values, so a time series
  spans two eras.
- Project-level cost comparisons across the upgrade date will shift for
  sessions that were previously misattributed.
