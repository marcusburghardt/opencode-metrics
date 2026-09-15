# Quick Start

Get session metrics and a Grafana dashboard in under 5 minutes.

## Prerequisites

```bash
# OpenCode must be installed and working
opencode --version

# Bun runtime (OpenCode bundles it, but you need it on PATH for CLI commands)
which bun || curl -fsSL https://bun.sh/install | bash

# Podman (for the Grafana dashboard — optional if you only want raw SQL access)
which podman || echo "Install podman: https://podman.io/docs/installation"
```

## Step 1: Install the Plugin

```bash
git clone https://github.com/marcusburghardt/opencode-metrics.git
cd opencode-metrics
bun install
make install
```

That's it. `make install` builds the plugin and installs a global loader
at `~/.config/opencode/plugins/opencode-metrics.ts`. Every OpenCode
session across all projects will now collect metrics automatically.

Restart OpenCode to activate the plugin. You'll see
`[opencode-metrics] initialized` in the logs on startup.

## Step 2: Import Your History

If you've been using OpenCode before installing the plugin, import your
existing session history:

```bash
make backfill
```

This reads OpenCode's internal database (read-only), classifies every
historical session, and writes the metrics into
`~/.local/share/opencode-metrics/metrics.db`. Typical output:

```
Found 905 sessions to process
Imported 30 projects
Processed 905/905 sessions...

--- Summary ---
Sessions:  905
Cost:      $3430.26
Elapsed:   0.9s

Classification distribution:
  multi-agent: 289
  ad-hoc: 252
  exploration: 196
  openspec-workflow: 91
  implementation: 40
  pr-review: 23
  planning: 14
```

Preview first without writing: `bun run scripts/backfill.ts --dry-run`

## Step 3: Launch the Dashboard

```bash
make grafana
```

This downloads the pre-built dashboard from
[ansible-role-ai](https://github.com/marcusburghardt/ansible-role-ai)
and starts a Grafana container with podman.

Open **http://localhost:3033** — no login required.

The dashboard has 28 panels across 8 sections:

| Section | What you'll see |
|---------|----------------|
| **Key Metrics** | Total sessions, total cost, avg cost, cache hit %, output tokens, active projects |
| **Cost Overview** | Daily cost trend, cost by classification/model/project, avg cost per session type |
| **Token Efficiency** | Token usage over time, distribution by type, cache hit ratio trend |
| **Session Analytics** | Sessions by day, by classification, duration distribution, by agent, messages per type |
| **Efficiency** | Cost per 1K output tokens, cache hit by classification, cost per file changed |
| **Code Impact** | Lines changed over time, files changed by project |
| **Top Sessions** | Most expensive sessions with title, classification, model, project, cost |
| **Trends** | Weekly cost trend, 7-day rolling average |

To stop Grafana: `make grafana-stop` (data volume is preserved for
next start).

For managed deployment across multiple machines, see
[ansible-role-ai](https://github.com/marcusburghardt/ansible-role-ai)
which automates the full OpenCode + Grafana stack.

## Step 4: Customize Classifications (Optional)

The plugin classifies every session using ordered rules in a YAML config
file. The first matching rule wins.

### Config file location

```
~/.local/share/opencode-metrics/config.yaml
```

This file is auto-created on first plugin run with 8 default rules.
Edit it anytime — changes take effect on the next session idle event
(no restart needed).

### How rules work

Each rule has:

| Field | Purpose |
|-------|---------|
| `name` | Classification label (appears in dashboards) |
| `description` | Human-readable description |
| `conditions` | List of conditions — ALL must match (AND logic) |
| `exclude` | Optional — if ANY matches, the rule is skipped |

Each condition matches against a session field:

| Field | What it contains |
|-------|-----------------|
| `agent` | OpenCode agent name: `build`, `plan`, `explore`, `general`, or custom agents |
| `model` | Model ID: `claude-opus-4-6@default`, `ollama/qwen3:8b`, etc. |
| `first_user_message` | The text of the first user prompt in the session |
| `part_content` | Concatenated text content from all message parts |
| `bash_commands` | Bash/shell commands executed via tool calls |

Matching modes:

- `pattern: 'regex'` — regex match against the field value
- `values: ["exact1", "exact2"]` — exact match against a list

### Example 1: Track debugging sessions

Add this rule **before** `multi-agent` in the config to catch sessions
that use debugging tools:

```yaml
  - name: debugging
    description: Debugging and troubleshooting sessions
    conditions:
      - field: bash_commands
        pattern: 'gdb|strace|valgrind|perf|ltrace'
```

### Example 2: Track documentation sessions

Catch sessions that create or edit documentation, but only when using
the `build` agent (to distinguish from exploration):

```yaml
  - name: documentation
    description: Documentation and writing sessions
    conditions:
      - field: part_content
        pattern: 'README|CHANGELOG|docs/|\.md'
      - field: agent
        values: ["build"]
```

### Example 3: Track refactoring sessions

Match sessions where the user explicitly asks for refactoring work:

```yaml
  - name: refactoring
    description: Code refactoring sessions
    conditions:
      - field: first_user_message
        pattern: '(?i)refactor|rename|move|extract|reorganize'
```

### Applying custom rules

1. Edit `~/.local/share/opencode-metrics/config.yaml`
2. Place custom rules **before** `ad-hoc` (the fallback) and in the
   priority order you want (first match wins)
3. New sessions will use the updated rules immediately
4. To reclassify historical sessions with your new rules, re-run:
   ```bash
   make backfill
   ```

### Full default config reference

The default config with all 8 built-in rules is documented in
[README.md](README.md#configuration).

## What's Next

- **Full reference**: all configuration options, 27 SQL query examples,
  troubleshooting — see [README.md](README.md)
- **Managed deployment**: automate OpenCode + plugin + Grafana across
  machines with [ansible-role-ai](https://github.com/marcusburghardt/ansible-role-ai)
- **Raw SQL access**: query metrics directly with sqlite3:
  ```bash
  sqlite3 ~/.local/share/opencode-metrics/metrics.db \
    "SELECT classification, COUNT(*), ROUND(SUM(m.value),2) as cost
     FROM v_sessions s
     JOIN v_measurements m ON s.session_id = m.session_id
     WHERE m.metric_name = 'cost'
     GROUP BY classification
     ORDER BY cost DESC;"
  ```
