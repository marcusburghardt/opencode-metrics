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
	deriveFlowMetrics,
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
// Source layout detection and reader seam
// ---------------------------------------------------------------------------

/** OpenCode source database layouts understood by the backfill script. */
export type SourceLayout = "legacy" | "v2";

/**
 * Raised when the source database has an incomplete or unrecognised schema.
 * The message names every missing table so an operator can see which layout
 * the database fails to satisfy.
 */
export class SourceSchemaError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SourceSchemaError";
	}
}

const LEGACY_TABLES = ["session", "message", "part", "project"] as const;
const V2_TABLES = ["session_v2", "session_message", "session_part"] as const;

function getTableNames(db: Database): Set<string> {
	const rows = db.prepare(
		"SELECT name FROM sqlite_master WHERE type='table'",
	).all() as Array<{ name: string }>;
	return new Set(rows.map((row) => row.name));
}

function legacySchemaError(missing: ReadonlyArray<string>): SourceSchemaError {
	return new SourceSchemaError(
		`Source database is missing required tables: ${missing.join(", ")}. ` +
		"This does not appear to be an OpenCode database.",
	);
}

/**
 * Validate the legacy OpenCode schema.
 *
 * Retained for callers that only understand the legacy layout. `runBackfill`
 * uses `detectSourceLayout` instead, which validates both layouts.
 */
export function validateSourceSchema(db: Database): void {
	const tableNames = getTableNames(db);
	const missing = LEGACY_TABLES.filter((table) => !tableNames.has(table));
	if (missing.length > 0) {
		throw legacySchemaError(missing);
	}
}

/**
 * Detect which OpenCode layout the source database uses.
 *
 * V2 wins when all three V2 tables exist. A partial V2 layout (any V2 table
 * present but the trio incomplete) is rejected rather than silently falling
 * back to the legacy tables, which would import stale or partial data.
 * Otherwise the legacy tables must all be present.
 */
export function detectSourceLayout(db: Database): SourceLayout {
	const tableNames = getTableNames(db);
	const hasAnyV2Table = V2_TABLES.some((table) => tableNames.has(table));

	if (hasAnyV2Table) {
		const missingV2 = V2_TABLES.filter((table) => !tableNames.has(table));
		if (missingV2.length > 0) {
			throw new SourceSchemaError(
				"Source database has an incomplete OpenCode V2 layout. " +
				`Missing required tables: ${missingV2.join(", ")}.`,
			);
		}
		return "v2";
	}

	const missingLegacy = LEGACY_TABLES.filter((table) => !tableNames.has(table));
	if (missingLegacy.length > 0) {
		throw legacySchemaError(missingLegacy);
	}
	return "legacy";
}

export interface SourceProject {
	id: string;
	name: string | null;
	worktree: string | null;
}

export interface SourceSession {
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
	/** Parent session for sub-agent sessions; NULL for root sessions. */
	parent_id: string | null;
}

/**
 * Layout-agnostic source reader. `runBackfill` holds the classification,
 * metric, delta, and artifact logic and calls only this interface.
 */
export interface BackfillSource {
	readonly layout: SourceLayout;
	listProjects(): SourceProject[];
	countSessions(since: number | null): number;
	listSessions(since: number | null, limit: number, offset: number): SourceSession[];
	getMessageCount(sessionId: string): number;
	getFirstUserMessage(sessionId: string): string;
	getConversationText(sessionId: string): string;
	getBashCommands(sessionId: string): string[];
	getBashToolCalls(sessionId: string): BashToolCall[];
	getAgentFallback(sessionId: string): string | null;
	getModelFallback(sessionId: string): string | null;
	/**
	 * Decoded message history in the shape `deriveFlowMetrics` expects
	 * (`type`, `tokens`, `time`). Used to recover turn, context, timing,
	 * and compaction metrics from historical sessions. Permission metrics
	 * cannot be recovered: their event history is not persisted.
	 */
	getRawMessages(sessionId: string): unknown[];
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
// Legacy reader — preserved SQL and result shapes
// ---------------------------------------------------------------------------

function createLegacySource(sourceDb: Database): BackfillSource {
	return {
		layout: "legacy",
		listProjects: () =>
			sourceDb.prepare("SELECT id, name, worktree FROM project").all() as SourceProject[],
		countSessions: (since) => {
			const sinceClause = since !== null ? " WHERE time_created >= ?" : "";
			const params = since !== null ? [since] : [];
			const row = sourceDb
				.prepare(`SELECT COUNT(*) as cnt FROM session${sinceClause}`)
				.get(...params) as { cnt: number } | null;
			return row?.cnt ?? 0;
		},
		listSessions: (since, limit, offset) => {
			const sinceClause = since !== null ? " WHERE time_created >= ?" : "";
			const params = since !== null ? [since] : [];
			return sourceDb.prepare(`
				SELECT id, project_id, cost, tokens_input, tokens_output,
				       tokens_reasoning, tokens_cache_read, tokens_cache_write,
				       agent, model, title, time_created, time_updated,
				       summary_files, summary_additions, summary_deletions, parent_id
				FROM session
				${sinceClause}
				ORDER BY time_created ASC
				LIMIT ? OFFSET ?
			`).all(...params, limit, offset) as SourceSession[];
		},
		getMessageCount: (sessionId) => getMessageCount(sourceDb, sessionId),
		getFirstUserMessage: (sessionId) => getFirstUserMessage(sourceDb, sessionId),
		getConversationText: (sessionId) => getPartContent(sourceDb, sessionId),
		getBashCommands: (sessionId) => getBashCommands(sourceDb, sessionId),
		getBashToolCalls: (sessionId) => getBashToolCalls(sourceDb, sessionId),
		getAgentFallback: (sessionId) => getAgentFromMessages(sourceDb, sessionId),
		getModelFallback: (sessionId) => getModelFromMessages(sourceDb, sessionId),
		getRawMessages: (sessionId) => {
			// Legacy messages store the discriminator as `role`; map it to the
			// V2 `type` field so the shared flow-metric extractor can read
			// both layouts. Compaction parts are not included.
			const rows = sourceDb.prepare(
				"SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created ASC",
			).all(sessionId) as Array<{ id: string; data: string }>;

			const messages: unknown[] = [];
			for (const row of rows) {
				const decoded = decodeJsonObject(row.data);
				if (!decoded) continue;
				messages.push({
					...decoded,
					id: row.id,
					type: typeof decoded.role === "string" ? decoded.role : "unknown",
				});
			}
			return messages;
		},
	};
}

// ---------------------------------------------------------------------------
// V2 reader — JSON message/part decoding with embedded-content fallback
// ---------------------------------------------------------------------------

type V2ConversationMessageType = "user" | "assistant";

interface V2ConversationMessage {
	id: string;
	type: V2ConversationMessageType;
	/** Decoded `session_message.data`, or null when the JSON is malformed. */
	data: Record<string, unknown> | null;
}

function asObject(value: unknown): Record<string, unknown> | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
}

function decodeJsonObject(raw: unknown): Record<string, unknown> | null {
	if (typeof raw !== "string" || raw.length === 0) return null;
	try {
		return asObject(JSON.parse(raw));
	} catch {
		return null;
	}
}

/** Text payloads from a decoded part, used for both layouts. */
function textParts(parts: ReadonlyArray<unknown>): string[] {
	const texts: string[] = [];
	for (const part of parts) {
		const obj = asObject(part);
		if (!obj || obj.type !== "text") continue;
		if (typeof obj.text === "string") texts.push(obj.text);
	}
	return texts;
}

/** A single decoded part's text, or null when it is not a text part. */
function partText(part: unknown): string | null {
	const obj = asObject(part);
	if (!obj || obj.type !== "text") return null;
	return typeof obj.text === "string" ? obj.text : null;
}

/** Tool part payloads named bash/shell with a command string. */
function bashToolCallsFromParts(parts: ReadonlyArray<unknown>): BashToolCall[] {
	const calls: BashToolCall[] = [];
	for (const part of parts) {
		const obj = asObject(part);
		if (!obj || obj.type !== "tool") continue;

		const name =
			typeof obj.name === "string"
				? obj.name
				: typeof obj.tool === "string"
					? obj.tool
					: "";
		const normalizedName = name.toLowerCase();
		if (normalizedName !== "bash" && normalizedName !== "shell") continue;

		const state = asObject(obj.state);
		const input = asObject(state?.input);
		const command = input?.command;
		if (typeof command !== "string") continue;

		// Only a completed tool has final output. Running, streaming, and
		// errored tools contribute their command but no fabricated output.
		let output: string | undefined;
		if (state?.status === "completed" && Array.isArray(state.content)) {
			const texts = textParts(state.content);
			if (texts.length > 0) output = texts.join("\n");
		}

		calls.push({ command, output });
	}
	return calls;
}

function createV2Source(sourceDb: Database): BackfillSource {
	// Per-session caches. runBackfill processes one session at a time, so a
	// single-entry message cache plus a part cache reset per session keeps
	// the N+1 query pattern from re-reading the same JSON payloads.
	let cachedSessionId: string | null = null;
	let cachedMessages: V2ConversationMessage[] = [];
	let cachedPartsSessionId: string | null = null;
	const partCache = new Map<string, unknown[]>();

	function conversationMessages(sessionId: string): V2ConversationMessage[] {
		if (cachedSessionId === sessionId) return cachedMessages;

		const rows = sourceDb.prepare(`
			SELECT id, type, data
			FROM session_message
			WHERE session_id = ? AND type IN ('user', 'assistant')
			ORDER BY time_created ASC, seq ASC
		`).all(sessionId) as Array<{ id: string; type: string; data: string }>;

		cachedSessionId = sessionId;
		cachedMessages = rows.map((row) => ({
			id: row.id,
			type: row.type as V2ConversationMessageType,
			data: decodeJsonObject(row.data),
		}));
		return cachedMessages;
	}

	/** Parts embedded directly in `session_message.data`. */
	function embeddedParts(message: V2ConversationMessage): unknown[] {
		const data = message.data;
		if (!data) return [];
		if (message.type === "user") {
			return typeof data.text === "string" ? [{ type: "text", text: data.text }] : [];
		}
		return Array.isArray(data.content) ? data.content : [];
	}

	/**
	 * Unified part loader: `session_part` rows win when present; otherwise
	 * the content embedded in `session_message.data` is used. Unknown part
	 * variants and malformed JSON are skipped rather than thrown.
	 */
	function messageParts(sessionId: string, message: V2ConversationMessage): unknown[] {
		if (cachedPartsSessionId !== sessionId) {
			partCache.clear();
			cachedPartsSessionId = sessionId;
		}
		const cached = partCache.get(message.id);
		if (cached) return cached;

		const rows = sourceDb.prepare(
			"SELECT type, data FROM session_part WHERE message_id = ? ORDER BY ordinal ASC",
		).all(message.id) as Array<{ type: string; data: string }>;

		let parts: unknown[];
		if (rows.length > 0) {
			parts = [];
			for (const row of rows) {
				const decoded = asObject(decodeJsonObject(row.data));
				if (!decoded) continue;
				// The table's type column is authoritative when the JSON
				// payload omits its own discriminator.
				if (typeof decoded.type !== "string") decoded.type = row.type;
				parts.push(decoded);
			}
		} else {
			parts = embeddedParts(message);
		}

		partCache.set(message.id, parts);
		return parts;
	}

	function conversationParts(sessionId: string): Array<{ message: V2ConversationMessage; parts: unknown[] }> {
		return conversationMessages(sessionId).map((message) => ({
			message,
			parts: messageParts(sessionId, message),
		}));
	}

	function firstAssistantMessage(sessionId: string): V2ConversationMessage | undefined {
		return conversationMessages(sessionId).find((message) => message.type === "assistant");
	}

	return {
		layout: "v2",
		listProjects: () =>
			sourceDb.prepare("SELECT id, name, worktree FROM project").all() as SourceProject[],
		countSessions: (since) => {
			const sinceClause = since !== null ? " WHERE time_created >= ?" : "";
			const params = since !== null ? [since] : [];
			const row = sourceDb
				.prepare(`SELECT COUNT(*) as cnt FROM session_v2${sinceClause}`)
				.get(...params) as { cnt: number } | null;
			return row?.cnt ?? 0;
		},
		listSessions: (since, limit, offset) => {
			const sinceClause = since !== null ? " WHERE time_created >= ?" : "";
			const params = since !== null ? [since] : [];
			return sourceDb.prepare(`
				SELECT id, project_id, cost, tokens_input, tokens_output,
				       tokens_reasoning, tokens_cache_read, tokens_cache_write,
				       agent, model, title, time_created, time_updated,
				       summary_files, summary_additions, summary_deletions, parent_id
				FROM session_v2
				${sinceClause}
				ORDER BY time_created ASC, id ASC
				LIMIT ? OFFSET ?
			`).all(...params, limit, offset) as SourceSession[];
		},
		getMessageCount: (sessionId) => {
			const row = sourceDb.prepare(
				"SELECT COUNT(*) as cnt FROM session_message WHERE session_id = ? AND type IN ('user', 'assistant')",
			).get(sessionId) as { cnt: number } | null;
			return row?.cnt ?? 0;
		},
		getFirstUserMessage: (sessionId) => {
			const firstUser = conversationMessages(sessionId).find((message) => message.type === "user");
			if (!firstUser) return "";
			return textParts(messageParts(sessionId, firstUser)).join("\n");
		},
		getConversationText: (sessionId) => {
			const texts: string[] = [];
			for (const { parts } of conversationParts(sessionId)) {
				for (const part of parts) {
					const text = partText(part);
					if (text === null) continue;
					texts.push(text);
					if (texts.length >= 50) return texts.join("\n");
				}
			}
			return texts.join("\n");
		},
		getBashCommands: (sessionId) =>
			bashToolCallsFromParts(conversationParts(sessionId).flatMap((entry) => entry.parts))
				.map((call) => call.command),
		getBashToolCalls: (sessionId) =>
			bashToolCallsFromParts(conversationParts(sessionId).flatMap((entry) => entry.parts)),
		getAgentFallback: (sessionId) => {
			const agent = firstAssistantMessage(sessionId)?.data?.agent;
			return typeof agent === "string" ? agent : null;
		},
		getModelFallback: (sessionId) => {
			const model = asObject(firstAssistantMessage(sessionId)?.data?.model);
			return typeof model?.id === "string" ? model.id : null;
		},
		getRawMessages: (sessionId) => {
			// Every message type participates: the flow extractor needs
			// assistant turns plus compaction markers. The table's `type`
			// and `id` are injected because the JSON payload may omit them.
			const rows = sourceDb.prepare(`
				SELECT id, type, data
				FROM session_message
				WHERE session_id = ?
				ORDER BY time_created ASC, seq ASC
			`).all(sessionId) as Array<{ id: string; type: string; data: string }>;

			const messages: unknown[] = [];
			for (const row of rows) {
				const decoded = decodeJsonObject(row.data);
				if (!decoded) continue;
				messages.push({ ...decoded, id: row.id, type: row.type });
			}
			return messages;
		},
	};
}

/**
 * Select the reader for the source database's layout.
 * Detection runs before any destination work, so a partial V2 schema fails
 * without initializing or writing the metrics database.
 */
export function createSourceReader(db: Database): BackfillSource {
	const layout = detectSourceLayout(db);
	return layout === "v2" ? createV2Source(db) : createLegacySource(db);
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

export interface BackfillStats {
	totalSessions: number;
	totalCost: number;
	classifications: Record<string, number>;
	skipped: number;
	/** Imported sessions whose source `summary_files` was NULL. */
	missingSummary: number;
	/** Detected source layout; null when the run failed before detection. */
	layout: SourceLayout | null;
	elapsed: number;
}

/**
 * Import historical sessions from the source database.
 *
 * Setup failures throw instead of exiting so tests can call this directly and
 * so a partial V2 layout fails before the destination database is touched.
 * The `import.meta.main` entry point catches, prints, and exits 1.
 */
export async function runBackfill(args: CliArgs): Promise<BackfillStats> {
	const startTime = Date.now();
	const stats: BackfillStats = {
		totalSessions: 0,
		totalCost: 0,
		classifications: {},
		skipped: 0,
		missingSummary: 0,
		layout: null,
		elapsed: 0,
	};

	// --- Validate source ---
	if (!existsSync(args.source)) {
		throw new Error(
			`Source database not found at: ${args.source}. ` +
			"Use --source <path> to specify an alternative location.",
		);
	}

	// --- Same-file protection (before any destination work) ---
	const destDbPath = path.join(args.dest, "metrics.db");
	if (existsSync(destDbPath)) {
		let canonicalSource: string | null = null;
		let canonicalDest: string | null = null;
		try {
			canonicalSource = realpathSync(args.source);
			canonicalDest = realpathSync(destDbPath);
		} catch {
			// realpathSync may fail if either path disappears mid-run — OK.
		}
		if (canonicalSource !== null && canonicalSource === canonicalDest) {
			throw new Error(
				`Source and destination resolve to the same file: ${canonicalSource}`,
			);
		}
	}

	// --- Open source (read-only) ---
	const sourceDb = new Database(args.source, { readonly: true });
	console.log(`Source: ${args.source}`);

	let destDb: Database | null = null;
	try {
		// --- Detect layout and build the reader before touching the destination ---
		const source = createSourceReader(sourceDb);
		stats.layout = source.layout;
		console.log(`Source layout: ${source.layout}`);

		// --- Count sessions ---
		const totalCount = source.countSessions(args.since);

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
		if (!args.dryRun) {
			const { db } = initDatabase(args.dest);
			destDb = db;
			console.log(`Destination: ${path.join(args.dest, "metrics.db")}`);
		} else {
			console.log("Dry-run mode — no writes will be performed");
		}

		// --- Backfill projects ---
		const projects = source.listProjects();
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
			const sessions = source.listSessions(args.since, batchSize, offset);

			if (destDb) {
				destDb.run("BEGIN TRANSACTION");
			}

			for (const session of sessions) {
				try {
					const messageCount = source.getMessageCount(session.id);

					// Resolve agent — fall back to message data for older OpenCode
					// versions (pre-May 2026) that didn't populate session-level columns.
					// Sessions with zero messages are labeled "empty-session" rather
					// than "unknown" to distinguish truly empty spawns from extraction
					// failures.
					const emptyLabel = messageCount === 0 ? "empty-session" : "unknown";
					const agent = session.agent
						|| source.getAgentFallback(session.id)
						|| emptyLabel;

					// Resolve model — same fallback strategy.
					let modelId = extractModelId(session.model);
					if (modelId === "unknown") {
						const msgModel = source.getModelFallback(session.id);
						modelId = msgModel || emptyLabel;
					}
					const firstUserMessage = source.getFirstUserMessage(session.id);
					const bashCommands = source.getBashCommands(session.id);
					const partContent = source.getConversationText(session.id);

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
						parent_session_id: "",
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
					const toolCalls = source.getBashToolCalls(session.id);
					const prsCreated = extractPRsCreated(toolCalls);
					const prsReviewed = extractPRsReviewed(toolCalls, repoContext);
					const issuesReferenced = extractIssuesReferenced(toolCalls, repoContext);
					const allArtifacts = [...prsCreated, ...prsReviewed, ...issuesReferenced];

					// Flow metrics reconstructed from the persisted message
					// history. Permission prompts and waits are absent by
					// design: OpenCode does not persist those events.
					const flowMetrics = deriveFlowMetrics(source.getRawMessages(session.id));

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
							parent_session_id: session.parent_id ?? null,
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
							{ metric_name: "turns_total", value: flowMetrics.turns_total, recorded_at: recordedAt },
							{
								metric_name: "context_tokens_max",
								value: flowMetrics.context_tokens_max,
								recorded_at: recordedAt,
							},
							{
								metric_name: "context_tokens_final",
								value: flowMetrics.context_tokens_final,
								recorded_at: recordedAt,
							},
							{
								metric_name: "post_generation_seconds",
								value: flowMetrics.post_generation_seconds,
								recorded_at: recordedAt,
							},
							{ metric_name: "compactions", value: flowMetrics.compactions, recorded_at: recordedAt },
						];

						// Generation speed requires every assistant turn to be
						// timed. For partially timed histories, drop any stale
						// values from an earlier run rather than publish a rate
						// built from mismatched numerators and denominators.
						const completeGenerationTiming =
							flowMetrics.turns_total > 0 &&
							flowMetrics.timed_turns === flowMetrics.turns_total;
						if (completeGenerationTiming) {
							metricRows.push(
								{
									metric_name: "generation_seconds",
									value: flowMetrics.generation_seconds,
									recorded_at: recordedAt,
								},
								{
									metric_name: "generation_output_tokens",
									value: flowMetrics.generation_output_tokens,
									recorded_at: recordedAt,
								},
							);
						} else {
							destDb.run(
								"DELETE FROM measurements WHERE session_id = ? AND metric_name IN ('generation_seconds', 'generation_output_tokens')",
								[session.id],
							);
							destDb.run(
								"DELETE FROM measurement_deltas WHERE session_id = ? AND metric_name IN ('generation_seconds', 'generation_output_tokens')",
								[session.id],
							);
						}

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
					if (session.summary_files === null) stats.missingSummary++;
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

		// Recompute child counts after every session exists. Counting during
		// the per-session pass would see zero children for a parent processed
		// before its child (sessions are ordered by creation time).
		if (destDb) {
			destDb.run(`
				INSERT INTO measurements (session_id, metric_name, value, recorded_at)
				SELECT
					s.session_id,
					'child_sessions',
					COUNT(c.session_id),
					COALESCE(NULLIF(s.ended_at, 0), CAST(strftime('%s', 'now') AS INTEGER) * 1000)
				FROM sessions s
				LEFT JOIN sessions c
					ON c.parent_session_id = s.session_id
					AND c.session_id != s.session_id
				WHERE true
				GROUP BY s.session_id
				ON CONFLICT(session_id, metric_name) DO UPDATE SET
					value = excluded.value,
					recorded_at = excluded.recorded_at
			`);
		}
	} finally {
		sourceDb.close();
		if (destDb) destDb.close();
	}

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

	try {
		const stats = await runBackfill(args);

		console.log("\n--- Summary ---");
		console.log(`Layout:    ${stats.layout ?? "unknown"}`);
		console.log(`Sessions:  ${stats.totalSessions}`);
		console.log(`Cost:      $${stats.totalCost.toFixed(2)}`);
		console.log(`Skipped:   ${stats.skipped}`);
		console.log(`Missing diff summary: ${stats.missingSummary}`);
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
	} catch (err) {
		console.error((err as Error).message);
		process.exit(1);
	}
}
