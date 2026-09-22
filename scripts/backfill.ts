#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0

/**
 * Backfill script — imports historical session data from OpenCode's
 * internal database into the opencode-metrics database.
 *
 * Usage:
 *   bun run scripts/backfill.ts [options]
 *   make backfill
 *
 * Options:
 *   --source <path>  Source database (default: ~/.local/share/opencode/opencode.db)
 *   --dest <path>    Destination directory (default: auto-detect via XDG)
 *   --dry-run        Print statistics without writing
 *   --help           Show usage
 */

import { Database } from "bun:sqlite";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import {
	type BashToolCall,
	extractIssuesReferenced,
	extractPRsCreated,
	extractPRsReviewed,
	resolveRepoContext,
} from "../src/artifacts";
import { classify, classifyBudget } from "../src/classifier";
import { loadConfig } from "../src/config";
import { getDataDir, initDatabase } from "../src/db";
import {
	computeCacheHitRatio,
	computeDurationSeconds,
} from "../src/extractor";
import { upsertArtifacts, upsertProject, upsertSession, writeMetrics } from "../src/writer";

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

interface CliArgs {
	source: string;
	dest: string;
	dryRun: boolean;
	withDeltas: boolean;
	since: number | null; // epoch-ms threshold, null = no filter
	help: boolean;
}

/**
 * Parse a date string into epoch milliseconds.
 * Accepts YYYY-MM-DD (interpreted as local midnight) or ISO-8601.
 * Returns null if the string is not a valid date.
 */
export function parseDateToEpochMs(value: string): number | null {
	// YYYY-MM-DD → local midnight
	if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
		const ms = new Date(`${value}T00:00:00`).getTime();
		return Number.isNaN(ms) ? null : ms;
	}
	const ms = new Date(value).getTime();
	return Number.isNaN(ms) ? null : ms;
}

function parseArgs(argv: string[]): CliArgs {
	const args = argv.slice(2); // skip bun and script path
	let source = "";
	let dest = "";
	let dryRun = false;
	let withDeltas = false;
	let since: number | null = null;
	let help = false;

	for (let i = 0; i < args.length; i++) {
		switch (args[i]) {
			case "--source":
				if (i + 1 >= args.length) {
					console.error("Error: --source requires a path argument");
					process.exit(1);
				}
				source = args[++i];
				break;
			case "--dest":
				if (i + 1 >= args.length) {
					console.error("Error: --dest requires a path argument");
					process.exit(1);
				}
				dest = args[++i];
				break;
			case "--dry-run":
				dryRun = true;
				break;
			case "--with-deltas":
				withDeltas = true;
				break;
			case "--since": {
				if (i + 1 >= args.length) {
					console.error("Error: --since requires a date argument (YYYY-MM-DD or ISO-8601)");
					process.exit(1);
				}
				const parsed = parseDateToEpochMs(args[++i]);
				if (parsed === null) {
					console.error(`Error: invalid date '${args[i]}' — use YYYY-MM-DD or ISO-8601`);
					process.exit(1);
				}
				since = parsed;
				break;
			}
			case "--help":
				help = true;
				break;
			default:
				console.error(`Error: unknown argument '${args[i]}'`);
				console.error("Run with --help for usage");
				process.exit(1);
		}
	}

	// Resolve defaults
	if (!source) {
		const xdgData = process.env.XDG_DATA_HOME || path.join(homedir(), ".local", "share");
		source = path.join(xdgData, "opencode", "opencode.db");
	}
	if (!dest) {
		dest = getDataDir();
	}

	return { source, dest, dryRun, withDeltas, since, help };
}

function printUsage(): void {
	console.log(`
opencode-metrics backfill — import historical sessions from OpenCode

Usage:
  bun run scripts/backfill.ts [options]
  make backfill

Options:
  --source <path>  Path to OpenCode's database
                   (default: ~/.local/share/opencode/opencode.db)
  --dest <path>    Path to metrics data directory
                   (default: ~/.local/share/opencode-metrics/)
  --since <date>   Only backfill sessions created on or after this date
                   (YYYY-MM-DD or ISO-8601, e.g. 2026-09-22)
  --with-deltas    Write measurement deltas (time-series data) alongside
                   cumulative values. Use with --since for recent sessions
                   so Grafana daily/weekly panels show correct totals.
                   Without this flag, only cumulative values are written
                   and time-sliced panels will not reflect backfilled data.
  --dry-run        Analyze source database without writing
  --help           Show this help message

The script reads OpenCode's internal database (read-only) and writes
session metrics into the opencode-metrics database using the same
schema and classification logic as the live plugin.

Safe to run multiple times — uses INSERT ON CONFLICT DO UPDATE.

Examples:
  make backfill                                   # full historical import
  make backfill ARGS="--since 2026-09-22 --with-deltas"  # today's missed sessions
  make backfill ARGS="--dry-run"                  # preview without writing
`);
}

// ---------------------------------------------------------------------------
// Source database queries
// ---------------------------------------------------------------------------

const REQUIRED_TABLES = ["session", "message", "part", "project"];

export function validateSourceSchema(db: Database): void {
	const rows = db.prepare(
		"SELECT name FROM sqlite_master WHERE type='table'",
	).all() as Array<{ name: string }>;
	const tableNames = new Set(rows.map((r) => r.name));

	const missing = REQUIRED_TABLES.filter((t) => !tableNames.has(t));
	if (missing.length > 0) {
		throw new Error(
			`Source database is missing required tables: ${missing.join(", ")}. ` +
			"This does not appear to be an OpenCode database.",
		);
	}
}

interface SourceProject {
	id: string;
	name: string | null;
	worktree: string | null;
}

interface SourceSession {
	id: string;
	project_id: string;
	cost: number;
	tokens_input: number;
	tokens_output: number;
	tokens_reasoning: number;
	tokens_cache_read: number;
	tokens_cache_write: number;
	agent: string | null;
	model: string | null;
	title: string | null;
	time_created: number;
	time_updated: number;
	summary_files: number | null;
	summary_additions: number | null;
	summary_deletions: number | null;
}

export function extractModelId(modelJson: string | null): string {
	if (!modelJson) return "unknown";
	try {
		const parsed = JSON.parse(modelJson);
		if (typeof parsed === "string") return parsed;
		if (typeof parsed === "object" && parsed !== null) {
			// Guard against non-string values (e.g. {"id":123}) to
			// satisfy the string return type contract.
			if (typeof parsed.id === "string") return parsed.id;
			if (typeof parsed.modelID === "string") return parsed.modelID;
		}
	} catch {
		// malformed JSON
	}
	return "unknown";
}

function getMessageCount(sourceDb: Database, sessionId: string): number {
	const row = sourceDb.prepare(
		"SELECT COUNT(*) as cnt FROM message WHERE session_id = ?",
	).get(sessionId) as { cnt: number } | null;
	return row?.cnt ?? 0;
}

function getFirstUserMessage(sourceDb: Database, sessionId: string): string {
	// Get the first user message's ID, then get its text parts
	const msgRow = sourceDb.prepare(`
		SELECT id FROM message
		WHERE session_id = ? AND json_extract(data, '$.role') = 'user'
		ORDER BY time_created ASC LIMIT 1
	`).get(sessionId) as { id: string } | null;

	if (!msgRow) return "";

	const parts = sourceDb.prepare(`
		SELECT json_extract(data, '$.text') as text
		FROM part
		WHERE message_id = ? AND json_extract(data, '$.type') = 'text'
		ORDER BY time_created ASC
	`).all(msgRow.id) as Array<{ text: string | null }>;

	return parts.map((p) => p.text ?? "").join("\n");
}

function getBashCommands(sourceDb: Database, sessionId: string): string[] {
	const rows = sourceDb.prepare(`
		SELECT json_extract(data, '$.state.input.command') as command
		FROM part
		WHERE session_id = ?
		  AND json_extract(data, '$.type') = 'tool'
		  AND (
			json_extract(data, '$.tool') LIKE '%bash%'
			OR json_extract(data, '$.tool') LIKE '%shell%'
		  )
		  AND json_extract(data, '$.state.input.command') IS NOT NULL
	`).all(sessionId) as Array<{ command: string }>;

	return rows.map((r) => r.command);
}

/**
 * Extract bash tool calls with output from the source database.
 * Returns BashToolCall objects for artifact extraction, including the
 * tool output field needed to parse PR URLs from `gh pr create` output.
 */
function getBashToolCalls(sourceDb: Database, sessionId: string): BashToolCall[] {
	const rows = sourceDb.prepare(`
		SELECT
			json_extract(data, '$.state.input.command') as command,
			json_extract(data, '$.state.output') as output
		FROM part
		WHERE session_id = ?
		  AND json_extract(data, '$.type') = 'tool'
		  AND (
			json_extract(data, '$.tool') LIKE '%bash%'
			OR json_extract(data, '$.tool') LIKE '%shell%'
		  )
		  AND json_extract(data, '$.state.input.command') IS NOT NULL
	`).all(sessionId) as Array<{ command: string; output: string | null }>;

	return rows.map((r) => ({
		command: r.command,
		output: r.output ?? undefined,
	}));
}

function getPartContent(sourceDb: Database, sessionId: string): string {
	const rows = sourceDb.prepare(`
		SELECT json_extract(data, '$.text') as text
		FROM part
		WHERE session_id = ?
		  AND json_extract(data, '$.type') = 'text'
		LIMIT 50
	`).all(sessionId) as Array<{ text: string | null }>;

	return rows.map((r) => r.text ?? "").join("\n");
}

/**
 * Fallback: extract agent from the first user message when session.agent is NULL.
 * Older OpenCode versions (before ~May 2026) did not populate session-level agent.
 */
function getAgentFromMessages(sourceDb: Database, sessionId: string): string | null {
	const row = sourceDb.prepare(`
		SELECT json_extract(data, '$.agent') as agent
		FROM message
		WHERE session_id = ? AND json_extract(data, '$.role') = 'user'
		ORDER BY time_created ASC LIMIT 1
	`).get(sessionId) as { agent: string | null } | null;
	return row?.agent ?? null;
}

/**
 * Fallback: extract model from the first assistant message when session.model is NULL.
 * Older OpenCode versions (before ~May 2026) did not populate session-level model.
 */
function getModelFromMessages(sourceDb: Database, sessionId: string): string | null {
	const row = sourceDb.prepare(`
		SELECT json_extract(data, '$.modelID') as modelID
		FROM message
		WHERE session_id = ? AND json_extract(data, '$.role') = 'assistant'
		ORDER BY time_created ASC LIMIT 1
	`).get(sessionId) as { modelID: string | null } | null;
	return row?.modelID ?? null;
}

export function deriveProjectName(name: string | null, worktree: string | null): string {
	if (name) return name;
	if (worktree) return path.basename(worktree);
	return "unknown";
}

// ---------------------------------------------------------------------------
// Delta catch-up
// ---------------------------------------------------------------------------

/**
 * Insert catch-up deltas for metrics where the sum of existing deltas
 * is less than the cumulative value. This handles two cases:
 *
 * 1. No deltas exist at all (previous backfill wrote cumulative only).
 * 2. Partial deltas exist (live plugin captured some idle events, but
 *    they don't cover the full cumulative value).
 *
 * In both cases, inserts a top-up delta for the difference. Uses INSERT
 * OR IGNORE for idempotency (the PK constraint on session_id +
 * metric_name + recorded_at prevents duplicates on repeated runs).
 */
export function backfillMissingDeltas(
	db: Database,
	sessionId: string,
	metrics: ReadonlyArray<{ metric_name: string; value: number; recorded_at: number }>,
): void {
	const sumStmt = db.prepare(
		"SELECT COALESCE(SUM(delta), 0) AS total FROM measurement_deltas WHERE session_id = ? AND metric_name = ?",
	);
	const insertStmt = db.prepare(
		`INSERT OR IGNORE INTO measurement_deltas (session_id, metric_name, delta, recorded_at)
		 VALUES (?, ?, ?, ?)`,
	);

	// Find the latest existing delta timestamp so the top-up delta
	// gets a distinct recorded_at (avoids PK collision with INSERT OR IGNORE).
	const maxTsStmt = db.prepare(
		"SELECT MAX(recorded_at) AS max_ts FROM measurement_deltas WHERE session_id = ? AND metric_name = ?",
	);

	for (const metric of metrics) {
		if (metric.value === 0) continue;
		const row = sumStmt.get(sessionId, metric.metric_name) as { total: number };
		const gap = metric.value - row.total;
		if (gap > 0.0001) {
			// Use a timestamp 1ms after the latest existing delta (or the
			// metric's own recorded_at if no deltas exist) to avoid PK
			// collisions while keeping the top-up near the right time.
			const maxRow = maxTsStmt.get(sessionId, metric.metric_name) as { max_ts: number | null };
			const topUpTs = maxRow.max_ts !== null
				? Math.max(maxRow.max_ts + 1, metric.recorded_at)
				: metric.recorded_at;
			insertStmt.run(sessionId, metric.metric_name, gap, topUpTs);
		}
	}
}

// ---------------------------------------------------------------------------
// Main backfill logic
// ---------------------------------------------------------------------------

interface BackfillStats {
	totalSessions: number;
	totalCost: number;
	classifications: Record<string, number>;
	skipped: number;
	elapsed: number;
}

async function runBackfill(args: CliArgs): Promise<BackfillStats> {
	const startTime = Date.now();
	const stats: BackfillStats = {
		totalSessions: 0,
		totalCost: 0,
		classifications: {},
		skipped: 0,
		elapsed: 0,
	};

	// --- Validate source ---
	if (!existsSync(args.source)) {
		console.error(`Error: Source database not found at: ${args.source}`);
		console.error("Use --source <path> to specify an alternative location.");
		process.exit(1);
	}

	// --- Same-file protection ---
	const destDbPath = path.join(args.dest, "metrics.db");
	if (existsSync(destDbPath)) {
		try {
			const canonicalSource = realpathSync(args.source);
			const canonicalDest = realpathSync(destDbPath);
			if (canonicalSource === canonicalDest) {
				console.error("Error: Source and destination resolve to the same file.");
				console.error(`  Source: ${canonicalSource}`);
				console.error(`  Dest:   ${canonicalDest}`);
				process.exit(1);
			}
		} catch {
			// realpathSync may fail if dest doesn't exist yet — OK
		}
	}

	// --- Open source (read-only) ---
	const sourceDb = new Database(args.source, { readonly: true });
	console.log(`Source: ${args.source}`);

	try {
		validateSourceSchema(sourceDb);
	} catch (err) {
		console.error((err as Error).message);
		process.exit(1);
	}

	// --- Count sessions ---
	const sinceClause = args.since !== null ? " WHERE time_created >= ?" : "";
	const sinceParams: number[] = args.since !== null ? [args.since] : [];

	const countRow = sourceDb
		.prepare(`SELECT COUNT(*) as cnt FROM session${sinceClause}`)
		.get(...sinceParams) as { cnt: number };
	const totalCount = countRow.cnt;

	if (args.since !== null) {
		const d = new Date(args.since);
		const sinceDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
		console.log(`Filter: sessions created on or after ${sinceDate}`);
	}
	console.log(`Found ${totalCount} sessions to process`);
	if (args.withDeltas) {
		console.log("Deltas: enabled — time-series data will be written");
	}

	if (totalCount === 0) {
		console.log("No sessions to backfill.");
		stats.elapsed = (Date.now() - startTime) / 1000;
		return stats;
	}

	// --- Load classification config ---
	const config = loadConfig(args.dest);

	// --- Open/init destination (skip in dry-run) ---
	let destDb: Database | null = null;
	if (!args.dryRun) {
		const { db } = initDatabase(args.dest);
		destDb = db;
		console.log(`Destination: ${path.join(args.dest, "metrics.db")}`);
	} else {
		console.log("Dry-run mode — no writes will be performed");
	}

	// --- Backfill projects ---
	const projects = sourceDb.prepare("SELECT id, name, worktree FROM project").all() as SourceProject[];
	if (destDb) {
		for (const proj of projects) {
			upsertProject(destDb, {
				project_id: proj.id,
				name: deriveProjectName(proj.name, proj.worktree),
				worktree: proj.worktree ?? "",
			});
		}
		console.log(`Imported ${projects.length} projects`);
	}

	// Build worktree map for repo context resolution. Cache resolved
	// repo contexts per project to avoid redundant git remote lookups.
	const worktreeMap = new Map<string, string>();
	for (const proj of projects) {
		if (proj.worktree) worktreeMap.set(proj.id, proj.worktree);
	}
	const repoContextCache = new Map<string, string | null>();

	// --- Backfill sessions in batches ---
	const batchSize = 100;
	let offset = 0;

	while (offset < totalCount) {
		const sessions = sourceDb.prepare(`
			SELECT id, project_id, cost, tokens_input, tokens_output,
			       tokens_reasoning, tokens_cache_read, tokens_cache_write,
			       agent, model, title, time_created, time_updated,
			       summary_files, summary_additions, summary_deletions
			FROM session
			${sinceClause}
			ORDER BY time_created ASC
			LIMIT ? OFFSET ?
		`).all(...sinceParams, batchSize, offset) as SourceSession[];

		if (destDb) {
			destDb.run("BEGIN TRANSACTION");
		}

		for (const session of sessions) {
			try {
				const messageCount = getMessageCount(sourceDb, session.id);

				// Resolve agent — fall back to message data for older OpenCode
				// versions (pre-May 2026) that didn't populate session-level columns.
				// Sessions with zero messages are labeled "empty-session" rather
				// than "unknown" to distinguish truly empty spawns from extraction
				// failures.
				const emptyLabel = messageCount === 0 ? "empty-session" : "unknown";
				const agent = session.agent
					|| getAgentFromMessages(sourceDb, session.id)
					|| emptyLabel;

				// Resolve model — same fallback strategy.
				let modelId = extractModelId(session.model);
				if (modelId === "unknown") {
					const msgModel = getModelFromMessages(sourceDb, session.id);
					modelId = msgModel || emptyLabel;
				}
				const firstUserMessage = getFirstUserMessage(sourceDb, session.id);
				const bashCommands = getBashCommands(sourceDb, session.id);
				const partContent = getPartContent(sourceDb, session.id);

				// Classify work-type and budget tag.
				const matchedProject = projects.find((p) => p.id === session.project_id);
				const classificationContext = {
					agent,
					model: modelId,
					project_name: deriveProjectName(
						matchedProject?.name ?? null,
						matchedProject?.worktree ?? null,
					),
					first_user_message: firstUserMessage,
					part_content: partContent,
					bash_commands: bashCommands,
					message_count: messageCount,
				};
				const classification = classify(config.classification_rules, classificationContext);
				const budgetTag = classifyBudget(config.budget_rules ?? [], classificationContext);

				// Derived metrics
				const cacheHitRatio = computeCacheHitRatio(
					session.tokens_cache_read ?? 0,
					session.tokens_input ?? 0,
				);
				const durationSeconds = computeDurationSeconds(
					session.time_created ?? 0,
					session.time_updated ?? 0,
				);

				const recordedAt = session.time_updated || session.time_created || Date.now();

				// Resolve repo context for artifact extraction (cached per project).
				if (!repoContextCache.has(session.project_id)) {
					const worktree = worktreeMap.get(session.project_id);
					const ctx = worktree ? resolveRepoContext(worktree) : null;
					repoContextCache.set(session.project_id, ctx);
				}
				const repoContext = repoContextCache.get(session.project_id) ?? null;

				// Extract PR/issue artifacts from bash tool calls.
				const toolCalls = getBashToolCalls(sourceDb, session.id);
				const prsCreated = extractPRsCreated(toolCalls);
				const prsReviewed = extractPRsReviewed(toolCalls, repoContext);
				const issuesReferenced = extractIssuesReferenced(toolCalls, repoContext);
				const allArtifacts = [...prsCreated, ...prsReviewed, ...issuesReferenced];

				if (destDb) {
					upsertSession(destDb, {
						session_id: session.id,
						project_id: session.project_id,
						agent,
						model: modelId,
						classification,
						title: session.title ?? "untitled",
						started_at: session.time_created ?? 0,
						ended_at: session.time_updated ?? 0,
						metadata: null,
						budget_tag: budgetTag,
					});

					const metricRows = [
						{ metric_name: "cost", value: session.cost ?? 0, recorded_at: recordedAt },
						{ metric_name: "tokens_input", value: session.tokens_input ?? 0, recorded_at: recordedAt },
						{ metric_name: "tokens_output", value: session.tokens_output ?? 0, recorded_at: recordedAt },
						{ metric_name: "tokens_reasoning", value: session.tokens_reasoning ?? 0, recorded_at: recordedAt },
						{ metric_name: "tokens_cache_read", value: session.tokens_cache_read ?? 0, recorded_at: recordedAt },
						{ metric_name: "tokens_cache_write", value: session.tokens_cache_write ?? 0, recorded_at: recordedAt },
						{ metric_name: "cache_hit_ratio", value: cacheHitRatio, recorded_at: recordedAt },
						{ metric_name: "duration_seconds", value: durationSeconds, recorded_at: recordedAt },
						{ metric_name: "files_changed", value: session.summary_files ?? 0, recorded_at: recordedAt },
						{ metric_name: "lines_added", value: session.summary_additions ?? 0, recorded_at: recordedAt },
						{ metric_name: "lines_deleted", value: session.summary_deletions ?? 0, recorded_at: recordedAt },
						{ metric_name: "messages_total", value: messageCount, recorded_at: recordedAt },
						{ metric_name: "prs_created", value: prsCreated.length, recorded_at: recordedAt },
						{ metric_name: "prs_reviewed", value: prsReviewed.length, recorded_at: recordedAt },
						{ metric_name: "issues_referenced", value: issuesReferenced.length, recorded_at: recordedAt },
					];

					// By default, skip delta writes: backfilled sessions only
					// have cumulative totals. Recording delta = cumulative can
					// distort time-sliced aggregations for multi-day sessions.
					// Use --with-deltas for recent sessions where the cost
					// belongs to the session's end date.
					writeMetrics(destDb, session.id, metricRows, {
						skipDeltas: !args.withDeltas,
					});

					// Catch-up: if --with-deltas is set but a previous backfill
					// already wrote cumulative values (without deltas), the delta
					// computation yields 0 and no deltas are written. Insert
					// catch-up deltas for metrics that have cumulative values
					// but no corresponding delta rows.
					if (args.withDeltas) {
						backfillMissingDeltas(destDb, session.id, metricRows);
					}

					// Write artifact detail rows (INSERT OR IGNORE for PK dedup).
					if (allArtifacts.length > 0) {
						upsertArtifacts(destDb, session.id, allArtifacts, recordedAt);
					}
				}

				stats.totalSessions++;
				stats.totalCost += session.cost ?? 0;
				stats.classifications[classification] = (stats.classifications[classification] ?? 0) + 1;
			} catch (err) {
				stats.skipped++;
				console.warn(
					`Warning: skipping session ${session.id}: ${(err as Error).message}`,
				);
			}
		}

		if (destDb) {
			destDb.run("COMMIT");
		}

		offset += sessions.length;
		console.log(`Processed ${Math.min(offset, totalCount)}/${totalCount} sessions...`);
	}

	sourceDb.close();
	if (destDb) destDb.close();

	stats.elapsed = (Date.now() - startTime) / 1000;
	return stats;
}

// ---------------------------------------------------------------------------
// Entry point — guarded so tests can import without side effects.
// ---------------------------------------------------------------------------

if (import.meta.main) {
	const args = parseArgs(process.argv);

	if (args.help) {
		printUsage();
		process.exit(0);
	}

	console.log("opencode-metrics backfill");
	console.log("========================\n");

	const stats = await runBackfill(args);

	console.log("\n--- Summary ---");
	console.log(`Sessions:  ${stats.totalSessions}`);
	console.log(`Cost:      $${stats.totalCost.toFixed(2)}`);
	console.log(`Skipped:   ${stats.skipped}`);
	console.log(`Elapsed:   ${stats.elapsed.toFixed(1)}s`);
	console.log("\nClassification distribution:");
	const sorted = Object.entries(stats.classifications).sort((a, b) => b[1] - a[1]);
	for (const [cls, count] of sorted) {
		console.log(`  ${cls}: ${count}`);
	}

	if (args.dryRun) {
		console.log("\nDry-run complete — no data was written.");
	} else {
		console.log("\nBackfill complete.");
	}
}
