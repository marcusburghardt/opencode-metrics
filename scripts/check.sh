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
if [ -n "${XDG_DATA_HOME:-}" ]; then
	LOG_DIR="${XDG_DATA_HOME}/opencode/log"
else
	LOG_DIR="${HOME}/.local/share/opencode/log"
fi
DIST_PATH="${PROJECT_DIR}/dist/index.js"
GLOBAL_LOADER="${HOME}/.config/opencode/plugins/opencode-metrics.ts"
GLOBAL_LOADER_DIR="${HOME}/.config/opencode/plugins/opencode-metrics"
LOCAL_LOADER="${PROJECT_DIR}/.opencode/plugins/opencode-metrics.ts"
LOCAL_LOADER_DIR="${PROJECT_DIR}/.opencode/plugins/opencode-metrics"

# Accept a default-export loader file first (the proven form), then a
# directory containing index.ts. OpenCode V2 requires a default export; V1
# used a named export, so a named-export file is reported as a migration
# warning rather than a failure.
check_loader() {
	label="$1"
	file="$2"
	dir="$3"

	if [ -f "${file}" ]; then
		if grep -qE '^[[:space:]]*export default' "${file}" 2>/dev/null; then
			pass "${label}: ${file} (file, default export)"
			return
		fi
		if grep -q 'export.*plugin' "${file}" 2>/dev/null; then
			warn "${label}: legacy named-export loader at ${file}"
			dim "V1 layout detected. Re-run 'make install' to write a V2 default-export loader."
			return
		fi
		fail "${label} exists but exports nothing usable — plugin will not register"
		return
	fi

	if [ -f "${dir}/index.ts" ]; then
		if grep -qE '^[[:space:]]*export default' "${dir}/index.ts" 2>/dev/null; then
			pass "${label}: ${dir}/index.ts (directory, default export)"
			return
		fi
		warn "${label} directory exists but index.ts has no default export"
		dim "OpenCode V2 expects: export default plugin;"
		return
	fi

	dim "${label}: not found (OK if using npm)"
}

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

check_loader "Global loader" "${GLOBAL_LOADER}" "${GLOBAL_LOADER_DIR}"
check_loader "Local loader" "${LOCAL_LOADER}" "${LOCAL_LOADER_DIR}"

# Registration: the loader only loads if its directory/package is listed in an
# opencode.json "plugins" array.
REGISTERED=""
for cfg in "${PROJECT_DIR}/opencode.json" "${HOME}/.config/opencode/opencode.json"; do
	if [ -f "${cfg}" ] && grep -q 'opencode-metrics' "${cfg}" 2>/dev/null; then
		REGISTERED="${cfg}"
		break
	fi
done
if [ -n "${REGISTERED}" ]; then
	pass "Registered in ${REGISTERED}"
else
	dim "Not found in an opencode.json \"plugins\" array (OK if resolved from npm)"
fi

# Runtime plugin-API version guard (same resolver the plugin uses).
if command -v bun >/dev/null 2>&1 && [ -f "${PROJECT_DIR}/src/version.ts" ]; then
	PLUGIN_VER=$(cd "${PROJECT_DIR}" && bun src/version.ts --root "${PROJECT_DIR}" 2>/dev/null || true)
	if [ -n "${PLUGIN_VER}" ] && [ "${PLUGIN_VER}" != "unknown" ]; then
		if (cd "${PROJECT_DIR}" && bun src/version.ts --root "${PROJECT_DIR}" >/dev/null 2>&1); then
			pass "Plugin API version: ${PLUGIN_VER}"
		else
			fail "Plugin API version: ${PLUGIN_VER} (supported: >=2.2.5 <3.0.0)"
			dim "Upgrade opencode-metrics, or run 'bun install' to restore the pinned version."
		fi
	else
		warn "Plugin API version: unresolved"
		dim "Run 'bun install' so @opencode/plugin is present."
	fi
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
		# Read the expected version from the code so this check cannot drift.
		EXPECTED_SCHEMA=$(grep -oE '^const SCHEMA_VERSION = [0-9]+' "${PROJECT_DIR}/src/db.ts" 2>/dev/null \
			| grep -oE '[0-9]+$' || echo "4")
		if [ "${SCHEMA_VER}" = "${EXPECTED_SCHEMA}" ]; then
			pass "Schema version: ${SCHEMA_VER}"
		else
			fail "Schema version: ${SCHEMA_VER} (expected: ${EXPECTED_SCHEMA})"
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
		AGE_DAYS=$(( (NOW_EPOCH - ${RECENT_EPOCH:-0}) / 86400 ))
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
	# Fatal startup conditions are failures, not just informational lines.
	PLUGIN_FAILURES=$(grep -hE '(message|msg)="\[opencode-metrics\]' "${LOG_DIR}"/*.log 2>/dev/null \
		| grep -E 'initialization failed|unsupported @opencode/plugin' | tail -5 || true)
	if [ -n "${PLUGIN_FAILURES}" ]; then
		fail "Plugin reported a fatal startup condition (metrics collection disabled):"
		echo "${PLUGIN_FAILURES}" | while IFS= read -r line; do
			dim "${line}"
		done
	fi

	LOG_LINES=$(grep -hE '(message|msg)="\[opencode-metrics\]' "${LOG_DIR}"/*.log 2>/dev/null \
		| tail -5 || true)
	if [ -n "${LOG_LINES}" ]; then
		echo "${LOG_LINES}" | while IFS= read -r line; do
			dim "${line}"
		done

		# OpenCode 2.x does not route plugin console.* output into this log
		# directory, so stale V1 lines can look healthy. Compare the newest
		# matching line with the newest recorded session and say so.
		if [ -f "${DB_PATH}" ] && command -v sqlite3 >/dev/null 2>&1; then
			NEWEST_SESSION=$(sqlite3 "${DB_PATH}" \
				"SELECT date(MAX(ended_at)/1000,'unixepoch','localtime') FROM sessions;" \
				2>/dev/null || echo "")
			NEWEST_LOG=$(grep -hE '(message|msg)="\[opencode-metrics\]' "${LOG_DIR}"/*.log 2>/dev/null \
				| tail -1 | grep -oE '[0-9]{4}-[0-9]{2}-[0-9]{2}' | head -1 || echo "")
			if [ -n "${NEWEST_SESSION}" ] && [ -n "${NEWEST_LOG}" ] \
				&& [ "${NEWEST_LOG}" \< "${NEWEST_SESSION}" ]; then
				warn "Newest plugin log line is ${NEWEST_LOG}; newest session is ${NEWEST_SESSION}"
				dim "OpenCode 2.x sends plugin console output to the process stdout/TUI, not to ${LOG_DIR}/."
				dim "The database checks above are authoritative; treat this section as V1-only history."
			fi
		fi
	else
		warn "No [opencode-metrics] messages found in ${LOG_DIR}/"
		dim "On OpenCode 2.x this is expected: plugin console output goes to stdout/TUI."
		dim "Use the database checks above to confirm collection."
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
