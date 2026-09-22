#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
#
# check.sh — diagnostic checks for the opencode-metrics plugin.
#
# Verifies that the plugin is installed, the database is healthy, and
# sessions are being recorded. Intended for quick troubleshooting when
# the Grafana dashboard shows no data or stale data.
#
# Usage: ./scripts/check.sh
#        make check

set -eu

# ── Colours (disabled when stdout is not a terminal) ─────────────

if [ -t 1 ]; then
	GREEN='\033[0;32m'
	YELLOW='\033[0;33m'
	RED='\033[0;31m'
	CYAN='\033[0;36m'
	DIM='\033[0;90m'
	CLEAR='\033[0m'
else
	GREEN='' YELLOW='' RED='' CYAN='' DIM='' CLEAR=''
fi

# ── Helpers ──────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

FAIL_COUNT=0

pass() { printf "  ${GREEN}PASS${CLEAR}  %s\n" "$*"; }
warn() { printf "  ${YELLOW}WARN${CLEAR}  %s\n" "$*"; }
fail() { printf "  ${RED}FAIL${CLEAR}  %s\n" "$*"; FAIL_COUNT=$((FAIL_COUNT + 1)); }
info() { printf "  ${CYAN}INFO${CLEAR}  %s\n" "$*"; }
dim()  { printf "  ${DIM}%s${CLEAR}\n" "$*"; }

section() {
	printf "\n${CYAN}%s${CLEAR}\n" "$1"
}

# ── Data directory (mirrors src/db.ts getDataDir) ───────────────

if [ -n "${XDG_DATA_HOME:-}" ]; then
	DATA_DIR="${XDG_DATA_HOME}/opencode-metrics"
else
	DATA_DIR="${HOME}/.local/share/opencode-metrics"
fi

DB_PATH="${DATA_DIR}/metrics.db"
LOG_DIR="${HOME}/.local/share/opencode/log"
DIST_PATH="${PROJECT_DIR}/dist/index.js"
GLOBAL_LOADER="${HOME}/.config/opencode/plugins/opencode-metrics.ts"
LOCAL_LOADER="${PROJECT_DIR}/.opencode/plugins/opencode-metrics.ts"

# ── Header ───────────────────────────────────────────────────────

printf "\n${CYAN}opencode-metrics — diagnostic check${CLEAR}\n"
printf "═══════════════════════════════════════════════════════════\n"

# ── 1. Plugin installation ──────────────────────────────────────

section "Plugin"

if [ -f "${DIST_PATH}" ]; then
	SIZE=$(du -h "${DIST_PATH}" | cut -f1)
	pass "dist/index.js exists (${SIZE})"
else
	fail "dist/index.js not found — run 'make build'"
fi

if [ -f "${GLOBAL_LOADER}" ]; then
	if grep -q 'export.*plugin' "${GLOBAL_LOADER}" 2>/dev/null; then
		pass "Global loader: ${GLOBAL_LOADER}"
	else
		fail "Global loader exists but has no named export — plugin will not register"
		dim "Expected: import plugin from \"...\"; export const OpenCodeMetrics = plugin;"
		dim "Run 'make install' or re-run the Ansible playbook with the fixed template."
	fi
else
	dim "Global loader: not found (OK if using npm or project-local loader)"
fi

if [ -f "${LOCAL_LOADER}" ]; then
	if grep -q 'export.*plugin' "${LOCAL_LOADER}" 2>/dev/null; then
		pass "Local loader: ${LOCAL_LOADER}"
	else
		fail "Local loader exists but has no named export — plugin will not register"
	fi
else
	dim "Local loader: not found (OK if using npm or global loader)"
fi

# ── 2. Database health ──────────────────────────────────────────

section "Database"

if ! command -v sqlite3 >/dev/null 2>&1; then
	warn "sqlite3 not installed — skipping database checks"
	warn "Install sqlite3 to enable full diagnostics"
else
	if [ -f "${DB_PATH}" ]; then
		SIZE=$(du -h "${DB_PATH}" | cut -f1)
		pass "${DB_PATH} (${SIZE})"
	else
		fail "Database not found: ${DB_PATH}"
		if [ -n "${XDG_DATA_HOME:-}" ]; then
			dim "XDG_DATA_HOME is set to: ${XDG_DATA_HOME}"
		fi
		dim "Start an OpenCode session with the plugin loaded, or run 'make backfill'."
	fi

	if [ -f "${DB_PATH}" ]; then
		WAL_MODE=$(sqlite3 "${DB_PATH}" "PRAGMA journal_mode;" 2>/dev/null || echo "error")
		if [ "${WAL_MODE}" = "wal" ]; then
			pass "WAL mode: active"
		else
			warn "WAL mode: ${WAL_MODE} (expected: wal)"
		fi

		SCHEMA_VER=$(sqlite3 "${DB_PATH}" "PRAGMA user_version;" 2>/dev/null || echo "error")
		if [ "${SCHEMA_VER}" = "4" ]; then
			pass "Schema version: ${SCHEMA_VER}"
		else
			fail "Schema version: ${SCHEMA_VER} (expected: 4)"
		fi

		INTEGRITY=$(sqlite3 "${DB_PATH}" "PRAGMA integrity_check;" 2>/dev/null || echo "error")
		if [ "${INTEGRITY}" = "ok" ]; then
			pass "Integrity: ok"
		else
			fail "Integrity: ${INTEGRITY}"
		fi

		METRIC_COUNT=$(sqlite3 "${DB_PATH}" \
			"SELECT COUNT(*) FROM metric_definitions;" 2>/dev/null || echo "0")
		if [ "${METRIC_COUNT}" -ge 15 ] 2>/dev/null; then
			pass "Metric definitions: ${METRIC_COUNT} rows"
		else
			warn "Metric definitions: ${METRIC_COUNT} rows (expected: >= 15)"
		fi
	fi
fi

# ── 3. Session recording ────────────────────────────────────────

section "Sessions"

if [ -f "${DB_PATH}" ] && command -v sqlite3 >/dev/null 2>&1; then
	TOTAL=$(sqlite3 "${DB_PATH}" \
		"SELECT COUNT(*) FROM sessions;" 2>/dev/null || echo "0")
	if [ "${TOTAL}" -gt 0 ] 2>/dev/null; then
		pass "Total sessions: ${TOTAL}"
	else
		warn "No sessions recorded yet"
		dim "Complete an OpenCode session (let it go idle) or run 'make backfill'."
	fi

	if [ "${TOTAL}" -gt 0 ] 2>/dev/null; then
		RECENT=$(sqlite3 "${DB_PATH}" "
			SELECT datetime(ended_at/1000, 'unixepoch', 'localtime')
			  || ' (' || session_id || ')'
			FROM sessions ORDER BY ended_at DESC LIMIT 1;
		" 2>/dev/null || echo "unknown")
		pass "Most recent: ${RECENT}"

		RECENT_EPOCH=$(sqlite3 "${DB_PATH}" \
			"SELECT ended_at/1000 FROM sessions ORDER BY ended_at DESC LIMIT 1;" \
			2>/dev/null || echo "0")
		NOW_EPOCH=$(date +%s)
		AGE_DAYS=$(( (NOW_EPOCH - RECENT_EPOCH) / 86400 ))
		if [ "${AGE_DAYS}" -gt 7 ]; then
			warn "Most recent session is ${AGE_DAYS} days old"
		fi

		TODAY_COUNT=$(sqlite3 "${DB_PATH}" "
			SELECT COUNT(*) FROM sessions
			WHERE date(ended_at/1000, 'unixepoch', 'localtime') = date('now', 'localtime');
		" 2>/dev/null || echo "0")
		info "Sessions today: ${TODAY_COUNT}"

		TODAY_COST=$(sqlite3 "${DB_PATH}" "
			SELECT ROUND(COALESCE(SUM(delta), 0), 4)
			FROM measurement_deltas
			WHERE metric_name = 'cost'
			  AND date(recorded_at/1000, 'unixepoch', 'localtime') = date('now', 'localtime');
		" 2>/dev/null || echo "0")
		info "Today's cost: \$${TODAY_COST}"
	fi
else
	if ! command -v sqlite3 >/dev/null 2>&1; then
		dim "Skipped — sqlite3 not available."
	fi
fi

# ── 4. Plugin logs ──────────────────────────────────────────────

section "Plugin logs"

if [ -d "${LOG_DIR}" ]; then
	# Match only the plugin's own log messages (message="[opencode-metrics] ..."),
	# not log lines that incidentally contain the string in bash command output.
	LOG_LINES=$(grep -h 'message="\[opencode-metrics\]' "${LOG_DIR}"/*.log 2>/dev/null \
		| tail -5 || true)
	if [ -n "${LOG_LINES}" ]; then
		echo "${LOG_LINES}" | while IFS= read -r line; do
			dim "${line}"
		done
	else
		warn "No [opencode-metrics] messages found in ${LOG_DIR}/"
		dim "The plugin may not have been loaded, or logs may have rotated."
	fi
else
	warn "OpenCode log directory not found: ${LOG_DIR}"
fi

# ── Summary ─────────────────────────────────────────────────────

printf "\n═══════════════════════════════════════════════════════════\n"
if [ "${FAIL_COUNT}" -gt 0 ]; then
	printf "${RED}%d check(s) failed.${CLEAR} Review the items above.\n\n" "${FAIL_COUNT}"
	exit 1
else
	printf "${GREEN}All checks passed.${CLEAR}\n\n"
	exit 0
fi
