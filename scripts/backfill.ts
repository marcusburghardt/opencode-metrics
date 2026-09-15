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

import { classify } from "../src/classifier";
import { loadConfig } from "../src/config";
import { getDataDir, initDatabase } from "../src/db";
import {
	computeCacheHitRatio,
	computeDurationSeconds,
} from "../src/extractor";
import { upsertProject, upsertSession, writeMetrics } from "../src/writer";

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

interface CliArgs {
	source: string;
	dest: string;
	dryRun: boolean;
	help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
	const args = argv.slice(2); // skip bun and script path
	let source = "";
	let dest = "";
	let dryRun = false;
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

	return { source, dest, dryRun, help };
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
  --dry-run        Analyze source database without writing
  --help           Show this help message

The script reads OpenCode's internal database (read-only) and writes
session metrics into the opencode-metrics database using the same
schema and classification logic as the live plugin.

Safe to run multiple times — uses INSERT ON CONFLICT DO UPDATE.
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
		SELECT json_extract(data, '$.args.command') as command
		FROM part
		WHERE session_id = ?
		  AND json_extract(data, '$.type') = 'tool'
		  AND (
			json_extract(data, '$.tool') LIKE '%bash%'
			OR json_extract(data, '$.tool') LIKE '%shell%'
		  )
		  AND json_extract(data, '$.args.command') IS NOT NULL
	`).all(sessionId) as Array<{ command: string }>;

	return rows.map((r) => r.command);
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
	const countRow = sourceDb.prepare("SELECT COUNT(*) as cnt FROM session").get() as { cnt: number };
	const totalCount = countRow.cnt;
	console.log(`Found ${totalCount} sessions to process`);

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
			ORDER BY time_created ASC
			LIMIT ? OFFSET ?
		`).all(batchSize, offset) as SourceSession[];

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

				// Classify
				const classification = classify(config.classification_rules, {
					agent,
					model: modelId,
					first_user_message: firstUserMessage,
					part_content: partContent,
					bash_commands: bashCommands,
					message_count: messageCount,
				});

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
					});

					writeMetrics(destDb, session.id, [
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
					]);
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
