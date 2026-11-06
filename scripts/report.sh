#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
#
# report.sh — human-readable sub-agent performance and workflow cost report.
#
# Usage: ./scripts/report.sh [path/to/metrics.db]
#        make report

set -eu

if [ -n "${XDG_DATA_HOME:-}" ]; then
	DEFAULT_DB="${XDG_DATA_HOME}/opencode-metrics/metrics.db"
else
	DEFAULT_DB="${HOME}/.local/share/opencode-metrics/metrics.db"
fi

DB_PATH="${1:-${DEFAULT_DB}}"

if [ ! -f "${DB_PATH}" ]; then
	echo "Metrics database not found: ${DB_PATH}" >&2
	echo "Run 'make backfill' or start an OpenCode session first." >&2
	exit 1
fi

if ! command -v sqlite3 >/dev/null 2>&1; then
	echo "sqlite3 is required but was not found on PATH." >&2
	exit 1
fi

printf '\nAgent performance (cost, model time, wall time)\n'
printf '%s\n' '--------------------------------------------------------------'
sqlite3 -header -column "${DB_PATH}" "
	SELECT
		agent,
		model,
		session_role,
		runs,
		runs_with_generation_time AS timed_runs,
		total_cost_usd,
		avg_wall_seconds,
		avg_generation_seconds,
		output_tokens_per_generation_second AS gen_tok_s,
		output_tokens_per_wall_second AS wall_tok_s,
		usd_per_1k_output_tokens AS usd_per_1k_out
	FROM v_agent_performance
	ORDER BY total_cost_usd DESC
	LIMIT 25;
"

printf '\nModel speed (fully timed sessions only; blank = no coverage)\n'
printf '%s\n' '--------------------------------------------------------------'
sqlite3 -header -column "${DB_PATH}" "
	SELECT
		agent,
		model,
		session_role,
		runs_with_generation_time AS timed_runs,
		RANK() OVER (
			PARTITION BY session_role
			ORDER BY output_tokens_per_generation_second DESC
		) AS speed_rank,
		total_generation_seconds,
		total_generation_output_tokens,
		output_tokens_per_generation_second AS gen_tok_s
	FROM v_agent_performance
	WHERE runs_with_generation_time > 0
	ORDER BY session_role, output_tokens_per_generation_second DESC
	LIMIT 20;
"

printf '\nTop workflows (root + sub-agents)\n'
printf '%s\n' '--------------------------------------------------------------'
sqlite3 -header -column "${DB_PATH}" "
	SELECT
		substr(root_title, 1, 40) AS root_title,
		root_agent,
		subagent_sessions,
		root_cost_usd,
		subagent_cost_usd,
		total_cost_usd,
		subagent_cost_share
	FROM v_workflow_cost
	ORDER BY total_cost_usd DESC
	LIMIT 15;
"

printf '\n'
