# opencode-metrics

Automatic session metrics collection for [OpenCode](https://opencode.ai).
Captures cost, token usage, session duration, diff stats, and classification
data into a local SQLite database — queryable with standard SQL tools or
Grafana dashboards.

## Table of Contents

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
  - [Running the test suite](#running-the-test-suite)
- [Metric Reference](#metric-reference)
- [Insights](#insights)
- [Upgrade and Uninstall](#upgrade-and-uninstall)
  - [Upgrading](#upgrading)
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

- **OpenCode** with plugin support (v1.18+)
- **Bun** runtime — handled automatically by OpenCode (plugins run inside
  OpenCode's Bun process)

### From npm

Add `opencode-metrics` to the `plugins` array in your OpenCode configuration
file (`~/.config/opencode/config.json` or `opencode.json` in your project):

```jsonc
{
  "plugins": ["opencode-metrics"]
}
```

OpenCode resolves the plugin from npm on startup. No separate `npm install`
step is required.

### From local checkout

Clone the repository and build:

```sh
git clone https://github.com/your-org/opencode-metrics.git
cd opencode-metrics
make build
```

Then reference the local path in your OpenCode config:

```jsonc
{
  "plugins": ["./path/to/opencode-metrics"]
}
```

OpenCode resolves local paths relative to the config file location. The
`dist/index.js` entry point is used automatically (configured via
`"main"` in `package.json`).

### Ansible integration

If you manage OpenCode installations with
[ansible-role-ai](https://github.com/your-org/ansible-role-ai), add the
plugin to the `ai_opencode_plugins` variable:

```yaml
ai_opencode_plugins:
  - opencode-metrics
```

The role merges this into the generated OpenCode configuration during
provisioning.

### Verifying the installation

1. **Check logs** — Start an OpenCode session and look for the
   initialization message:

   ```
   [opencode-metrics] initialized
   ```

   OpenCode logs appear in the bottom status bar or in
   `~/.local/share/opencode/log/`.

2. **Verify the database** — After completing at least one prompt/response
   cycle, the database file should exist:

   ```sh
   ls -la ~/.local/share/opencode-metrics/metrics.db
   ```

3. **Verify tables** — Open the database and confirm the schema:

   ```sh
   sqlite3 ~/.local/share/opencode-metrics/metrics.db ".tables"
   ```

   Expected output:

   ```
    measurements        metric_definitions  projects
    session_artifacts   sessions
   ```

## Historical Data Backfill

The backfill script performs a one-time import of historical session data
from OpenCode's internal database into the opencode-metrics database. This
gives you full visibility into past sessions without waiting for new data
to accumulate through the live plugin.

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
semantics — the latest cumulative value is stored).

| Metric Name        | Unit    | Description                                    | Aggregation |
|--------------------|---------|------------------------------------------------|-------------|
| `cost`             | usd     | Total session cost in USD                      | sum         |
| `tokens_input`     | tokens  | Non-cached input tokens sent to the model      | sum         |
| `tokens_output`    | tokens  | Output tokens generated by the model           | sum         |
| `tokens_reasoning` | tokens  | Reasoning tokens consumed by the model         | sum         |
| `tokens_cache_read`| tokens  | Input tokens served from prompt cache          | sum         |
| `tokens_cache_write`| tokens | Input tokens written to prompt cache           | sum         |
| `cache_hit_ratio`  | ratio   | Fraction of input tokens served from cache     | avg         |
| `duration_seconds` | seconds | Wall-clock session duration in seconds         | sum         |
| `files_changed`    | count   | Number of files changed in the session         | sum         |
| `lines_added`      | count   | Lines added across all file changes            | sum         |
| `lines_deleted`    | count   | Lines deleted across all file changes          | sum         |
| `messages_total`   | count   | Total messages exchanged in the session        | sum         |
| `prs_created`      | count   | PRs created in the session                     | sum         |
| `prs_reviewed`     | count   | PRs reviewed in the session                    | sum         |
| `issues_referenced`| count   | Issues referenced in the session               | sum         |

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

## Upgrade and Uninstall

### Upgrading

Update the plugin to the latest version:

```sh
npm update opencode-metrics
```

Or, if installed from a local checkout:

```sh
cd opencode-metrics
git pull
make build
```

**Data preservation:** Your existing `metrics.db` database and
`config.yaml` are preserved across upgrades. The schema uses `CREATE
TABLE IF NOT EXISTS` and `INSERT OR IGNORE` for metric definitions, so
the database is never destructively modified. Schema versioning
(`PRAGMA user_version`) ensures future migrations are applied
automatically on startup.

> **Note:** Existing users should re-run `make backfill` after upgrading
> to populate artifact data for historical sessions. The backfill is
> idempotent and safe to re-run.

### Uninstalling

1. Remove the plugin from your OpenCode configuration:

   ```jsonc
   {
     "plugins": [
       // Remove "opencode-metrics" from this array
     ]
   }
   ```

2. (Optional) Delete the data directory:

   ```sh
   rm -rf ~/.local/share/opencode-metrics
   ```

   This removes `metrics.db`, `config.yaml`, and any WAL/SHM files. If
   you used a custom `data_dir`, also delete that directory.

## Troubleshooting

### Common issues

#### Plugin not loading

**Symptom:** No `[opencode-metrics] initialized` message in logs.

**Causes and fixes:**

- **Plugin not in config:** Verify `opencode-metrics` appears in the
  `plugins` array of your OpenCode config file.
- **Wrong config file:** OpenCode reads `~/.config/opencode/config.json`
  (global) or `opencode.json` (project-local). Ensure you edited the
  correct one.
- **npm resolution failure:** If using the npm name, ensure network
  connectivity on first run. OpenCode needs to download the plugin.
- **Local path incorrect:** If using a local path, ensure the path
  resolves to a directory containing `package.json` with a valid `main`
  entry.

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
# Tail OpenCode logs for metrics-related messages
grep -r "opencode-metrics" ~/.local/share/opencode/log/
```

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

Expected output: `2`

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

The [ansible-role-ai](https://github.com/your-org/ansible-role-ai) role
deploys an ephemeral Grafana container pre-configured with the
frser-sqlite-datasource plugin and the metrics database. This is the
fastest way to get dashboards running:

```yaml
# In your playbook or host_vars:
ai_opencode_plugins:
  - opencode-metrics

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
