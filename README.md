# opencode-metrics

Automatic session metrics collection for [OpenCode](https://opencode.ai).
Captures cost, token usage, session duration, code-impact stats, and
classification data into a local SQLite database — queryable with standard
SQL tools or Grafana dashboards.

## Quick Reference

### Install

**Requires OpenCode V2 (2.2 or later).** Releases from `0.5.0` target the
OpenCode V2 plugin API (`@opencode/plugin`) and do not load on OpenCode V1.
If you are still on OpenCode V1, pin the previous line — see
[Upgrading](#upgrading).

Install the published package by adding it to your OpenCode config
(`~/.config/opencode/opencode.json` or project-level `opencode.json`):

```jsonc
{
  "plugins": ["@mburghardt/opencode-metrics"]
}
```

No separate `npm install` required — OpenCode resolves the plugin on
startup.

Install from a local checkout by installing runtime dependencies, building,
and writing the loader file:

```sh
git clone https://github.com/marcusburghardt/opencode-metrics.git
cd opencode-metrics
bun install   # required: @opencode/plugin is a runtime dependency
make build
make install  # writes ~/.config/opencode/plugins/opencode-metrics.ts
```

```jsonc
{
  "plugins": ["~/.config/opencode/plugins/opencode-metrics.ts"]
}
```

See [From local checkout](#from-local-checkout) for the loader layout and
the alternative of referencing `dist/index.js` directly.

### What it collects

| Category       | Metrics                                                          |
|----------------|------------------------------------------------------------------|
| Cost           | `cost` (USD, own session only — sub-sessions are recorded separately) |
| Tokens         | `tokens_input`, `tokens_output`, `tokens_reasoning`, `tokens_cache_read`, `tokens_cache_write` |
| Derived        | `cache_hit_ratio`, `duration_seconds`                            |
| Code impact    | `files_changed`, `lines_added`, `lines_deleted` (line counts are `0` on OpenCode V2) |
| Activity       | `messages_total`                                                 |
| Artifacts      | `prs_created`, `prs_reviewed`, `issues_referenced`               |

All 15 metrics are recorded per session into a local SQLite database at
`~/.local/share/opencode-metrics/metrics.db`.

### Key commands

```sh
make backfill   # Import historical sessions from OpenCode's database
make test       # Run test suite with coverage
make lint       # Check code with Biome linter
make build      # Compile plugin to dist/index.js
```

### Configuration

Config file: `~/.local/share/opencode-metrics/config.yaml`
(auto-created on first run with sensible defaults).

```yaml
version: 1
classification_rules: [...]   # Session work-type classification
budget_rules: [...]           # Cost allocation tags
cost_pricing: [...]           # Custom per-token pricing for adjusted cost
```

### Quick queries

```sh
# Total sessions and cost
sqlite3 ~/.local/share/opencode-metrics/metrics.db \
  "SELECT COUNT(DISTINCT session_id) AS sessions,
          ROUND(SUM(value), 2) AS total_cost_usd
   FROM measurements WHERE metric_name = 'cost';"

# Cost by classification
sqlite3 ~/.local/share/opencode-metrics/metrics.db \
  "SELECT s.classification, ROUND(SUM(m.value), 2) AS cost
   FROM sessions s JOIN measurements m ON s.session_id = m.session_id
   WHERE m.metric_name = 'cost' GROUP BY s.classification ORDER BY cost DESC;"

# Today's cost (delta-based, accurate for multi-day sessions)
sqlite3 ~/.local/share/opencode-metrics/metrics.db \
  "SELECT ROUND(SUM(delta), 2) AS today FROM measurement_deltas
   WHERE metric_name = 'cost'
     AND date(recorded_at / 1000, 'unixepoch') = date('now');"
```

### Grafana

Works with the
[frser-sqlite-datasource](https://github.com/fr-ser/grafana-sqlite-datasource)
plugin. Mount `~/.local/share/opencode-metrics/` into the Grafana
container and point the datasource at `metrics.db`. See
[Grafana Integration](#grafana-integration) for details.

## Table of Contents

- [Quick Reference](#quick-reference)
- [Installation](#installation)
  - [From npm](#from-npm)
  - [From local checkout](#from-local-checkout)
  - [Ansible integration](#ansible-integration)
  - [Verifying the installation](#verifying-the-installation)
- [Historical Data Backfill](#historical-data-backfill)
  - [Quick start](#quick-start)
  - [What gets imported](#what-gets-imported)
  - [CLI options](#cli-options)
  - [Verifying the backfill](#verifying-the-backfill)
  - [Idempotency and concurrency](#idempotency-and-concurrency)
- [Configuration](#configuration)
  - [Config file location](#config-file-location)
  - [Config fields](#config-fields)
  - [Classification rules](#classification-rules)
  - [Worked examples](#worked-examples)
  - [Budget rules](#budget-rules)
  - [Data directory location](#data-directory-location)
- [Testing and Verification](#testing-and-verification)
  - [Verifying metrics collection](#verifying-metrics-collection)
  - [Example queries](#example-queries)
    - [Cost overview](#cost-overview)
    - [Token efficiency](#token-efficiency)
    - [Session analytics](#session-analytics)
    - [Code impact](#code-impact)
    - [Top sessions and KPIs](#top-sessions-and-kpis)
    - [Delta-based queries (accurate daily cost)](#delta-based-queries-accurate-daily-cost)
    - [PR and Issue Analytics](#pr-and-issue-analytics)
    - [Budget analytics](#budget-analytics)
  - [Running the test suite](#running-the-test-suite)
- [Metric Reference](#metric-reference)
- [Insights](#insights)
- [Cost Adjustment](#cost-adjustment)
  - [Why adjusted costs?](#why-adjusted-costs)
  - [Configuring cost pricing](#configuring-cost-pricing)
  - [Adjusted cost views](#adjusted-cost-views)
  - [Adjusted cost queries](#adjusted-cost-queries)
- [Upgrade and Uninstall](#upgrade-and-uninstall)
  - [Upgrading](#upgrading)
  - [Migrating from V1](#migrating-from-v1)
  - [Uninstalling](#uninstalling)
- [Troubleshooting](#troubleshooting)
  - [Common issues](#common-issues)
  - [Diagnostic commands](#diagnostic-commands)
  - [Recovery procedures](#recovery-procedures)
- [Grafana Integration](#grafana-integration)
  - [Schema overview](#schema-overview)
  - [Example Grafana queries](#example-grafana-queries)
  - [Quickstart with ansible-role-ai](#quickstart-with-ansible-role-ai)
  - [Manual Grafana setup](#manual-grafana-setup)

## Installation

### Prerequisites

- **OpenCode V2** (2.2 or later) — releases from `0.5.0` use the OpenCode
  V2 plugin API and do not load on OpenCode V1. OpenCode V1 users must stay
  on the `0.4.x` line (see [Upgrading](#upgrading)).
- **Bun** runtime — handled automatically by OpenCode (plugins run inside
  OpenCode's Bun process). A local checkout also needs Bun to install
  runtime dependencies and build.

### From npm

Add `@mburghardt/opencode-metrics` to the `plugins` array in your OpenCode configuration
file (`~/.config/opencode/opencode.json` or `opencode.json` in your project):

```jsonc
{
  "plugins": ["@mburghardt/opencode-metrics"]
}
```

OpenCode resolves the plugin from npm on startup. No separate `npm install`
step is required.

To pin an exact release (recommended for hosts that cannot upgrade past a
known-good version):

```jsonc
{
  "plugins": ["@mburghardt/opencode-metrics@0.5.0"]
}
```

### From local checkout

Install runtime dependencies **before** building. `@opencode/plugin` is a
runtime dependency of the published package, so a plain `git clone` without
`bun install` will not resolve the plugin API at load time.

```sh
git clone https://github.com/marcusburghardt/opencode-metrics.git
cd opencode-metrics
bun install
make build
```

OpenCode V2 loads a plugin **file** with a default export (a directory
containing `index.ts` is also accepted). `make install` writes the flat form
for you, globally:

```
~/.config/opencode/plugins/
└── opencode-metrics.ts   # export default plugin;
```

```sh
make install   # build + write the global loader file
make uninstall # remove it again
```

Reference the loader file in your OpenCode config:

```jsonc
{
  "plugins": ["~/.config/opencode/plugins/opencode-metrics.ts"]
}
```

The plugin is also auto-discovered from the plugins directory, so listing it
explicitly is optional.

Alternatively, skip the loader and point the `plugins` array straight at the
built entry point (configured via `"main"` in `package.json`):

```jsonc
{
  "plugins": ["./path/to/opencode-metrics/dist/index.js"]
}
```

OpenCode resolves local paths relative to the config file location.

### Ansible integration

If you manage OpenCode installations with
[ansible-role-ai](https://github.com/marcusburghardt/ansible-role-ai), add the
plugin to the `ai_opencode_plugins` variable:

```yaml
ai_opencode_plugins:
  - "@mburghardt/opencode-metrics"
```

The role merges this into the generated OpenCode configuration during
provisioning.

### Verifying the installation

1. **Verify the database** — after completing at least one prompt/response
   cycle, query the database directly. This is the primary check and does
   not depend on log capture:

   ```sh
   sqlite3 ~/.local/share/opencode-metrics/metrics.db \
     "SELECT COUNT(*) AS sessions FROM sessions;"
   ```

   A non-zero count confirms the plugin is loaded and collecting. If the
   database file does not exist yet, see
   [Database not created](#database-not-created).

2. **Verify the schema** — open the database and confirm the tables and
   views:

   ```sh
   sqlite3 ~/.local/share/opencode-metrics/metrics.db ".tables"
   ```

   Expected output:

   ```
   cost_pricing            session_artifacts       v_measurements
   measurement_deltas      sessions                v_session_artifacts
   measurements            v_adjusted_cost_deltas  v_sessions
   metric_definitions      v_adjusted_costs
   projects                v_measurement_deltas
   ```

   `measurement_deltas` and `cost_pricing` are part of the current schema,
   and the `v_` prefixes are SQL views over the base tables.

3. **Check the plugin log line** (secondary) — OpenCode forwards the
   plugin's `console.*` output to its log directory. A healthy start logs:

   ```
   [opencode-metrics] initialized
   ```

   Look in `~/.local/share/opencode/log/` (or
   `$XDG_DATA_HOME/opencode/log/` when `$XDG_DATA_HOME` is set). Log
   capture location varies by host version and logs rotate, so a missing
   line is not by itself evidence of failure — rely on step 1.

## Historical Data Backfill

The backfill script performs a one-time import of historical session data
from OpenCode's internal database into the opencode-metrics database. This
gives you full visibility into past sessions without waiting for new data
to accumulate through the live plugin.

> **Coverage caveat:** OpenCode's legacy `session`/`message`/`part` tables
> stop at 2026-10-30. `make backfill` reads only those tables, so it cannot
> import sessions created after that date. Sessions recorded through the
> OpenCode V2 plugin are collected live from the time the plugin is
> installed forward; `make backfill` does not close that gap.

### Quick start

```sh
make backfill
```

Zero configuration required. The script auto-detects the source database
at `~/.local/share/opencode/opencode.db` and writes to the standard
metrics database at `~/.local/share/opencode-metrics/metrics.db`.

### What gets imported

The backfill reads every session from OpenCode's internal database and
writes all 15 metrics for each one:

- **Token metrics:** `tokens_input`, `tokens_output`, `tokens_reasoning`,
  `tokens_cache_read`, `tokens_cache_write`
- **Cost:** `cost` (USD)
- **Derived:** `cache_hit_ratio`, `duration_seconds`
- **Diff stats:** `files_changed`, `lines_added`, `lines_deleted`
- **Activity:** `messages_total`
- **Artifacts:** `prs_created`, `prs_reviewed`, `issues_referenced`

PR and issue references are extracted from `gh` CLI commands in tool-call
output. Each extracted reference is also stored as a row in the
`session_artifacts` table for cross-session artifact queries.

Each session is classified using the same rule-based classifier as the
live plugin (the rules from your `config.yaml` are applied). Project
metadata is also imported.

### CLI options

```sh
bun run scripts/backfill.ts [options]
```

| Option            | Description                                         | Default                                     |
|-------------------|-----------------------------------------------------|---------------------------------------------|
| `--source <path>` | Path to OpenCode's internal database               | `~/.local/share/opencode/opencode.db`       |
| `--dest <path>`   | Path to the metrics data directory                  | `~/.local/share/opencode-metrics/`          |
| `--dry-run`       | Analyze source database without writing any data    | *(off)*                                     |
| `--help`          | Show usage information                              | *(off)*                                     |

Use `--dry-run` to preview how many sessions would be imported and their
classification distribution before committing any writes.

### Verifying the backfill

After running the backfill, verify the imported data:

```sh
# Total sessions imported
sqlite3 ~/.local/share/opencode-metrics/metrics.db \
  "SELECT COUNT(*) AS sessions FROM sessions;"

# Total cost across all sessions
sqlite3 ~/.local/share/opencode-metrics/metrics.db \
  "SELECT ROUND(SUM(value), 2) AS total_cost_usd
   FROM measurements WHERE metric_name = 'cost';"

# Classification distribution
sqlite3 ~/.local/share/opencode-metrics/metrics.db \
  "SELECT classification, COUNT(*) AS sessions
   FROM sessions GROUP BY classification ORDER BY sessions DESC;"

# Artifact counts by type
sqlite3 ~/.local/share/opencode-metrics/metrics.db \
  "SELECT artifact_type, COUNT(*) FROM session_artifacts GROUP BY 1;"
```

### Idempotency and concurrency

**Idempotent:** The backfill is safe to run multiple times. It uses
`INSERT ON CONFLICT DO UPDATE` (UPSERT) semantics, so re-running on the
same source data produces identical results without creating duplicate
rows.

**Concurrency:** For best results, run the backfill when the
opencode-metrics plugin is not actively writing (i.e., no OpenCode
sessions are running). While the database uses WAL mode and handles
contention with `busy_timeout` and retry logic, avoiding concurrent
writes eliminates the possibility of lock contention during the bulk
import.

## Configuration

### Config file location

```
~/.local/share/opencode-metrics/config.yaml
```

The config file is auto-created with sensible defaults on the plugin's
first run. If `$XDG_DATA_HOME` is set, the path becomes
`$XDG_DATA_HOME/opencode-metrics/config.yaml`.

The plugin never overwrites an existing config file — your customizations
are preserved across upgrades.

### Config fields

```yaml
# Schema version (currently 1)
version: 1

# Classification rules evaluated in order — first match wins.
classification_rules:
  - name: rule-name
    description: Human-readable description
    conditions:
      - field: agent
        values: ["build"]
    exclude:
      - field: bash_commands
        pattern: 'gh pr create'
```

| Field                  | Type   | Required | Description                                       |
|------------------------|--------|----------|---------------------------------------------------|
| `version`              | number | yes      | Config schema version. Currently `1`.              |
| `classification_rules` | array  | yes      | Ordered list of classification rules.              |
| `budget_rules`         | array  | no       | Ordered list of budget tagging rules. Defaults to `[]`. |

### Classification rules

Each rule has the following structure:

```yaml
- name: rule-name            # Required. Unique label stored in the sessions table.
  description: "..."         # Optional. Human-readable explanation.
  conditions:                # Required. Array of match conditions (AND logic).
    - field: agent           # Field to match against.
      values: ["build"]      # Exact match: field value is in this list.
    - field: first_user_message
      pattern: 'github\.com' # Regex match: field value matches this pattern.
  exclude:                   # Optional. Array of exclusion conditions (OR logic).
    - field: bash_commands
      pattern: 'gh pr create'
```

**Condition fields** available for matching:

| Field                | Type     | Description                                     |
|----------------------|----------|-------------------------------------------------|
| `agent`              | string   | Agent name (e.g., `build`, `plan`, `explore`)   |
| `model`              | string   | Model identifier                                |
| `first_user_message` | string   | Full text of the first user message              |
| `part_content`       | string   | Concatenated text from all message parts         |
| `bash_commands`      | string[] | Shell commands extracted from tool calls          |
| `message_count`      | number   | Total messages in the session                    |

**Matching types:**

- `pattern` — Regular expression tested against the field value. Array
  fields (`bash_commands`) are joined with newlines before matching.
- `values` — Exact match: the field value must appear in the values list.
  For array fields, any element matching is sufficient.

**Rule evaluation:**

1. Rules are evaluated **in order** — first match wins.
2. All `conditions` must match (AND logic).
3. If **any** `exclude` condition matches, the rule is rejected.
4. An empty `conditions: []` array always matches (vacuous truth) — use
   this for fallback rules.
5. If no rules match, the session is classified as `"ad-hoc"`.
6. Invalid regex patterns cause the entire rule to be skipped with a
   warning log.

**Default rules** (built-in, ordered):

| Priority | Name              | Matches                                          |
|----------|-------------------|--------------------------------------------------|
| 1        | `pr-review`       | PR URL in first message, excludes `gh pr create` |
| 2        | `pr-creation`     | `gh pr create` in bash commands                  |
| 3        | `openspec-workflow` | Spec artifact references with plan/build agent  |
| 4        | `multi-agent`     | Swarm agent prefixes (divisor-, cobalt-, gaze-)  |
| 5        | `exploration`     | Agent is `explore`                               |
| 6        | `planning`        | Agent is `plan`                                  |
| 7        | `implementation`  | Agent is `build`                                 |
| 8        | `ad-hoc`          | Fallback — empty conditions, always matches      |

### Worked examples

#### Adding a custom classification

Add a `debugging` rule that matches sessions where the first user message
mentions "bug", "error", or "fix", but is not a PR review:

```yaml
classification_rules:
  # Insert before the ad-hoc fallback but after more specific rules.
  # ... (keep existing rules above) ...

  - name: debugging
    description: Bug investigation and fixing sessions
    conditions:
      - field: first_user_message
        pattern: '\b(bug|error|fix)\b'
    exclude:
      - field: first_user_message
        pattern: 'github\.com/.+/pull/\d+'

  # Keep ad-hoc as the last rule (fallback).
  - name: ad-hoc
    description: Unclassified sessions (default fallback)
    conditions: []
```

#### Modifying PR review patterns

Change the PR review rule to also match GitLab merge request URLs:

```yaml
  - name: pr-review
    description: Pull/merge request review sessions
    conditions:
      - field: first_user_message
        pattern: '(github\.com/.+/pull/\d+|gitlab\.com/.+/merge_requests/\d+)'
    exclude:
      - field: bash_commands
        pattern: 'gh pr create|glab mr create'
```

#### Reordering rules

Rule order matters because first match wins. If you want `multi-agent`
to take priority over `openspec-workflow`, move it higher in the list:

```yaml
classification_rules:
  - name: pr-review
    # ...
  - name: pr-creation
    # ...
  - name: multi-agent        # Moved up — now checked before openspec-workflow
    # ...
  - name: openspec-workflow
    # ...
```

### Budget rules

Budget rules assign cost-tracking tags (`budget_tag`) to sessions,
enabling spend analysis per project, team, or initiative. They use the
same condition/exclude structure as classification rules but are
evaluated independently — a session gets both a `classification` and a
`budget_tag`.

Each rule has the following structure:

```yaml
budget_rules:
  - budget_tag: Q3-platform           # Required. Tag stored in sessions table.
    description: Q3 platform revamp   # Optional. Human-readable explanation.
    conditions:                       # Required. Array of match conditions (AND logic).
      - field: first_user_message
        pattern: '\[Q3-platform\]'
    exclude:                          # Optional. Array of exclusion conditions (OR logic).
      - field: agent
        values: ["explore"]
```

**Condition fields** — the same fields available to classification rules,
plus `project_name`:

| Field                | Type     | Description                                     |
|----------------------|----------|-------------------------------------------------|
| `agent`              | string   | Agent name (e.g., `build`, `plan`, `explore`)   |
| `model`              | string   | Model identifier                                |
| `first_user_message` | string   | Full text of the first user message              |
| `part_content`       | string   | Concatenated text from all message parts         |
| `bash_commands`      | string[] | Shell commands extracted from tool calls          |
| `message_count`      | number   | Total messages in the session                    |
| `project_name`       | string   | Project name from the OpenCode session context   |

**Rule evaluation:**

1. Rules are evaluated **in order** — first match wins.
2. All `conditions` must match (AND logic).
3. If **any** `exclude` condition matches, the rule is rejected.
4. If no rules match, the session's `budget_tag` is `NULL`.
5. Invalid regex patterns cause the rule to be skipped with a warning
   log.

> **Note:** Sessions that do not match any budget rule have
> `budget_tag = NULL`. Use `WHERE budget_tag IS NOT NULL` to select only
> budget-tagged sessions, or `WHERE budget_tag IS NULL` to find
> untagged spend.

#### Worked examples

##### Tagging by message prefix

Tag sessions where the first user message starts with a prefix like
`[Q3-platform]`:

```yaml
budget_rules:
  - budget_tag: Q3-platform
    description: Q3 platform revamp budget
    conditions:
      - field: first_user_message
        pattern: '\[Q3-platform\]'
```

##### Tagging by project name

Tag sessions from specific repositories using exact values:

```yaml
budget_rules:
  - budget_tag: team-backend
    conditions:
      - field: project_name
        values: ["api-service", "data-pipeline"]
```

##### Combined conditions with exclusion

Tag sessions by agent type and message content, excluding dry-run or
test sessions:

```yaml
budget_rules:
  - budget_tag: infra-ops
    conditions:
      - field: agent
        values: ["build"]
      - field: first_user_message
        pattern: 'terraform|ansible'
    exclude:
      - field: first_user_message
        pattern: 'test|dry-run'
```

##### Multiple budget rules

Budget rules are evaluated in order — first match wins. Place more
specific rules before general ones:

```yaml
budget_rules:
  # Specific: message prefix takes priority
  - budget_tag: Q3-platform
    conditions:
      - field: first_user_message
        pattern: '\[Q3-platform\]'

  # General: catch-all for backend projects
  - budget_tag: team-backend
    conditions:
      - field: project_name
        values: ["api-service", "data-pipeline"]
```

### Data directory location

The data directory (containing `metrics.db` and `config.yaml`) is
determined by the `$XDG_DATA_HOME` environment variable or defaults to
`~/.local/share/opencode-metrics/`. This follows the XDG Base Directory
Specification and cannot be overridden via config.yaml.

| `$XDG_DATA_HOME`     | Data directory                              |
|----------------------|---------------------------------------------|
| Set (e.g. `/data`)   | `$XDG_DATA_HOME/opencode-metrics/`          |
| Not set              | `~/.local/share/opencode-metrics/`          |

## Testing and Verification

### Verifying metrics collection

The fastest way to populate the metrics database is to run
`make backfill` (see [Historical Data Backfill](#historical-data-backfill)).
This imports all historical sessions in one step, giving you immediate
data to query and visualize.

> **Covers history only up to 2026-10-30.** The backfill reads OpenCode's
> legacy tables, so it cannot import later sessions. `make backfill` does
> not close that gap; V2-era sessions come from the live plugin only.

For ongoing collection, the plugin records metrics automatically. After
completing at least one OpenCode prompt/response cycle, verify data is
being collected:

```sh
sqlite3 ~/.local/share/opencode-metrics/metrics.db \
  "SELECT COUNT(*) AS sessions FROM sessions;"
```

You should see a non-zero count. If the count is 0 and you have not
run the backfill, check the [Troubleshooting](#troubleshooting) section.

### Example queries

The database stores timestamps as epoch milliseconds. For convenience,
four SQL views are provided that pre-convert timestamps:

- **`v_sessions`** — exposes `started_at_epoch` (seconds),
  `started_at_iso` (RFC3339), `ended_at_epoch`, `ended_at_iso`
- **`v_measurements`** — exposes `recorded_at_epoch` (seconds),
  `recorded_at_iso` (RFC3339)
- **`v_measurement_deltas`** — exposes `recorded_at_epoch` (seconds),
  `recorded_at_iso` (RFC3339), with the incremental `delta` column
- **`v_session_artifacts`** — exposes `recorded_at_epoch` (seconds),
  `recorded_at_iso` (RFC3339) for each artifact row, plus
  `session_id`, `artifact_type`, and `reference`

**When to use each view:**

- **`v_measurements`** — cumulative totals: total cost per session,
  total cost by classification, total tokens per model. Use when you
  need the final value for each session.
- **`v_measurement_deltas`** — time-sliced aggregation: daily cost,
  weekly trend, cost incurred today. Use when you need to attribute
  costs to the time period they were incurred, especially for
  multi-day sessions. Only meaningful for metrics with
  `aggregation = 'sum'` in `metric_definitions` (cost, tokens, counts).
  Non-summable metrics (`cache_hit_ratio` with `aggregation = 'avg'`)
  have mechanically correct deltas but `SUM(delta)` produces
  analytically meaningless results for ratios.

Use the views for Grafana panels and casual queries. Use the base
tables (`sessions`, `measurements`, `measurement_deltas`) when you
need raw millisecond precision.

#### Cost overview

**Daily cost:**

```sql
SELECT date(recorded_at_epoch, 'unixepoch', 'localtime') AS day,
       ROUND(SUM(value), 2) AS cost_usd
FROM v_measurements
WHERE metric_name = 'cost'
GROUP BY day
ORDER BY day DESC
LIMIT 14;
```

**Cost by classification:**

```sql
SELECT s.classification,
       COUNT(*) AS sessions,
       ROUND(SUM(m.value), 2) AS total_cost,
       ROUND(AVG(m.value), 4) AS avg_cost
FROM v_sessions s
JOIN v_measurements m ON s.session_id = m.session_id
WHERE m.metric_name = 'cost'
GROUP BY s.classification
ORDER BY total_cost DESC;
```

**Cost by project (top 15):**

```sql
SELECT p.name AS project,
       COUNT(DISTINCT s.session_id) AS sessions,
       ROUND(SUM(m.value), 2) AS cost_usd
FROM v_measurements m
JOIN v_sessions s ON m.session_id = s.session_id
JOIN projects p ON s.project_id = p.project_id
WHERE m.metric_name = 'cost'
GROUP BY p.name
ORDER BY cost_usd DESC
LIMIT 15;
```

**Cost by model:**

```sql
SELECT s.model,
       COUNT(*) AS sessions,
       ROUND(SUM(m.value), 2) AS cost_usd
FROM v_measurements m
JOIN v_sessions s ON m.session_id = s.session_id
WHERE m.metric_name = 'cost'
GROUP BY s.model
ORDER BY cost_usd DESC;
```

**Weekly cost trend:**

```sql
SELECT strftime('%Y-W%W',
         datetime(recorded_at_epoch, 'unixepoch')) AS week,
       ROUND(SUM(value), 2) AS cost_usd
FROM v_measurements
WHERE metric_name = 'cost'
GROUP BY week
ORDER BY week;
```

**7-day rolling average cost:**

```sql
SELECT day,
       ROUND(AVG(daily_cost) OVER (
         ORDER BY day ROWS BETWEEN 6 PRECEDING AND CURRENT ROW
       ), 2) AS rolling_avg
FROM (
  SELECT date(recorded_at_epoch, 'unixepoch') AS day,
         SUM(value) AS daily_cost
  FROM v_measurements
  WHERE metric_name = 'cost'
  GROUP BY day
)
ORDER BY day;
```

#### Token efficiency

**Token usage by type:**

```sql
SELECT metric_name AS token_type,
       ROUND(SUM(value) / 1000000.0, 2) AS millions
FROM v_measurements
WHERE metric_name IN (
  'tokens_input', 'tokens_output', 'tokens_reasoning',
  'tokens_cache_read', 'tokens_cache_write'
)
GROUP BY metric_name
ORDER BY millions DESC;
```

**Cache hit ratio (average per day):**

```sql
SELECT date(recorded_at_epoch, 'unixepoch', 'localtime') AS day,
       ROUND(AVG(value) * 100, 1) AS cache_hit_pct
FROM v_measurements
WHERE metric_name = 'cache_hit_ratio'
GROUP BY day
ORDER BY day DESC
LIMIT 14;
```

**Cache hit ratio by classification:**

```sql
SELECT s.classification,
       ROUND(AVG(m.value) * 100, 1) AS avg_cache_pct,
       COUNT(*) AS sessions
FROM v_measurements m
JOIN v_sessions s ON m.session_id = s.session_id
WHERE m.metric_name = 'cache_hit_ratio'
GROUP BY s.classification
ORDER BY avg_cache_pct DESC;
```

**Cost per 1K output tokens:**

```sql
SELECT ROUND(
  SUM(CASE WHEN metric_name = 'cost' THEN value END)
  / NULLIF(SUM(CASE WHEN metric_name = 'tokens_output'
    THEN value END), 0) * 1000, 4
) AS "$/1K output tokens"
FROM v_measurements;
```

#### Session analytics

**Session count by day:**

```sql
SELECT date(started_at_epoch, 'unixepoch', 'localtime') AS day,
       COUNT(*) AS sessions
FROM v_sessions
GROUP BY day
ORDER BY day DESC
LIMIT 14;
```

**Sessions by classification over time:**

```sql
SELECT date(started_at_epoch, 'unixepoch', 'localtime') AS day,
       classification,
       COUNT(*) AS count
FROM v_sessions
GROUP BY day, classification
ORDER BY day DESC;
```

**Average session duration by classification:**

```sql
SELECT s.classification,
       ROUND(AVG(m.value) / 60, 1) AS avg_minutes,
       COUNT(*) AS sessions
FROM v_measurements m
JOIN v_sessions s ON m.session_id = s.session_id
WHERE m.metric_name = 'duration_seconds'
GROUP BY s.classification
ORDER BY avg_minutes DESC;
```

**Duration distribution (bucketed):**

```sql
SELECT
  CASE
    WHEN value < 60 THEN '< 1 min'
    WHEN value < 300 THEN '1-5 min'
    WHEN value < 900 THEN '5-15 min'
    WHEN value < 1800 THEN '15-30 min'
    WHEN value < 3600 THEN '30-60 min'
    ELSE '> 60 min'
  END AS duration_bucket,
  COUNT(*) AS sessions
FROM v_measurements
WHERE metric_name = 'duration_seconds'
GROUP BY duration_bucket
ORDER BY MIN(value);
```

**Sessions by agent type:**

```sql
SELECT s.agent,
       COUNT(*) AS sessions,
       ROUND(SUM(m.value), 2) AS cost_usd
FROM v_sessions s
JOIN v_measurements m ON s.session_id = m.session_id
WHERE m.metric_name = 'cost'
GROUP BY s.agent
ORDER BY cost_usd DESC;
```

**Messages per session by classification:**

```sql
SELECT s.classification,
       ROUND(AVG(m.value), 0) AS avg_messages,
       MIN(m.value) AS min_messages,
       MAX(m.value) AS max_messages
FROM v_measurements m
JOIN v_sessions s ON m.session_id = s.session_id
WHERE m.metric_name = 'messages_total'
GROUP BY s.classification
ORDER BY avg_messages DESC;
```

#### Code impact

> **V2 limitation:** `lines_added` and `lines_deleted` are recorded as 0 for
> sessions captured on OpenCode V2 (the V2 plugin API exposes no session
> diff data). The queries below therefore return zero line counts for
> V2-era sessions; `files_changed` remains populated. See
> [Known metric limitations](#metric-reference).

**Lines changed over time:**

```sql
SELECT date(recorded_at_epoch, 'unixepoch', 'localtime') AS day,
       SUM(CASE WHEN metric_name = 'lines_added'
           THEN value ELSE 0 END) AS added,
       SUM(CASE WHEN metric_name = 'lines_deleted'
           THEN value ELSE 0 END) AS deleted
FROM v_measurements
WHERE metric_name IN ('lines_added', 'lines_deleted')
GROUP BY day
ORDER BY day DESC
LIMIT 14;
```

**Files changed by project:**

```sql
SELECT p.name AS project,
       SUM(m.value) AS files_changed
FROM v_measurements m
JOIN v_sessions s ON m.session_id = s.session_id
JOIN projects p ON s.project_id = p.project_id
WHERE m.metric_name = 'files_changed'
GROUP BY p.name
ORDER BY files_changed DESC
LIMIT 15;
```

**Cost per file changed:**

```sql
SELECT ROUND(
  SUM(CASE WHEN metric_name = 'cost' THEN value END)
  / NULLIF(SUM(CASE WHEN metric_name = 'files_changed'
    THEN value END), 0), 2
) AS "$ per file"
FROM v_measurements;
```

#### Top sessions and KPIs

**Top 20 most expensive sessions:**

```sql
SELECT s.title,
       s.classification,
       s.model,
       s.agent,
       p.name AS project,
       ROUND(m.value, 4) AS cost_usd,
       s.started_at_iso AS date
FROM v_sessions s
JOIN v_measurements m ON s.session_id = m.session_id
JOIN projects p ON s.project_id = p.project_id
WHERE m.metric_name = 'cost'
ORDER BY m.value DESC
LIMIT 20;
```

**Summary KPIs:**

```sql
SELECT
  COUNT(DISTINCT s.session_id) AS total_sessions,
  COUNT(DISTINCT s.project_id) AS total_projects,
  ROUND(SUM(CASE WHEN m.metric_name = 'cost'
    THEN m.value END), 2) AS total_cost_usd,
  ROUND(AVG(CASE WHEN m.metric_name = 'cost'
    THEN m.value END), 4) AS avg_session_cost,
  ROUND(AVG(CASE WHEN m.metric_name = 'cache_hit_ratio'
    THEN m.value END) * 100, 1) AS avg_cache_hit_pct,
  ROUND(SUM(CASE WHEN m.metric_name = 'tokens_output'
    THEN m.value END) / 1000000.0, 1) AS output_tokens_millions
FROM v_sessions s
JOIN v_measurements m ON s.session_id = m.session_id;
```

#### Grafana time-series queries

For Grafana panels using the frser-sqlite-datasource plugin, use the
`_iso` columns as the time column (parsed natively as RFC3339):

```sql
-- Time-series: daily cost (set time column to "recorded_at_iso", type "String")
SELECT recorded_at_iso AS time,
       SUM(value) AS cost
FROM v_measurements
WHERE metric_name = 'cost'
GROUP BY date(recorded_at_epoch, 'unixepoch')
ORDER BY time;
```

```sql
-- Time-series: cache hit ratio (set time column to "recorded_at_iso")
SELECT recorded_at_iso AS time,
       value AS cache_hit_ratio
FROM v_measurements
WHERE metric_name = 'cache_hit_ratio'
ORDER BY time;
```

#### Delta-based queries (accurate daily cost)

The `v_measurement_deltas` view provides accurate time-sliced
aggregation for multi-day sessions. Unlike `v_measurements` (which
stores the cumulative total per session), deltas record the incremental
change on each idle event — so `SUM(delta)` over a date range gives the
exact cost incurred during that period.

**Cost incurred today:**

```sql
SELECT ROUND(SUM(delta), 2) AS "Today's Cost"
FROM v_measurement_deltas
WHERE metric_name = 'cost'
  AND date(recorded_at_epoch, 'unixepoch') = date('now');
```

**Daily cost breakdown for a specific session:**

```sql
SELECT date(recorded_at_epoch, 'unixepoch') AS day,
       ROUND(SUM(delta), 2) AS cost_that_day
FROM v_measurement_deltas
WHERE session_id = 'ses_...'
  AND metric_name = 'cost'
GROUP BY day;
```

**Accurate daily cost trend (handles multi-day sessions correctly):**

```sql
SELECT date(recorded_at_epoch, 'unixepoch', 'localtime') AS day,
       ROUND(SUM(delta), 2) AS cost_usd
FROM v_measurement_deltas
WHERE metric_name = 'cost'
GROUP BY day
ORDER BY day DESC
LIMIT 14;
```

> **Note:** `SUM(delta)` is only meaningful for metrics with
> `aggregation = 'sum'` in `metric_definitions` (cost, tokens, counts).
> Non-summable metrics (`cache_hit_ratio` with `aggregation = 'avg'`)
> have mechanically correct deltas but `SUM(delta)` produces
> analytically meaningless results for ratios.

#### PR and Issue Analytics

**Cost per PR created (total and average):**

```sql
SELECT COUNT(*) AS total_prs,
       ROUND(SUM(m.value), 2) AS total_cost,
       ROUND(SUM(m.value) / NULLIF(COUNT(*), 0), 2) AS avg_cost_per_pr
FROM v_session_artifacts a
JOIN v_measurements m ON a.session_id = m.session_id
WHERE a.artifact_type = 'pr-created'
  AND m.metric_name = 'cost';
```

**Total cost to deliver a specific PR:**

```sql
SELECT a.reference AS pr,
       COUNT(DISTINCT a.session_id) AS sessions,
       ROUND(SUM(m.value), 2) AS total_cost
FROM v_session_artifacts a
JOIN v_measurements m ON a.session_id = m.session_id
WHERE a.reference = 'org/repo#123'
  AND m.metric_name = 'cost'
GROUP BY a.reference;
```

**Most expensive PRs:**

```sql
SELECT a.reference AS pr,
       COUNT(DISTINCT a.session_id) AS sessions,
       ROUND(SUM(m.value), 2) AS total_cost
FROM v_session_artifacts a
JOIN v_measurements m ON a.session_id = m.session_id
WHERE a.artifact_type = 'pr-created'
  AND m.metric_name = 'cost'
GROUP BY a.reference
ORDER BY total_cost DESC
LIMIT 20;
```

**Sessions that touched a specific PR:**

```sql
SELECT s.session_id,
       s.title,
       s.classification,
       a.artifact_type,
       ROUND(m.value, 4) AS cost_usd,
       s.started_at_iso AS date
FROM v_session_artifacts a
JOIN v_sessions s ON a.session_id = s.session_id
JOIN v_measurements m ON a.session_id = m.session_id
WHERE a.reference = 'org/repo#123'
  AND m.metric_name = 'cost'
ORDER BY s.started_at_iso;
```

**PR activity over time (PRs created per week):**

```sql
SELECT strftime('%Y-W%W',
         datetime(a.recorded_at_epoch, 'unixepoch')) AS week,
       COUNT(*) AS prs_created
FROM v_session_artifacts a
WHERE a.artifact_type = 'pr-created'
GROUP BY week
ORDER BY week;
```

**Cost per PR trend over time (weekly):**

```sql
SELECT strftime('%Y-W%W',
         datetime(a.recorded_at_epoch, 'unixepoch')) AS week,
       COUNT(*) AS prs,
       ROUND(SUM(m.value), 2) AS total_cost,
       ROUND(SUM(m.value) / NULLIF(COUNT(*), 0), 2) AS cost_per_pr
FROM v_session_artifacts a
JOIN v_measurements m ON a.session_id = m.session_id
WHERE a.artifact_type = 'pr-created'
  AND m.metric_name = 'cost'
GROUP BY week
ORDER BY week;
```

**PR activity by classification:**

```sql
SELECT s.classification,
       a.artifact_type,
       COUNT(*) AS artifact_count,
       COUNT(DISTINCT a.session_id) AS sessions
FROM v_session_artifacts a
JOIN v_sessions s ON a.session_id = s.session_id
GROUP BY s.classification, a.artifact_type
ORDER BY artifact_count DESC;
```

**PRs per session (batching efficiency):**

```sql
SELECT s.session_id,
       s.title,
       COUNT(*) AS prs_in_session,
       ROUND(m.value, 4) AS cost_usd
FROM v_session_artifacts a
JOIN v_sessions s ON a.session_id = s.session_id
JOIN v_measurements m ON a.session_id = m.session_id
WHERE a.artifact_type = 'pr-created'
  AND m.metric_name = 'cost'
GROUP BY s.session_id
ORDER BY prs_in_session DESC
LIMIT 20;
```

**Sessions with zero PRs/issues (non-deliverable spend):**

```sql
SELECT s.session_id,
       s.title,
       s.classification,
       ROUND(m.value, 4) AS cost_usd
FROM v_sessions s
JOIN v_measurements m ON s.session_id = m.session_id
LEFT JOIN v_session_artifacts a ON s.session_id = a.session_id
WHERE m.metric_name = 'cost'
  AND a.session_id IS NULL
ORDER BY m.value DESC
LIMIT 20;
```

**Cost per PR by project (repository-level ROI):**

```sql
SELECT p.name AS project,
       COUNT(DISTINCT a.reference) AS prs,
       ROUND(SUM(m.value), 2) AS total_cost,
       ROUND(SUM(m.value) / NULLIF(COUNT(DISTINCT a.reference), 0),
             2) AS cost_per_pr
FROM v_session_artifacts a
JOIN v_sessions s ON a.session_id = s.session_id
JOIN v_measurements m ON a.session_id = m.session_id
JOIN projects p ON s.project_id = p.project_id
WHERE a.artifact_type = 'pr-created'
  AND m.metric_name = 'cost'
GROUP BY p.name
ORDER BY cost_per_pr DESC;
```

#### Budget analytics

Budget analytics queries use the `budget_tag` column on `v_sessions` to
slice cost data by budget. Sessions that do not match any budget rule
have `budget_tag = NULL`.

**Total cost per budget tag:**

```sql
SELECT s.budget_tag,
       COUNT(*) AS sessions,
       ROUND(SUM(m.value), 2) AS total_cost
FROM v_sessions s
JOIN v_measurements m ON s.session_id = m.session_id
WHERE m.metric_name = 'cost'
  AND s.budget_tag IS NOT NULL
GROUP BY s.budget_tag
ORDER BY total_cost DESC;
```

**Daily cost per budget tag:**

```sql
SELECT date(m.recorded_at_epoch, 'unixepoch', 'localtime') AS day,
       s.budget_tag,
       ROUND(SUM(m.value), 2) AS cost_usd
FROM v_sessions s
JOIN v_measurements m ON s.session_id = m.session_id
WHERE m.metric_name = 'cost'
  AND s.budget_tag IS NOT NULL
GROUP BY day, s.budget_tag
ORDER BY day DESC, cost_usd DESC;
```

**Cost by budget and classification (cross-tabulation):**

```sql
SELECT s.budget_tag,
       s.classification,
       COUNT(*) AS sessions,
       ROUND(SUM(m.value), 2) AS total_cost
FROM v_sessions s
JOIN v_measurements m ON s.session_id = m.session_id
WHERE m.metric_name = 'cost'
  AND s.budget_tag IS NOT NULL
GROUP BY s.budget_tag, s.classification
ORDER BY s.budget_tag, total_cost DESC;
```

**Sessions by budget tag:**

```sql
SELECT s.budget_tag,
       COUNT(*) AS sessions,
       ROUND(AVG(m.value), 4) AS avg_cost,
       ROUND(MIN(m.value), 4) AS min_cost,
       ROUND(MAX(m.value), 4) AS max_cost
FROM v_sessions s
JOIN v_measurements m ON s.session_id = m.session_id
WHERE m.metric_name = 'cost'
  AND s.budget_tag IS NOT NULL
GROUP BY s.budget_tag
ORDER BY sessions DESC;
```

**Budget spend over time (weekly):**

```sql
SELECT strftime('%Y-W%W',
         datetime(m.recorded_at_epoch, 'unixepoch')) AS week,
       s.budget_tag,
       ROUND(SUM(m.value), 2) AS cost_usd
FROM v_sessions s
JOIN v_measurements m ON s.session_id = m.session_id
WHERE m.metric_name = 'cost'
  AND s.budget_tag IS NOT NULL
GROUP BY week, s.budget_tag
ORDER BY week, cost_usd DESC;
```

**Untagged spend (sessions without a budget tag):**

```sql
SELECT COUNT(*) AS sessions,
       ROUND(SUM(m.value), 2) AS untagged_cost
FROM v_sessions s
JOIN v_measurements m ON s.session_id = m.session_id
WHERE m.metric_name = 'cost'
  AND s.budget_tag IS NULL;
```

### Running the test suite

```sh
make test
```

This runs `bun test --coverage` and reports line coverage per module. The
project targets a minimum of 80% line coverage.

To run a specific test file:

```sh
bun test src/classifier.test.ts
```

To lint the codebase:

```sh
make lint
```

## Metric Reference

All 15 metrics are recorded per session on every idle event (UPSERT
semantics — the latest cumulative value is stored). Descriptions below
match the `metric_definitions` table in the database.

| Metric Name        | Unit    | Description                                    | Aggregation |
|--------------------|---------|------------------------------------------------|-------------|
| `cost`             | usd     | Total session cost in USD (own session only; sub-sessions are recorded separately) | sum |
| `tokens_input`     | tokens  | Non-cached input tokens sent to the model      | sum         |
| `tokens_output`    | tokens  | Output tokens generated by the model           | sum         |
| `tokens_reasoning` | tokens  | Reasoning tokens consumed by the model         | sum         |
| `tokens_cache_read`| tokens  | Input tokens served from prompt cache          | sum         |
| `tokens_cache_write`| tokens | Input tokens written to prompt cache           | sum         |
| `cache_hit_ratio`  | ratio   | Fraction of input tokens served from cache     | avg         |
| `duration_seconds` | seconds | Wall-clock session duration in seconds         | sum         |
| `files_changed`    | count   | Distinct files reported in assistant session snapshots | sum  |
| `lines_added`      | count   | Lines added in file changes (0 for sessions recorded on OpenCode V2) | sum |
| `lines_deleted`    | count   | Lines deleted in file changes (0 for sessions recorded on OpenCode V2) | sum |
| `messages_total`   | count   | Total conversation messages exchanged in the session | sum   |
| `prs_created`      | count   | PRs created in the session                     | sum         |
| `prs_reviewed`     | count   | PRs reviewed in the session                    | sum         |
| `issues_referenced`| count   | Issues referenced in the session               | sum         |

**Known metric limitations:**

- `lines_added` / `lines_deleted` are recorded as **0** for sessions
  captured through the OpenCode V2 plugin API, because V2 does not expose
  session diff data to plugins. `files_changed` is still populated, from
  the distinct files reported in assistant session snapshots. Code-impact
  charts show a flat zero line for V2-era sessions; this is expected, not
  data loss. Rows written before the migration keep their original values,
  so a time series can span both behaviors.
- `files_changed` counts distinct files named in assistant session
  snapshots. It can include files that were touched but not modified, so
  it is not directly comparable with diff-derived counts from older
  releases.
- `cost` is the session's own cost as reported by the host. Sub-sessions
  (sub-agents) are recorded as separate session rows with their own cost.

**Derived metrics:**

- `cache_hit_ratio` = `tokens_cache_read / (tokens_cache_read + tokens_input)`.
  Returns 0 when the denominator is 0.
- `duration_seconds` = `(time_updated - time_created) / 1000`.
  Returns 0 when either timestamp is missing or the result would be negative.

**Aggregation column** indicates the recommended SQL aggregate function
for dashboard panels: `sum` for additive metrics, `avg` for ratios.

**Timestamps:** All timestamp fields (`started_at`, `ended_at`,
`recorded_at`) store Unix epoch **milliseconds** as INTEGER values. Use
`date(column / 1000, 'unixepoch')` in SQL queries.

## Insights

With PR and issue tracking, several analytics become possible that
connect cost data to concrete deliverables:

**Cost-per-deliverable** — Calculate the cost per PR created, cost per
review performed, and cost per PR broken down by project or model. This
answers "how much does each unit of output cost?" rather than measuring
raw spend.

**Value density** — Identify how many PRs each session produces (batching
efficiency), what fraction of spend goes to sessions with zero
deliverables (non-deliverable spend ratio), and which sessions produce
the most value relative to their cost.

**PR lifecycle** — Track the total cost to deliver a specific PR across
all sessions that touched it. A single PR may span creation, review
rounds, and follow-up fixes — cross-session aggregation via the
`session_artifacts` table reveals the true cost of delivery.

**Cross-metric correlations** — Combine artifact counts with existing
metrics for deeper analysis:
- **Review quality indicators:** `prs_reviewed × tokens_output` measures
  feedback volume per review.
- **Creation efficiency:** `prs_created × files_changed` correlates PR
  size with cost.
- **Project-level ROI:** Compare total cost by project against PRs
  produced by project to identify which repositories get the best return
  on AI spend.

**Trend analysis** — Track changes over time to spot improvements or
regressions:
- PRs created per week (delivery velocity)
- Cost per PR over time (efficiency trend)
- Review rounds per PR declining (quality improvement)
- PR creation by classification (workflow evolution)
- Issue-to-PR ratio (planning overhead)

## Cost Adjustment

### Why adjusted costs?

The `cost` metric reported by OpenCode reflects the provider's billed
amount. When you access models through a reseller or proxy API (e.g.,
Google Vertex AI for Anthropic models, or an internal API gateway),
the per-token pricing may differ from the direct provider's rates.

Cost adjustment lets you define your actual per-token prices in
`config.yaml`. The plugin creates SQL views that recompute session costs
using your prices — giving you side-by-side visibility into billed cost
vs. adjusted cost without modifying the raw data.

### Configuring cost pricing

Add a `cost_pricing` array to your `config.yaml`:

```yaml
cost_pricing:
  # Rules are matched in order — first match wins (SQL LIKE pattern).
  - model: "%claude-opus-4%"
    input_price: 15.0        # USD per million input tokens
    output_price: 75.0       # USD per million output tokens
    cache_read_price: 1.5    # USD per million cache-read tokens
    cache_write_price: 3.75  # USD per million cache-write tokens
    reasoning_price: 75.0    # USD per million reasoning tokens
    description: "Vertex AI Anthropic pricing"

  - model: "%claude-sonnet%"
    input_price: 3.0
    output_price: 15.0
    description: "Vertex AI Sonnet pricing"
```

| Field              | Type   | Required | Description                                             |
|--------------------|--------|----------|---------------------------------------------------------|
| `model`            | string | yes      | SQL LIKE pattern matched against the session model.     |
| `input_price`      | number | yes      | USD per million input tokens.                           |
| `output_price`     | number | yes      | USD per million output tokens.                          |
| `cache_read_price` | number | no       | USD per million cache-read tokens. Defaults to 0.       |
| `cache_write_price`| number | no       | USD per million cache-write tokens. Defaults to 0.      |
| `reasoning_price`  | number | no       | USD per million reasoning tokens. Defaults to `output_price`. |
| `description`      | string | no       | Human-readable label for documentation.                 |

When `cost_pricing` is absent or empty, the plugin behaves identically
to versions without this feature — no adjusted cost computation occurs
and the views return `original_cost` for all sessions.

Rules are synced to the `cost_pricing` database table on every startup
using a full-replace strategy. The table is created by the V4 schema
migration.

### Adjusted cost views

Two SQL views provide adjusted cost data:

**`v_adjusted_costs`** — cumulative adjusted cost per session.

| Column             | Description                                             |
|--------------------|---------------------------------------------------------|
| `session_id`       | Session identifier.                                     |
| `model`            | Model string from the session.                          |
| `classification`   | Session classification label.                           |
| `budget_tag`       | Budget tag (NULL if untagged).                           |
| `project_id`       | Project identifier.                                     |
| `original_cost`    | The `cost` metric value reported by the provider.       |
| `adjusted_cost`    | Recomputed cost using your pricing rules, or `original_cost` if no rule matches. |
| `cost_difference`  | `adjusted_cost - original_cost`.                        |
| `recorded_at_epoch`| Epoch seconds.                                          |
| `recorded_at_iso`  | ISO-8601 timestamp string.                              |

**`v_adjusted_cost_deltas`** — time-sliced adjusted cost per delta
(for accurate daily aggregation of multi-day sessions).

| Column                | Description                                          |
|-----------------------|------------------------------------------------------|
| `session_id`          | Session identifier.                                  |
| `model`               | Model string from the session.                       |
| `classification`      | Session classification label.                        |
| `budget_tag`          | Budget tag (NULL if untagged).                        |
| `project_id`          | Project identifier.                                  |
| `original_cost_delta` | The `cost` delta reported by the provider.           |
| `adjusted_cost_delta` | Recomputed cost delta using your pricing rules.      |
| `cost_delta_difference`| `adjusted_cost_delta - original_cost_delta`.        |
| `recorded_at_epoch`   | Epoch seconds.                                       |
| `recorded_at_iso`     | ISO-8601 timestamp string.                           |

The adjusted cost formula applied by both views:

```
(tokens_input × input_price / 1,000,000) +
(tokens_output × output_price / 1,000,000) +
(tokens_cache_read × COALESCE(cache_read_price, 0) / 1,000,000) +
(tokens_cache_write × COALESCE(cache_write_price, 0) / 1,000,000) +
(tokens_reasoning × COALESCE(reasoning_price, output_price) / 1,000,000)
```

### Adjusted cost queries

**Daily adjusted cost:**

```sql
SELECT date(recorded_at_epoch, 'unixepoch', 'localtime') AS day,
       ROUND(SUM(adjusted_cost), 2) AS adjusted_usd,
       ROUND(SUM(original_cost), 2) AS original_usd,
       ROUND(SUM(cost_difference), 2) AS difference
FROM v_adjusted_costs
GROUP BY day
ORDER BY day DESC
LIMIT 14;
```

**Cost difference by model:**

```sql
SELECT model,
       COUNT(*) AS sessions,
       ROUND(SUM(original_cost), 2) AS original_usd,
       ROUND(SUM(adjusted_cost), 2) AS adjusted_usd,
       ROUND(SUM(cost_difference), 2) AS difference
FROM v_adjusted_costs
GROUP BY model
ORDER BY difference;
```

**Grafana time-series — daily adjusted cost (delta-based):**

```sql
SELECT date(recorded_at_epoch, 'unixepoch') AS time,
       ROUND(SUM(adjusted_cost_delta), 4) AS adjusted_cost,
       ROUND(SUM(original_cost_delta), 4) AS original_cost
FROM v_adjusted_cost_deltas
GROUP BY time
ORDER BY time;
```

**Adjusted cost by budget tag:**

```sql
SELECT s.budget_tag,
       ROUND(SUM(a.original_cost), 2) AS original_usd,
       ROUND(SUM(a.adjusted_cost), 2) AS adjusted_usd,
       ROUND(SUM(a.cost_difference), 2) AS difference
FROM v_adjusted_costs a
JOIN v_sessions s ON a.session_id = s.session_id
WHERE s.budget_tag IS NOT NULL
GROUP BY s.budget_tag
ORDER BY difference;
```

## Upgrade and Uninstall

### Upgrading

**Check your host first.** Releases from `0.5.0` require **OpenCode V2
(2.2 or later)**. They do not load on OpenCode V1.

```sh
opencode --version
```

#### Same release line

Update the plugin to the latest version within the current line:

```sh
npm update @mburghardt/opencode-metrics
```

Or, if installed from a local checkout:

```sh
cd opencode-metrics
git pull
bun install
make build
```

**Data preservation:** Your existing `metrics.db` database and
`config.yaml` are preserved across same-line upgrades. The schema uses
`CREATE TABLE IF NOT EXISTS` and `INSERT OR IGNORE` for metric definitions,
so the database is never destructively modified. New metrics are additive
rows. Schema versioning (`PRAGMA user_version`, currently `6`) ensures
migrations are applied automatically on startup.

#### Across the breaking line (OpenCode V1 → V2)

`0.5.0` is a breaking release. Before upgrading, know the host requirement:

- The current line (`0.5.x` and later) requires **OpenCode 2.2+**.
- The last release supporting OpenCode V1 is **`0.4.1`**; the `0.4.x` line
  is the V1-compatible line and receives no further planned releases.

**If you cannot upgrade OpenCode**, pin the previous line explicitly:

```jsonc
{
  "plugins": ["@mburghardt/opencode-metrics@0.4.1"]
}
```

or, for a local install:

```sh
npm install @mburghardt/opencode-metrics@0.4.1
```

**If you can upgrade**, update OpenCode to 2.2+ first, then update the
plugin. On a V1 host, loading `0.5.0` fails to load and OpenCode continues
to start without the plugin — collection stops silently, so upgrade the
host first.

Three behavior changes apply to sessions captured after the upgrade:

1. **`files_changed` comes from session snapshots.** It is the count of
   distinct files reported in assistant session snapshots. It can include
   files that were touched rather than modified, so it is not directly
   comparable with pre-`0.5.0` values.
2. **Sessions are attributed to their own project.** Metrics use the
   session's project id and location instead of the plugin instance's
   directory. Sessions from other projects are no longer written under the
   wrong `project_id`.
3. **`agent` and `model` come from the session's current selection**, not
   from the first user message. For sessions that switch agent or model
   mid-session, the stored values — and therefore the classification — can
   differ from previous releases.

What stops being populated:

- `lines_added` and `lines_deleted` are recorded as **0** for V2-era
  sessions, because the V2 plugin API exposes no session diff data.
  `files_changed` continues to be populated.
- No metrics are written between the V1 plugin stopping and the V2 plugin
  starting. Upgrade the host and plugin in one step to keep that window
  short; sessions that run entirely inside the gap are not captured, and
  `make backfill` does not recover them.
- `make backfill` cannot import sessions created after 2026-10-30 (see the
  [coverage caveat](#historical-data-backfill)).

Historical rows are **not** re-attributed or rewritten. Project-level
totals for new sessions may differ from what you saw before, and a time
series can span both eras.

### Migrating from V1

**Audience:** users running the `0.4.x` plugin line on OpenCode V1 who want
to move to the `0.5.x` line.

**Prerequisites:**

- An OpenCode installation you can upgrade to **2.2 or later**.
- Bun on `PATH` if you build from a local checkout.
- A backup copy of the metrics database (optional but recommended):
  `cp ~/.local/share/opencode-metrics/metrics.db ~/metrics.db.bak`.

**Steps:**

1. **Upgrade OpenCode first.** The V2 plugin cannot load on a V1 host.

   ```sh
   opencode --version   # must be 2.2 or later
   ```

2. **Upgrade the plugin.** Remove any explicit version pin, or pin the new
   line:

   ```jsonc
   {
     "plugins": ["@mburghardt/opencode-metrics@0.5.0"]
   }
   ```

   If you install from a local checkout, pull and install runtime
   dependencies before building:

   ```sh
   cd opencode-metrics
   git pull
   bun install
   make build
   ```

3. **Replace a V1 loader.** OpenCode V2 expects a plugin **file** with a
   **default export** (a directory containing `index.ts` also works).
   `make install` writes the flat form
   (`~/.config/opencode/plugins/opencode-metrics.ts`) and removes any legacy
   directory loader:

   ```sh
   make install
   ```

   If you maintain the loader by hand, replace the named export with
   `export default plugin;`.

4. **Register the loader** (optional — the plugins directory is
   auto-discovered) in your `opencode.json` `plugins` array:

   ```jsonc
   {
     "plugins": ["~/.config/opencode/plugins/opencode-metrics.ts"]
   }
   ```

5. **Restart OpenCode** and complete one prompt/response cycle.

**Verification:**

```sh
sqlite3 ~/.local/share/opencode-metrics/metrics.db \
  "SELECT COUNT(*) AS sessions FROM sessions;"

sqlite3 ~/.local/share/opencode-metrics/metrics.db "PRAGMA user_version;"
```

The session count must increase after a new session, and `user_version`
must report `5`. The `[opencode-metrics] initialized` log line is a
secondary signal only; see
[Verifying the installation](#verifying-the-installation).

**Rollback:** to return to the V1 line, pin the plugin and downgrade the
host:

```jsonc
{
  "plugins": ["@mburghardt/opencode-metrics@0.4.1"]
}
```

```sh
opencode --version   # must be a V1 release that the 0.4.x line supports
```

Your existing database is reused; migrations only add tables and views, so
a downgrade does not require restoring a backup.

### Uninstalling

1. Remove the plugin from your OpenCode configuration:

   ```jsonc
   {
     "plugins": [
       // Remove "@mburghardt/opencode-metrics" from this array
     ]
   }
   ```

2. Remove a locally installed loader. If you used `make install`, run:

   ```sh
   make uninstall
   ```

   It removes both the V2 loader file
   (`~/.config/opencode/plugins/opencode-metrics.ts`) and any legacy
   directory loader. To remove them by hand:

   ```sh
   rm -f ~/.config/opencode/plugins/opencode-metrics.ts
   rm -rf ~/.config/opencode/plugins/opencode-metrics
   ```

3. (Optional) Delete the data directory:

   ```sh
   rm -rf ~/.local/share/opencode-metrics
   ```

   This removes `metrics.db`, `config.yaml`, and any WAL/SHM files. If
   `$XDG_DATA_HOME` is set, delete `$XDG_DATA_HOME/opencode-metrics`
   instead.

### Maintaining releases

Releases are produced by release-please from conventional commits; do not
hand-edit `CHANGELOG.md`, the `package.json` version, or
`.release-please-manifest.json`.

The publish workflows push a new version under the `next` dist-tag, verify the
published tarball (`scripts/verify-published-artifact.sh`), and only then
promote it to `latest`. If a release is found to be broken:

```sh
# 1. Move the latest tag back to the last good version
npm dist-tag add @mburghardt/opencode-metrics@<last-good> latest

# 2. Mark the broken version so it is not installed by accident
npm deprecate @mburghardt/opencode-metrics@<broken> "Broken release; use <last-good>"

# 3. Land the fix and publish a patch release the normal way
```

If the verification step failed before promotion, `latest` was never moved:
fix the problem, land another commit, and let the next release PR run. The
GitHub Release and its tag remain in place and can stay published once a
working artifact is promoted.

## Troubleshooting

### Common issues

#### Plugin not loading

**Symptom:** No new rows appear in `sessions` (and no
`[opencode-metrics] initialized` message in logs).

**Causes and fixes:**

- **Plugin not in config:** Verify `@mburghardt/opencode-metrics` appears in the
  `plugins` array of your OpenCode config file.
- **Wrong config file:** OpenCode reads `~/.config/opencode/opencode.json`
  (global) or `opencode.json` (project-local). Ensure you edited the
  correct one.
- **npm resolution failure:** If using the npm name, ensure network
  connectivity on first run. OpenCode needs to download the plugin.
- **Local path incorrect:** If using a local path, ensure the path
  resolves to a directory containing `package.json` with a valid `main`
  entry, and that `bun install` has run so `@opencode/plugin` resolves.

#### Plugin loaded on an unsupported host

**Symptom:** OpenCode starts normally but the plugin never collects
anything. On an OpenCode V1 host you will see no plugin log output at all —
the module cannot be imported, so the plugin cannot log a message.

**Cause:** `0.5.x` (and later) targets the OpenCode V2 plugin API
(`@opencode/plugin`, `Plugin.define`, default export). An OpenCode V1 host
cannot consume the export, so it silently skips the plugin.

**Resolution:**

1. Check the host version:

   ```sh
   opencode --version
   ```

2. If it is older than 2.2, either upgrade OpenCode or return to the V1
   line by pinning `0.4.1`:

   ```jsonc
   {
     "plugins": ["@mburghardt/opencode-metrics@0.4.1"]
   }
   ```

   On a V2 host, the plugin runs a runtime guard against
   `@opencode/plugin`: a resolved version outside `>=2.2.5 <3.0.0` logs an
   error naming the supported range and disables collection instead of
   crashing.

#### Loader present but not registering

**Symptom:** A loader file exists under
`~/.config/opencode/plugins/` (or `.opencode/plugins/`), but nothing is
collected and `opencode.json` does not list it.

**Causes and fixes:**

- **Loader not listed:** a loader is only loaded when it is auto-discovered
  in the plugins directory or appears in an `opencode.json` `plugins` array.
  Add it:

  ```jsonc
  {
    "plugins": ["~/.config/opencode/plugins/opencode-metrics.ts"]
  }
  ```

- **Legacy named export:** OpenCode V2 requires a **default export**. A V1
  loader that ends with a named export (for example
  `export const plugin = ...`) loads but does not register. Re-run
  `make install` to write the flat loader at
  `~/.config/opencode/plugins/opencode-metrics.ts`, or change the
  last line to `export default plugin;`.
- **Loader points at a missing build:** the generated loader imports
  the checkout's `dist/index.js`. Run `make build` in that checkout.

#### Nothing collected after upgrade

**Symptom:** Existing sessions are present, but no new session rows appear
after upgrading OpenCode and the plugin.

**Causes and fixes:**

- **Host still on V1:** see [Plugin loaded on an unsupported host](#plugin-loaded-on-an-unsupported-host).
- **Install shaped for V1:** a leftover loader using a named export. Run
  `make install` and confirm the flat default-export loader.
- **Runtime dependency missing (local checkout):** `@opencode/plugin` is a
  runtime dependency. Run `bun install` in the checkout, then `make build`.
- **Subscription stopped:** the plugin subscribes to `session.status`,
  `session.idle`, and the `session.execution.*` event families. If the event
  stream ends after repeated failures, an error line explains why and the
  plugin stops subscribing for that session. Restart OpenCode after fixing
  the cause.
- **Gap during the upgrade:** sessions that ran entirely between the V1
  plugin stopping and the V2 plugin starting are not captured, and
  `make backfill` does not recover them.

#### Missing console log lines

**Symptom:** The plugin collects metrics, but no `[opencode-metrics]` lines
appear where you expect them.

**Cause:** on OpenCode V2 the plugin logs through `console.info` /
`console.warn` / `console.error`; the host decides where that output lands,
and log files rotate. The capture location is not part of the plugin's
contract.

**Resolution:** verify collection from the database instead:

```sh
sqlite3 ~/.local/share/opencode-metrics/metrics.db \
  "SELECT COUNT(*) FROM sessions;"
```

To search logs anyway, include the XDG-derived directory:

```sh
grep -r "opencode-metrics" "${XDG_DATA_HOME:-$HOME/.local/share}/opencode/log/"
```

#### Database not created

**Symptom:** `~/.local/share/opencode-metrics/metrics.db` does not exist
after starting OpenCode.

**Causes and fixes:**

- **Plugin not loaded:** See "Plugin not loading" above.
- **Directory permissions:** The plugin creates
  `~/.local/share/opencode-metrics/` with mode `0o755`. Verify the parent
  directory is writable:

  ```sh
  ls -la ~/.local/share/
  ```

- **XDG override:** If `$XDG_DATA_HOME` is set, the database is at
  `$XDG_DATA_HOME/opencode-metrics/metrics.db` instead.

#### Database locked errors

**Symptom:** Log messages containing `SQLITE_BUSY` or
`database is locked`.

**Causes and fixes:**

- **Multiple instances:** This is expected when many OpenCode instances
  write simultaneously. The plugin retries up to 3 times with exponential
  backoff (100ms → 200ms → 400ms). The `busy_timeout` pragma is set to
  5000ms. Occasional messages are harmless — data is retried and written.
- **External lock:** If another process holds a long-running transaction
  on the database (e.g., a backup script or an open sqlite3 shell in
  write mode), it can block the plugin. Close the external connection.
- **Stale WAL file:** In rare cases, a crashed process may leave a stale
  WAL file. See [Recovery procedures](#recovery-procedures).

#### Config validation errors

**Symptom:** Log messages like `Skipping rule 'rule-name': invalid regex`.

**Causes and fixes:**

- **Invalid regex:** Fix the regex pattern in `config.yaml`. Common
  issues include unescaped special characters (`.` should be `\.` for
  literal dots) and missing escape backslashes in YAML (use single quotes
  around patterns to avoid YAML escape interpretation).
- **Missing required fields:** Rules must have `name` (string) and
  `conditions` (array). Missing fields cause the rule to be skipped.
- **Type errors:** Conditions where `field` is not a string, or `values`
  contains non-strings, cause the rule to be skipped.

The plugin never crashes on config errors — it logs a warning and skips
the malformed rule. Remaining valid rules continue to work.

### Diagnostic commands

**Check plugin log output:**

```sh
# OpenCode forwards the plugin's console.* output to its log directory.
grep -r "opencode-metrics" "${XDG_DATA_HOME:-$HOME/.local/share}/opencode/log/"
```

**Run the bundled diagnostic:**

```sh
make check
```

Reports loader layout, registration in `opencode.json`, resolved
`@opencode/plugin` version against the supported range, database health,
session counts, and recent log lines.

**Inspect the database schema:**

```sh
sqlite3 ~/.local/share/opencode-metrics/metrics.db ".schema"
```

**Verify WAL mode is active:**

```sh
sqlite3 ~/.local/share/opencode-metrics/metrics.db "PRAGMA journal_mode;"
```

Expected output: `wal`

**Check schema version:**

```sh
sqlite3 ~/.local/share/opencode-metrics/metrics.db "PRAGMA user_version;"
```

Expected output: `5`

**Run an integrity check:**

```sh
sqlite3 ~/.local/share/opencode-metrics/metrics.db "PRAGMA integrity_check;"
```

Expected output: `ok`

**Check metric definitions are seeded:**

```sh
sqlite3 ~/.local/share/opencode-metrics/metrics.db \
  "SELECT metric_name, unit, aggregation FROM metric_definitions ORDER BY metric_name;"
```

### Recovery procedures

#### Rebuild the database

If the database is corrupted beyond repair:

```sh
# Back up the corrupted database (in case you need forensics).
mv ~/.local/share/opencode-metrics/metrics.db \
   ~/.local/share/opencode-metrics/metrics.db.bak

# Remove WAL and SHM files.
rm -f ~/.local/share/opencode-metrics/metrics.db-wal
rm -f ~/.local/share/opencode-metrics/metrics.db-shm

# Restart OpenCode — the plugin creates a fresh database automatically.
```

Note: Rebuilding the database loses historical data. If you need to
recover data from a corrupted database, try the SQLite `.recover` command
first:

```sh
sqlite3 ~/.local/share/opencode-metrics/metrics.db.bak ".recover" \
  | sqlite3 ~/.local/share/opencode-metrics/metrics-recovered.db
```

#### Reset config to defaults

```sh
# Remove the existing config — the plugin writes a fresh default on
# next startup.
rm ~/.local/share/opencode-metrics/config.yaml

# Restart OpenCode.
```

## Grafana Integration

The metrics database is designed for direct querying by Grafana using
the [frser-sqlite-datasource](https://github.com/fr-ser/grafana-sqlite-datasource)
plugin.

### Schema overview

```
┌──────────────┐     ┌──────────────┐     ┌────────────────────┐
│   projects   │     │   sessions   │     │ metric_definitions │
│──────────────│     │──────────────│     │────────────────────│
│ project_id   │◄────│ project_id   │     │ metric_name        │
│ name         │     │ session_id   │     │ unit               │
│ worktree     │     │ agent        │     │ description        │
│              │     │ model        │     │ aggregation        │
│              │     │ classification│     └────────────────────┘
│              │     │ title        │              │
│              │     │ started_at   │              │
│              │     │ ended_at     │     ┌────────────────┐
│              │     │ metadata     │     │  measurements  │
└──────────────┘     └──────┬───────┘     │────────────────│
                            │             │ session_id     │
                            ├────────────►│ metric_name    │
                            │             │ value          │
                            │             │ recorded_at    │
                            │             └────────────────┘
                            │
                            │             ┌───────────────────┐
                            │             │ session_artifacts  │
                            │             │───────────────────│
                            └────────────►│ session_id        │
                                          │ artifact_type     │
                                          │ reference         │
                                          │ recorded_at       │
                                          └───────────────────┘
```

**Mapping to Grafana panels:**

| Panel Type   | Table             | Key Columns                     |
|--------------|-------------------|---------------------------------|
| Time series  | `measurements`    | `recorded_at` (x), `value` (y)  |
| Stat / Gauge | `measurements`    | `SUM(value)` or `AVG(value)`    |
| Table        | `sessions` + join | Session list with metrics        |
| Pie chart    | `sessions`        | `classification` + `COUNT(*)`   |
| Bar chart    | `sessions`        | `model` or `agent` grouping     |

### Example Grafana queries

All queries use the `recorded_at` or `started_at` column as the time
axis. The frser-sqlite-datasource plugin expects a column named `time`
for time-series panels.

**Daily cost time-series:**

```sql
SELECT date(recorded_at / 1000, 'unixepoch') AS time,
       ROUND(SUM(value), 4) AS cost
FROM measurements
WHERE metric_name = 'cost'
  AND recorded_at >= $__from * 1000000
  AND recorded_at <= $__to * 1000000
GROUP BY time
ORDER BY time;
```

> **Note:** The frser-sqlite-datasource `$__from` and `$__to` macros
> provide epoch *microseconds*. Since `recorded_at` stores
> *milliseconds*, multiply the macro by `1000000 / 1000 = 1000` or
> divide `recorded_at` accordingly. Adjust the comparison based on your
> datasource version — some versions provide milliseconds directly. Test
> with your setup and adjust as needed.

**Cost by project:**

```sql
SELECT p.name AS project,
       ROUND(SUM(m.value), 4) AS total_cost
FROM measurements m
JOIN sessions s ON m.session_id = s.session_id
JOIN projects p ON s.project_id = p.project_id
WHERE m.metric_name = 'cost'
GROUP BY p.name
ORDER BY total_cost DESC;
```

**Cost by classification:**

```sql
SELECT s.classification,
       ROUND(SUM(m.value), 4) AS total_cost,
       COUNT(DISTINCT s.session_id) AS sessions
FROM measurements m
JOIN sessions s ON m.session_id = s.session_id
WHERE m.metric_name = 'cost'
GROUP BY s.classification
ORDER BY total_cost DESC;
```

**Session count by day:**

```sql
SELECT date(started_at / 1000, 'unixepoch') AS time,
       COUNT(*) AS sessions
FROM sessions
GROUP BY time
ORDER BY time;
```

**Average cache hit ratio by day:**

```sql
SELECT date(recorded_at / 1000, 'unixepoch') AS time,
       ROUND(AVG(value) * 100, 1) AS cache_hit_pct
FROM measurements
WHERE metric_name = 'cache_hit_ratio'
GROUP BY time
ORDER BY time;
```

**Top 10 most expensive sessions:**

```sql
SELECT s.title,
       s.classification,
       s.model,
       s.agent,
       ROUND(m.value, 4) AS cost_usd,
       datetime(s.started_at / 1000, 'unixepoch', 'localtime') AS started
FROM sessions s
JOIN measurements m ON s.session_id = m.session_id
WHERE m.metric_name = 'cost'
ORDER BY m.value DESC
LIMIT 10;
```

### Quickstart with ansible-role-ai

The [ansible-role-ai](https://github.com/marcusburghardt/ansible-role-ai) role
deploys an ephemeral Grafana container pre-configured with the
frser-sqlite-datasource plugin and the metrics database. This is the
fastest way to get dashboards running:

```yaml
# In your playbook or host_vars:
ai_opencode_plugins:
  - "@mburghardt/opencode-metrics"

ai_grafana_enabled: true
```

Run the playbook to provision:

- The opencode-metrics plugin in your OpenCode config
- A Grafana container with the SQLite datasource pre-configured
- The metrics database bind-mounted into the container

Refer to the ansible-role-ai documentation for detailed variable
reference and dashboard provisioning.

### Manual Grafana setup

#### 1. Install the SQLite datasource plugin

Install the [frser-sqlite-datasource](https://github.com/fr-ser/grafana-sqlite-datasource)
plugin in your Grafana instance:

```sh
grafana cli plugins install frser-sqlite-datasource
```

Or add it to your Grafana container's `GF_INSTALL_PLUGINS` environment
variable:

```yaml
environment:
  GF_INSTALL_PLUGINS: frser-sqlite-datasource
```

#### 2. Configure the datasource

In Grafana, add a new **SQLite** datasource:

- **Path:** `/path/to/metrics.db`

If Grafana runs in a container, bind-mount the database directory:

```yaml
volumes:
  - ~/.local/share/opencode-metrics:/data/opencode-metrics:ro
```

Then set the datasource path to `/data/opencode-metrics/metrics.db`.

#### 3. WAL mode considerations

The database uses WAL (Write-Ahead Log) mode for concurrent access.
When bind-mounting into a container, you must mount the **entire
directory**, not just the `.db` file, because WAL mode uses companion
files (`metrics.db-wal` and `metrics.db-shm`) that must be in the same
directory as the main database file.

```yaml
# Correct — mount the directory:
volumes:
  - ~/.local/share/opencode-metrics:/data/opencode-metrics:ro

# Incorrect — mounting just the file breaks WAL mode:
# volumes:
#   - ~/.local/share/opencode-metrics/metrics.db:/data/metrics.db:ro
```

The `:ro` (read-only) mount is recommended for Grafana since it only
reads the database. WAL mode supports concurrent readers without
blocking writers.

#### 4. Create panels

Use the [example queries](#example-grafana-queries) above as starting
points for your dashboard panels. The `time` column alias is required
for time-series panels in the frser-sqlite-datasource plugin.

## License

Apache-2.0
