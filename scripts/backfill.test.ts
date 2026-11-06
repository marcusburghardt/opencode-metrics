// SPDX-License-Identifier: Apache-2.0

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { classify } from "../src/classifier";
import { loadConfig } from "../src/config";
import { initDatabase } from "../src/db";
import { computeCacheHitRatio, computeDurationSeconds } from "../src/extractor";
import { upsertProject, upsertSession, writeMetrics } from "../src/writer";
import {
	type BackfillStats,
	backfillMissingDeltas,
	createSourceReader,
	deriveProjectName,
	detectSourceLayout,
	extractModelId,
	parseDateToEpochMs,
	runBackfill,
	SourceSchemaError,
	validateSourceSchema,
} from "./backfill";

// ---------------------------------------------------------------------------
// Source database helper — builds a minimal OpenCode schema with test data.
// ---------------------------------------------------------------------------

/**
 * Create a temporary SQLite database with the OpenCode source schema.
 * Returns the opened Database handle; caller is responsible for closing it.
 */
function createSourceDb(dbPath: string): Database {
	const db = new Database(dbPath, { create: true });

	db.run(`
		CREATE TABLE project (
			id TEXT PRIMARY KEY,
			name TEXT,
			worktree TEXT
		)
	`);
	db.run(`
		CREATE TABLE session (
			id TEXT PRIMARY KEY,
			project_id TEXT,
			parent_id TEXT,
			cost REAL DEFAULT 0,
			tokens_input INTEGER DEFAULT 0,
			tokens_output INTEGER DEFAULT 0,
			tokens_reasoning INTEGER DEFAULT 0,
			tokens_cache_read INTEGER DEFAULT 0,
			tokens_cache_write INTEGER DEFAULT 0,
			agent TEXT,
			model TEXT,
			title TEXT,
			time_created INTEGER,
			time_updated INTEGER,
			summary_files INTEGER,
			summary_additions INTEGER,
			summary_deletions INTEGER
		)
	`);
	db.run(`
		CREATE TABLE message (
			id TEXT PRIMARY KEY,
			session_id TEXT,
			time_created INTEGER,
			time_updated INTEGER,
			data TEXT
		)
	`);
	db.run(`
		CREATE TABLE part (
			id TEXT PRIMARY KEY,
			message_id TEXT,
			session_id TEXT,
			time_created INTEGER,
			time_updated INTEGER,
			data TEXT
		)
	`);

	return db;
}

/**
 * Insert a project into the source database.
 */
function insertProject(
	db: Database,
	id: string,
	name: string | null,
	worktree: string | null,
): void {
	db.run("INSERT INTO project (id, name, worktree) VALUES (?, ?, ?)", [id, name, worktree]);
}

/**
 * Insert a session with messages and parts into the source database.
 * Creates a user message and an assistant message with text parts.
 */
function insertSessionWithData(
	db: Database,
	opts: {
		sessionId: string;
		projectId: string;
		cost: number;
		tokensInput: number;
		tokensOutput: number;
		tokensReasoning?: number;
		tokensCacheRead?: number;
		tokensCacheWrite?: number;
		agent?: string;
		model?: string;
		title?: string;
		timeCreated: number;
		timeUpdated: number;
		summaryFiles?: number;
		summaryAdditions?: number;
		summaryDeletions?: number;
		userMessage?: string;
		parentId?: string | null;
	},
): void {
	db.run(
		`INSERT INTO session (
			id, project_id, parent_id, cost, tokens_input, tokens_output,
			tokens_reasoning, tokens_cache_read, tokens_cache_write,
			agent, model, title, time_created, time_updated,
			summary_files, summary_additions, summary_deletions
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			opts.sessionId,
			opts.projectId,
			opts.parentId ?? null,
			opts.cost,
			opts.tokensInput,
			opts.tokensOutput,
			opts.tokensReasoning ?? 0,
			opts.tokensCacheRead ?? 0,
			opts.tokensCacheWrite ?? 0,
			opts.agent ?? "build",
			opts.model ?? '{"id":"claude-opus-4-6"}',
			opts.title ?? "Test session",
			opts.timeCreated,
			opts.timeUpdated,
			opts.summaryFiles ?? 0,
			opts.summaryAdditions ?? 0,
			opts.summaryDeletions ?? 0,
		],
	);

	// Insert a user message with a text part.
	const userMsgId = `msg-user-${opts.sessionId}`;
	const userText = opts.userMessage ?? "implement the feature";
	db.run(
		"INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
		[
			userMsgId,
			opts.sessionId,
			opts.timeCreated,
			opts.timeCreated + 100,
			JSON.stringify({ role: "user" }),
		],
	);
	db.run(
		"INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
		[
			`part-user-${opts.sessionId}`,
			userMsgId,
			opts.sessionId,
			opts.timeCreated,
			opts.timeCreated + 100,
			JSON.stringify({ type: "text", text: userText }),
		],
	);

	// Insert an assistant message with a text part.
	const assistantMsgId = `msg-asst-${opts.sessionId}`;
	db.run(
		"INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
		[
			assistantMsgId,
			opts.sessionId,
			opts.timeCreated + 200,
			opts.timeUpdated,
			JSON.stringify({ role: "assistant" }),
		],
	);
	db.run(
		"INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
		[
			`part-asst-${opts.sessionId}`,
			assistantMsgId,
			opts.sessionId,
			opts.timeCreated + 200,
			opts.timeUpdated,
			JSON.stringify({ type: "text", text: "Done implementing the feature." }),
		],
	);
}

/**
 * Perform the core backfill logic for a single session from source to dest DB.
 * Mirrors the inner loop of runBackfill() using the same exported functions
 * the production script uses.
 *
 * @param withDeltas - When true, write measurement deltas alongside
 *   cumulative values. Mirrors the --with-deltas CLI flag.
 */
function backfillSession(
	sourceDb: Database,
	destDb: Database,
	session: {
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
	},
	config: ReturnType<typeof loadConfig>,
	withDeltas = false,
): void {
	const modelId = extractModelId(session.model);

	// Get message count.
	const countRow = sourceDb
		.prepare("SELECT COUNT(*) as cnt FROM message WHERE session_id = ?")
		.get(session.id) as { cnt: number };
	const messageCount = countRow?.cnt ?? 0;

	// Get first user message.
	const msgRow = sourceDb
		.prepare(
			`SELECT id FROM message
			WHERE session_id = ? AND json_extract(data, '$.role') = 'user'
			ORDER BY time_created ASC LIMIT 1`,
		)
		.get(session.id) as { id: string } | null;

	let firstUserMessage = "";
	if (msgRow) {
		const parts = sourceDb
			.prepare(
				`SELECT json_extract(data, '$.text') as text
				FROM part
				WHERE message_id = ? AND json_extract(data, '$.type') = 'text'
				ORDER BY time_created ASC`,
			)
			.all(msgRow.id) as Array<{ text: string | null }>;
		firstUserMessage = parts.map((p) => p.text ?? "").join("\n");
	}

	// Get part content.
	const contentRows = sourceDb
		.prepare(
			`SELECT json_extract(data, '$.text') as text
			FROM part
			WHERE session_id = ? AND json_extract(data, '$.type') = 'text'
			LIMIT 50`,
		)
		.all(session.id) as Array<{ text: string | null }>;
	const partContent = contentRows.map((r) => r.text ?? "").join("\n");

	// Get bash commands.
	const cmdRows = sourceDb
		.prepare(
			`SELECT json_extract(data, '$.args.command') as command
			FROM part
			WHERE session_id = ?
			  AND json_extract(data, '$.type') = 'tool'
			  AND (
				json_extract(data, '$.tool') LIKE '%bash%'
				OR json_extract(data, '$.tool') LIKE '%shell%'
			  )
			  AND json_extract(data, '$.args.command') IS NOT NULL`,
		)
		.all(session.id) as Array<{ command: string }>;
	const bashCommands = cmdRows.map((r) => r.command);

	// Classify.
	const classification = classify(config.classification_rules, {
		agent: session.agent ?? "unknown",
		model: modelId,
		first_user_message: firstUserMessage,
		part_content: partContent,
		bash_commands: bashCommands,
		message_count: messageCount,
	});

	// Derived metrics.
	const cacheHitRatio = computeCacheHitRatio(
		session.tokens_cache_read ?? 0,
		session.tokens_input ?? 0,
	);
	const durationSeconds = computeDurationSeconds(
		session.time_created ?? 0,
		session.time_updated ?? 0,
	);
	const recordedAt = session.time_updated || session.time_created || Date.now();

	// Write to dest.
	upsertSession(destDb, {
		session_id: session.id,
		project_id: session.project_id,
		agent: session.agent ?? "unknown",
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
		{
			metric_name: "tokens_output",
			value: session.tokens_output ?? 0,
			recorded_at: recordedAt,
		},
		{
			metric_name: "tokens_reasoning",
			value: session.tokens_reasoning ?? 0,
			recorded_at: recordedAt,
		},
		{
			metric_name: "tokens_cache_read",
			value: session.tokens_cache_read ?? 0,
			recorded_at: recordedAt,
		},
		{
			metric_name: "tokens_cache_write",
			value: session.tokens_cache_write ?? 0,
			recorded_at: recordedAt,
		},
		{ metric_name: "cache_hit_ratio", value: cacheHitRatio, recorded_at: recordedAt },
		{ metric_name: "duration_seconds", value: durationSeconds, recorded_at: recordedAt },
		{
			metric_name: "files_changed",
			value: session.summary_files ?? 0,
			recorded_at: recordedAt,
		},
		{
			metric_name: "lines_added",
			value: session.summary_additions ?? 0,
			recorded_at: recordedAt,
		},
		{
			metric_name: "lines_deleted",
			value: session.summary_deletions ?? 0,
			recorded_at: recordedAt,
		},
		{ metric_name: "messages_total", value: messageCount, recorded_at: recordedAt },
	], { skipDeltas: !withDeltas });
}

// ---------------------------------------------------------------------------
// V2 source database helper — mirrors the OpenCode 2.2.5 layout.
// ---------------------------------------------------------------------------

/** A part payload as stored in `session_message.data.content` or `session_part.data`. */
type V2PartFixture = Record<string, unknown>;

function textPart(text: string): V2PartFixture {
	return { type: "text", text };
}

function reasoningPart(text: string): V2PartFixture {
	return { type: "reasoning", text };
}

function toolPart(
	name: string,
	options: {
		command?: string;
		status?: string;
		output?: string[];
		extraContent?: unknown[];
	} = {},
): V2PartFixture {
	const content = [
		...(options.output ?? []).map((text) => ({ type: "text", text })),
		...(options.extraContent ?? []),
	];
	return {
		type: "tool",
		name,
		state: {
			status: options.status ?? "completed",
			input: options.command !== undefined ? { command: options.command } : {},
			...(content.length > 0 ? { content } : {}),
		},
	};
}

/**
 * One message fixture. `content` is embedded in `session_message.data`;
 * `parts`, when present, writes `session_part` rows for the same message so
 * tests can prove part precedence over embedded content.
 */
interface V2MessageFixture {
	type: string;
	text?: string;
	agent?: string;
	modelId?: string;
	content?: V2PartFixture[];
	parts?: V2PartFixture[];
	malformed?: boolean;
	/** Assistant token usage, matching `session_message.data.tokens`. */
	tokens?: { input?: number; cache?: { read?: number; write?: number } };
	/** Streaming/completion timestamps used by flow-metric extraction. */
	timeStreamed?: number;
	timeCompleted?: number;
}

interface V2SessionFixture {
	sessionId: string;
	projectId: string;
	cost?: number;
	tokensInput?: number;
	tokensOutput?: number;
	tokensReasoning?: number;
	tokensCacheRead?: number;
	tokensCacheWrite?: number;
	agent?: string | null;
	/** Raw JSON string, matching `session_v2.model`. */
	model?: string | null;
	title?: string | null;
	timeCreated: number;
	timeUpdated: number;
	summaryFiles?: number | null;
	summaryAdditions?: number | null;
	summaryDeletions?: number | null;
	parentId?: string | null;
	messages?: V2MessageFixture[];
}

/**
 * Create a temporary SQLite database with the OpenCode V2 schema.
 * Tests that need a partial layout drop the relevant table afterwards.
 */
function createV2SourceDb(dbPath: string): Database {
	const db = new Database(dbPath, { create: true });

	db.run(`
		CREATE TABLE project (
			id TEXT PRIMARY KEY,
			name TEXT,
			worktree TEXT
		)
	`);
	db.run(`
		CREATE TABLE session_v2 (
			id TEXT PRIMARY KEY,
			project_id TEXT NOT NULL,
			parent_id TEXT,
			title TEXT,
			cost REAL DEFAULT 0 NOT NULL,
			tokens_input INTEGER DEFAULT 0 NOT NULL,
			tokens_output INTEGER DEFAULT 0 NOT NULL,
			tokens_reasoning INTEGER DEFAULT 0 NOT NULL,
			tokens_cache_read INTEGER DEFAULT 0 NOT NULL,
			tokens_cache_write INTEGER DEFAULT 0 NOT NULL,
			agent TEXT,
			model TEXT,
			time_created INTEGER NOT NULL,
			time_updated INTEGER NOT NULL,
			summary_files INTEGER,
			summary_additions INTEGER,
			summary_deletions INTEGER
		)
	`);
	db.run(`
		CREATE TABLE session_message (
			id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL,
			type TEXT NOT NULL,
			seq INTEGER NOT NULL,
			time_created INTEGER NOT NULL,
			time_updated INTEGER NOT NULL,
			data TEXT NOT NULL
		)
	`);
	db.run(`
		CREATE TABLE session_part (
			message_id TEXT NOT NULL,
			session_id TEXT NOT NULL,
			ordinal INTEGER NOT NULL,
			type TEXT NOT NULL,
			call_id TEXT,
			time_created INTEGER NOT NULL,
			time_updated INTEGER NOT NULL,
			data TEXT NOT NULL,
			PRIMARY KEY (message_id, ordinal)
		)
	`);

	return db;
}

function buildV2MessageData(
	message: V2MessageFixture,
	createdAt: number,
): Record<string, unknown> {
	const data: Record<string, unknown> = { time: { created: createdAt } };

	if (message.type === "user") {
		data.text = message.text ?? "";
		return data;
	}

	// Compactions carry only a timestamp and an id in the real payload.
	if (message.type === "compaction") return data;

	data.content = message.content ?? [];
	if (message.text !== undefined) data.text = message.text;
	if (message.agent !== undefined) data.agent = message.agent;
	if (message.modelId !== undefined) data.model = { id: message.modelId };
	if (message.tokens !== undefined) data.tokens = message.tokens;
	if (message.timeStreamed !== undefined) {
		(data.time as Record<string, number>).streamed = message.timeStreamed;
	}
	if (message.timeCompleted !== undefined) {
		(data.time as Record<string, number>).completed = message.timeCompleted;
	}
	return data;
}

/**
 * Insert a V2 session with conversation messages, optional inline content, and
 * optional `session_part` rows.
 */
function insertV2Session(db: Database, session: V2SessionFixture): void {
	db.run(
		`INSERT INTO session_v2 (
			id, project_id, parent_id, title, cost, tokens_input, tokens_output,
			tokens_reasoning, tokens_cache_read, tokens_cache_write, agent, model,
			time_created, time_updated, summary_files, summary_additions, summary_deletions
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			session.sessionId,
			session.projectId,
			session.parentId ?? null,
			session.title ?? "Test session",
			session.cost ?? 0,
			session.tokensInput ?? 0,
			session.tokensOutput ?? 0,
			session.tokensReasoning ?? 0,
			session.tokensCacheRead ?? 0,
			session.tokensCacheWrite ?? 0,
			session.agent === undefined ? "build" : session.agent,
			session.model === undefined ? '{"id":"claude-opus-4-6"}' : session.model,
			session.timeCreated,
			session.timeUpdated,
			session.summaryFiles === undefined ? 0 : session.summaryFiles,
			session.summaryAdditions === undefined ? 0 : session.summaryAdditions,
			session.summaryDeletions === undefined ? 0 : session.summaryDeletions,
		],
	);

	const messages = session.messages ?? [
		{ type: "user", text: "implement the feature" },
		{ type: "assistant", content: [textPart("Done implementing the feature.")] },
	];

	messages.forEach((message, index) => {
		const messageId = `msg-${session.sessionId}-${index}`;
		const createdAt = session.timeCreated + index * 100;
		const data = message.malformed
			? "{not valid json"
			: JSON.stringify(buildV2MessageData(message, createdAt));

		db.run(
			`INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			[messageId, session.sessionId, message.type, index + 1, createdAt, createdAt, data],
		);

		for (const [ordinal, part] of (message.parts ?? []).entries()) {
			db.run(
				`INSERT INTO session_part (message_id, session_id, ordinal, type, call_id, time_created, time_updated, data)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					messageId,
					session.sessionId,
					ordinal,
					typeof part.type === "string" ? part.type : "text",
					null,
					createdAt,
					createdAt,
					JSON.stringify(part),
				],
			);
		}
	});
}

/** Run the backfill while suppressing its operator-facing console output. */
async function runQuietBackfill(
	args: Parameters<typeof runBackfill>[0],
): Promise<BackfillStats> {
	const logSpy = spyOn(console, "log").mockImplementation(() => {});
	const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
	const errorSpy = spyOn(console, "error").mockImplementation(() => {});
	try {
		return await runBackfill(args);
	} finally {
		logSpy.mockRestore();
		warnSpy.mockRestore();
		errorSpy.mockRestore();
	}
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("extractModelId", () => {
	it("extracts id from valid JSON object", () => {
		expect(extractModelId('{"id":"claude-opus-4-6"}')).toBe("claude-opus-4-6");
	});

	it("returns 'unknown' for null input", () => {
		expect(extractModelId(null)).toBe("unknown");
	});

	it("returns 'unknown' for malformed JSON", () => {
		expect(extractModelId("{not-valid-json}")).toBe("unknown");
	});

	it("returns string value when model is a plain string JSON", () => {
		expect(extractModelId('"claude-sonnet-4-20250514"')).toBe("claude-sonnet-4-20250514");
	});

	it("extracts modelID field when id is absent", () => {
		expect(extractModelId('{"modelID":"sonnet"}')).toBe("sonnet");
	});

	it("returns 'unknown' when id is a non-string value", () => {
		expect(extractModelId('{"id":123}')).toBe("unknown");
	});

	it("returns 'unknown' for empty string input", () => {
		expect(extractModelId("")).toBe("unknown");
	});

	it("prefers id over modelID when both are present", () => {
		expect(extractModelId('{"id":"primary","modelID":"secondary"}')).toBe("primary");
	});
});

describe("deriveProjectName", () => {
	it("returns name when present", () => {
		expect(deriveProjectName("my-project", "/path/to/worktree")).toBe("my-project");
	});

	it("falls back to basename of worktree when name is null", () => {
		expect(deriveProjectName(null, "/home/user/projects/my-repo")).toBe("my-repo");
	});

	it("returns 'unknown' when both name and worktree are null", () => {
		expect(deriveProjectName(null, null)).toBe("unknown");
	});

	it("returns name even if worktree is also provided", () => {
		expect(deriveProjectName("explicit-name", "/some/path/other")).toBe("explicit-name");
	});

	it("handles worktree with trailing slash", () => {
		// path.basename handles trailing slashes in some environments
		expect(deriveProjectName(null, "/path/to/project")).toBe("project");
	});
});

describe("parseDateToEpochMs", () => {
	it("parses YYYY-MM-DD as local midnight", () => {
		const ms = parseDateToEpochMs("2026-09-22");
		expect(ms).not.toBeNull();
		const d = new Date(ms as number);
		expect(d.getFullYear()).toBe(2026);
		expect(d.getMonth()).toBe(8); // 0-indexed
		expect(d.getDate()).toBe(22);
		expect(d.getHours()).toBe(0);
	});

	it("parses ISO-8601 datetime", () => {
		const ms = parseDateToEpochMs("2026-09-22T14:30:00Z");
		expect(ms).not.toBeNull();
		expect(ms).toBe(new Date("2026-09-22T14:30:00Z").getTime());
	});

	it("returns null for invalid date", () => {
		expect(parseDateToEpochMs("not-a-date")).toBeNull();
	});

	it("returns null for empty string", () => {
		expect(parseDateToEpochMs("")).toBeNull();
	});

	it("returns null for invalid YYYY-MM-DD format", () => {
		expect(parseDateToEpochMs("2026-13-45")).toBeNull();
	});
});

describe("validateSourceSchema", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(path.join(tmpdir(), "ocm-backfill-schema-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("does not throw when all required tables exist", () => {
		const dbPath = path.join(tempDir, "valid.db");
		const db = createSourceDb(dbPath);

		expect(() => validateSourceSchema(db)).not.toThrow();

		db.close();
	});

	it("throws with missing table names when schema is incomplete", () => {
		const dbPath = path.join(tempDir, "empty.db");
		const db = new Database(dbPath, { create: true });

		expect(() => validateSourceSchema(db)).toThrow(
			/missing required tables.*session.*message.*part.*project/,
		);

		db.close();
	});

	it("lists only the specific missing tables in the error", () => {
		const dbPath = path.join(tempDir, "partial.db");
		const db = new Database(dbPath, { create: true });
		// Create only session and project — message and part are missing.
		db.run("CREATE TABLE session (id TEXT PRIMARY KEY)");
		db.run("CREATE TABLE project (id TEXT PRIMARY KEY)");

		try {
			validateSourceSchema(db);
			// Should not reach here.
			expect(true).toBe(false);
		} catch (err) {
			const msg = (err as Error).message;
			expect(msg).toContain("message");
			expect(msg).toContain("part");
			expect(msg).not.toContain("session");
			expect(msg).not.toContain("project");
		}

		db.close();
	});
});

describe("end-to-end backfill", () => {
	let tempDir: string;
	let sourceDb: Database;
	let destDb: Database;

	beforeEach(() => {
		tempDir = mkdtempSync(path.join(tmpdir(), "ocm-backfill-e2e-"));

		// Create source database with test data.
		const sourcePath = path.join(tempDir, "source.db");
		sourceDb = createSourceDb(sourcePath);

		// Insert a project.
		insertProject(sourceDb, "proj-1", "test-project", "/home/user/test-project");

		// Insert 3 sessions with distinct characteristics.
		insertSessionWithData(sourceDb, {
			sessionId: "sess-1",
			projectId: "proj-1",
			cost: 0.15,
			tokensInput: 1000,
			tokensOutput: 500,
			tokensReasoning: 200,
			tokensCacheRead: 800,
			tokensCacheWrite: 100,
			agent: "build",
			model: '{"id":"claude-opus-4-6"}',
			title: "Implement feature A",
			timeCreated: 1700000000000,
			timeUpdated: 1700003600000,
			summaryFiles: 3,
			summaryAdditions: 50,
			summaryDeletions: 10,
			userMessage: "implement feature A",
		});

		insertSessionWithData(sourceDb, {
			sessionId: "sess-2",
			projectId: "proj-1",
			cost: 0.08,
			tokensInput: 500,
			tokensOutput: 300,
			agent: "explore",
			model: '{"id":"claude-sonnet-4-20250514"}',
			title: "Explore architecture",
			timeCreated: 1700010000000,
			timeUpdated: 1700012000000,
			userMessage: "explore the architecture",
		});

		insertSessionWithData(sourceDb, {
			sessionId: "sess-3",
			projectId: "proj-1",
			cost: 0.25,
			tokensInput: 2000,
			tokensOutput: 1000,
			tokensCacheRead: 1500,
			agent: "plan",
			model: '{"id":"claude-opus-4-6"}',
			title: "Plan refactoring",
			timeCreated: 1700020000000,
			timeUpdated: 1700025000000,
			userMessage: "plan the refactoring",
		});

		// Initialize destination database.
		const destDir = path.join(tempDir, "dest");
		const result = initDatabase(destDir);
		destDb = result.db;

		// Upsert the project into dest.
		upsertProject(destDb, {
			project_id: "proj-1",
			name: "test-project",
			worktree: "/home/user/test-project",
		});
	});

	afterEach(() => {
		sourceDb.close();
		destDb.close();
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("imports 3 sessions with 36 measurements (3 × 12 metrics)", () => {
		const config = loadConfig(path.join(tempDir, "dest"));

		// Fetch all sessions from source and backfill each one.
		const sessions = sourceDb.prepare("SELECT * FROM session ORDER BY time_created").all() as Array<{
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
		}>;

		for (const session of sessions) {
			backfillSession(sourceDb, destDb, session, config);
		}

		// Verify session count.
		const sessionCount = destDb
			.prepare("SELECT COUNT(*) AS cnt FROM sessions")
			.get() as { cnt: number };
		expect(sessionCount.cnt).toBe(3);

		// Verify measurement count: 3 sessions × 12 metrics = 36.
		const measurementCount = destDb
			.prepare("SELECT COUNT(*) AS cnt FROM measurements")
			.get() as { cnt: number };
		expect(measurementCount.cnt).toBe(36);
	});

	it("correctly classifies sessions based on agent", () => {
		const config = loadConfig(path.join(tempDir, "dest"));

		const sessions = sourceDb.prepare("SELECT * FROM session ORDER BY time_created").all() as Array<{
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
		}>;

		for (const session of sessions) {
			backfillSession(sourceDb, destDb, session, config);
		}

		// Check classification: build → implementation, explore → exploration, plan → planning.
		const classifications = destDb
			.prepare("SELECT session_id, classification FROM sessions ORDER BY session_id")
			.all() as Array<{ session_id: string; classification: string }>;

		const byId = Object.fromEntries(classifications.map((r) => [r.session_id, r.classification]));
		expect(byId["sess-1"]).toBe("implementation");
		expect(byId["sess-2"]).toBe("exploration");
		expect(byId["sess-3"]).toBe("planning");
	});

	it("computes derived metrics correctly", () => {
		const config = loadConfig(path.join(tempDir, "dest"));

		const session = sourceDb.prepare("SELECT * FROM session WHERE id = ?").get("sess-1") as {
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
		};

		backfillSession(sourceDb, destDb, session, config);

		// Check cache_hit_ratio: 800 / (800 + 1000) = 0.4444...
		const cacheRow = destDb
			.prepare(
				"SELECT value FROM measurements WHERE session_id = ? AND metric_name = ?",
			)
			.get("sess-1", "cache_hit_ratio") as { value: number };
		expect(cacheRow.value).toBeCloseTo(0.4444, 3);

		// Check duration_seconds: (1700003600000 - 1700000000000) / 1000 = 3600.
		const durationRow = destDb
			.prepare(
				"SELECT value FROM measurements WHERE session_id = ? AND metric_name = ?",
			)
			.get("sess-1", "duration_seconds") as { value: number };
		expect(durationRow.value).toBe(3600);

		// Check cost is stored correctly.
		const costRow = destDb
			.prepare(
				"SELECT value FROM measurements WHERE session_id = ? AND metric_name = ?",
			)
			.get("sess-1", "cost") as { value: number };
		expect(costRow.value).toBeCloseTo(0.15);

		// Check diff stats are stored.
		const filesRow = destDb
			.prepare(
				"SELECT value FROM measurements WHERE session_id = ? AND metric_name = ?",
			)
			.get("sess-1", "files_changed") as { value: number };
		expect(filesRow.value).toBe(3);

		const addedRow = destDb
			.prepare(
				"SELECT value FROM measurements WHERE session_id = ? AND metric_name = ?",
			)
			.get("sess-1", "lines_added") as { value: number };
		expect(addedRow.value).toBe(50);
	});

	it("extracts correct model ID from session data", () => {
		const config = loadConfig(path.join(tempDir, "dest"));

		const sessions = sourceDb.prepare("SELECT * FROM session ORDER BY time_created").all() as Array<{
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
		}>;

		for (const session of sessions) {
			backfillSession(sourceDb, destDb, session, config);
		}

		const models = destDb
			.prepare("SELECT session_id, model FROM sessions ORDER BY session_id")
			.all() as Array<{ session_id: string; model: string }>;

		const byId = Object.fromEntries(models.map((r) => [r.session_id, r.model]));
		expect(byId["sess-1"]).toBe("claude-opus-4-6");
		expect(byId["sess-2"]).toBe("claude-sonnet-4-20250514");
		expect(byId["sess-3"]).toBe("claude-opus-4-6");
	});
});

describe("idempotency", () => {
	let tempDir: string;
	let sourceDb: Database;
	let destDb: Database;

	beforeEach(() => {
		tempDir = mkdtempSync(path.join(tmpdir(), "ocm-backfill-idemp-"));

		const sourcePath = path.join(tempDir, "source.db");
		sourceDb = createSourceDb(sourcePath);

		insertProject(sourceDb, "proj-1", "test-project", "/home/user/test-project");
		insertSessionWithData(sourceDb, {
			sessionId: "sess-1",
			projectId: "proj-1",
			cost: 0.15,
			tokensInput: 1000,
			tokensOutput: 500,
			agent: "build",
			model: '{"id":"claude-opus-4-6"}',
			title: "Implement feature",
			timeCreated: 1700000000000,
			timeUpdated: 1700003600000,
		});
		insertSessionWithData(sourceDb, {
			sessionId: "sess-2",
			projectId: "proj-1",
			cost: 0.10,
			tokensInput: 800,
			tokensOutput: 400,
			agent: "explore",
			model: '{"id":"claude-sonnet-4-20250514"}',
			title: "Explore code",
			timeCreated: 1700010000000,
			timeUpdated: 1700012000000,
		});

		const destDir = path.join(tempDir, "dest");
		const result = initDatabase(destDir);
		destDb = result.db;

		upsertProject(destDb, {
			project_id: "proj-1",
			name: "test-project",
			worktree: "/home/user/test-project",
		});
	});

	afterEach(() => {
		sourceDb.close();
		destDb.close();
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("produces the same counts when run twice on the same data", () => {
		const config = loadConfig(path.join(tempDir, "dest"));

		const sessions = sourceDb.prepare("SELECT * FROM session").all() as Array<{
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
		}>;

		// First run.
		for (const session of sessions) {
			backfillSession(sourceDb, destDb, session, config);
		}

		const sessionsAfterFirst = destDb
			.prepare("SELECT COUNT(*) AS cnt FROM sessions")
			.get() as { cnt: number };
		const metricsAfterFirst = destDb
			.prepare("SELECT COUNT(*) AS cnt FROM measurements")
			.get() as { cnt: number };

		// Second run — same data, same function calls.
		for (const session of sessions) {
			backfillSession(sourceDb, destDb, session, config);
		}

		const sessionsAfterSecond = destDb
			.prepare("SELECT COUNT(*) AS cnt FROM sessions")
			.get() as { cnt: number };
		const metricsAfterSecond = destDb
			.prepare("SELECT COUNT(*) AS cnt FROM measurements")
			.get() as { cnt: number };

		// Counts must be identical — UPSERT semantics prevent duplicates.
		expect(sessionsAfterSecond.cnt).toBe(sessionsAfterFirst.cnt);
		expect(metricsAfterSecond.cnt).toBe(metricsAfterFirst.cnt);

		// Verify exact expected counts.
		expect(sessionsAfterSecond.cnt).toBe(2);
		expect(metricsAfterSecond.cnt).toBe(24); // 2 sessions × 12 metrics
	});

	it("preserves metric values after idempotent re-run", () => {
		const config = loadConfig(path.join(tempDir, "dest"));

		const sessions = sourceDb.prepare("SELECT * FROM session").all() as Array<{
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
		}>;

		// Run twice.
		for (const session of sessions) {
			backfillSession(sourceDb, destDb, session, config);
		}
		for (const session of sessions) {
			backfillSession(sourceDb, destDb, session, config);
		}

		// Verify values are correct (not doubled).
		const costRow = destDb
			.prepare(
				"SELECT value FROM measurements WHERE session_id = ? AND metric_name = ?",
			)
			.get("sess-1", "cost") as { value: number };
		expect(costRow.value).toBeCloseTo(0.15);
	});
});

describe("--with-deltas behavior", () => {
	let tempDir: string;
	let sourceDb: Database;
	let destDb: Database;

	beforeEach(() => {
		tempDir = mkdtempSync(path.join(tmpdir(), "ocm-backfill-deltas-"));

		const sourcePath = path.join(tempDir, "source.db");
		sourceDb = createSourceDb(sourcePath);

		insertProject(sourceDb, "proj-1", "test-project", "/home/user/test-project");
		insertSessionWithData(sourceDb, {
			sessionId: "sess-1",
			projectId: "proj-1",
			cost: 0.50,
			tokensInput: 2000,
			tokensOutput: 1000,
			agent: "build",
			model: '{"id":"claude-opus-4-6"}',
			title: "Implement feature",
			timeCreated: 1700000000000,
			timeUpdated: 1700003600000,
		});

		const destDir = path.join(tempDir, "dest");
		const result = initDatabase(destDir);
		destDb = result.db;

		upsertProject(destDb, {
			project_id: "proj-1",
			name: "test-project",
			worktree: "/home/user/test-project",
		});
	});

	afterEach(() => {
		sourceDb.close();
		destDb.close();
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("skips deltas by default (withDeltas=false)", () => {
		const config = loadConfig(path.join(tempDir, "dest"));

		const session = sourceDb.prepare("SELECT * FROM session WHERE id = ?").get("sess-1") as {
			id: string; project_id: string; cost: number;
			tokens_input: number; tokens_output: number;
			tokens_reasoning: number; tokens_cache_read: number;
			tokens_cache_write: number; agent: string | null;
			model: string | null; title: string | null;
			time_created: number; time_updated: number;
			summary_files: number | null; summary_additions: number | null;
			summary_deletions: number | null;
		};

		backfillSession(sourceDb, destDb, session, config, false);

		// Cumulative measurements must exist.
		const measurements = destDb
			.prepare("SELECT COUNT(*) AS cnt FROM measurements WHERE session_id = ?")
			.get("sess-1") as { cnt: number };
		expect(measurements.cnt).toBe(12);

		// No deltas should be written.
		const deltas = destDb
			.prepare("SELECT COUNT(*) AS cnt FROM measurement_deltas WHERE session_id = ?")
			.get("sess-1") as { cnt: number };
		expect(deltas.cnt).toBe(0);
	});

	it("writes deltas when withDeltas=true", () => {
		const config = loadConfig(path.join(tempDir, "dest"));

		const session = sourceDb.prepare("SELECT * FROM session WHERE id = ?").get("sess-1") as {
			id: string; project_id: string; cost: number;
			tokens_input: number; tokens_output: number;
			tokens_reasoning: number; tokens_cache_read: number;
			tokens_cache_write: number; agent: string | null;
			model: string | null; title: string | null;
			time_created: number; time_updated: number;
			summary_files: number | null; summary_additions: number | null;
			summary_deletions: number | null;
		};

		backfillSession(sourceDb, destDb, session, config, true);

		// Cumulative measurements must exist.
		const measurements = destDb
			.prepare("SELECT COUNT(*) AS cnt FROM measurements WHERE session_id = ?")
			.get("sess-1") as { cnt: number };
		expect(measurements.cnt).toBe(12);

		// Deltas should be written for non-zero metrics.
		const deltas = destDb
			.prepare("SELECT COUNT(*) AS cnt FROM measurement_deltas WHERE session_id = ?")
			.get("sess-1") as { cnt: number };
		expect(deltas.cnt).toBeGreaterThan(0);

		// Cost delta should equal the cumulative cost (first write, no previous value).
		const costDelta = destDb
			.prepare(
				"SELECT delta FROM measurement_deltas WHERE session_id = ? AND metric_name = ?",
			)
			.get("sess-1", "cost") as { delta: number };
		expect(costDelta.delta).toBeCloseTo(0.50);
	});

	it("writes catch-up deltas on re-run after initial backfill without deltas", () => {
		const config = loadConfig(path.join(tempDir, "dest"));

		const session = sourceDb.prepare("SELECT * FROM session WHERE id = ?").get("sess-1") as {
			id: string; project_id: string; cost: number;
			tokens_input: number; tokens_output: number;
			tokens_reasoning: number; tokens_cache_read: number;
			tokens_cache_write: number; agent: string | null;
			model: string | null; title: string | null;
			time_created: number; time_updated: number;
			summary_files: number | null; summary_additions: number | null;
			summary_deletions: number | null;
		};

		// First run without deltas (simulates initial backfill).
		backfillSession(sourceDb, destDb, session, config, false);

		// Confirm no deltas exist after first run.
		const beforeDeltas = destDb
			.prepare("SELECT COUNT(*) AS cnt FROM measurement_deltas WHERE session_id = ?")
			.get("sess-1") as { cnt: number };
		expect(beforeDeltas.cnt).toBe(0);

		// Second run with deltas — catch-up mechanism should detect the
		// missing deltas and write them using the cumulative values.
		const recordedAt = session.time_updated || session.time_created || Date.now();
		const metrics = [
			{ metric_name: "cost", value: session.cost ?? 0, recorded_at: recordedAt },
			{ metric_name: "tokens_input", value: session.tokens_input ?? 0, recorded_at: recordedAt },
			{ metric_name: "tokens_output", value: session.tokens_output ?? 0, recorded_at: recordedAt },
		];
		backfillMissingDeltas(destDb, session.id, metrics);

		const afterDeltas = destDb
			.prepare("SELECT COUNT(*) AS cnt FROM measurement_deltas WHERE session_id = ?")
			.get("sess-1") as { cnt: number };
		expect(afterDeltas.cnt).toBeGreaterThan(0);

		// Cost delta should equal cumulative (catch-up from zero).
		const costDelta = destDb
			.prepare(
				"SELECT delta FROM measurement_deltas WHERE session_id = ? AND metric_name = ?",
			)
			.get("sess-1", "cost") as { delta: number };
		expect(costDelta.delta).toBeCloseTo(0.50);
	});

	it("does not duplicate deltas on repeated catch-up runs", () => {
		const config = loadConfig(path.join(tempDir, "dest"));

		const session = sourceDb.prepare("SELECT * FROM session WHERE id = ?").get("sess-1") as {
			id: string; project_id: string; cost: number;
			tokens_input: number; tokens_output: number;
			tokens_reasoning: number; tokens_cache_read: number;
			tokens_cache_write: number; agent: string | null;
			model: string | null; title: string | null;
			time_created: number; time_updated: number;
			summary_files: number | null; summary_additions: number | null;
			summary_deletions: number | null;
		};

		// First backfill without deltas, then catch-up twice.
		backfillSession(sourceDb, destDb, session, config, false);

		const recordedAt = session.time_updated || session.time_created || Date.now();
		const metrics = [
			{ metric_name: "cost", value: session.cost ?? 0, recorded_at: recordedAt },
		];
		backfillMissingDeltas(destDb, session.id, metrics);
		backfillMissingDeltas(destDb, session.id, metrics);

		// Should still be exactly 1 delta row for cost (INSERT OR IGNORE on same PK).
		const deltaCount = destDb
			.prepare(
				"SELECT COUNT(*) AS cnt FROM measurement_deltas WHERE session_id = ? AND metric_name = ?",
			)
			.get("sess-1", "cost") as { cnt: number };
		expect(deltaCount.cnt).toBe(1);

		// SUM(deltas) should equal the cumulative value.
		const sumRow = destDb
			.prepare(
				"SELECT SUM(delta) AS total FROM measurement_deltas WHERE session_id = ? AND metric_name = ?",
			)
			.get("sess-1", "cost") as { total: number };
		expect(sumRow.total).toBeCloseTo(0.50);
	});

	it("tops up partial deltas when live deltas cover less than cumulative", () => {
		const config = loadConfig(path.join(tempDir, "dest"));

		const session = sourceDb.prepare("SELECT * FROM session WHERE id = ?").get("sess-1") as {
			id: string; project_id: string; cost: number;
			tokens_input: number; tokens_output: number;
			tokens_reasoning: number; tokens_cache_read: number;
			tokens_cache_write: number; agent: string | null;
			model: string | null; title: string | null;
			time_created: number; time_updated: number;
			summary_files: number | null; summary_additions: number | null;
			summary_deletions: number | null;
		};

		// First backfill without deltas.
		backfillSession(sourceDb, destDb, session, config, false);

		// Simulate a live delta that covers only part of the cost.
		destDb.run(
			"INSERT INTO measurement_deltas (session_id, metric_name, delta, recorded_at) VALUES (?, ?, ?, ?)",
			["sess-1", "cost", 0.20, session.time_updated - 1000],
		);

		// Catch-up should insert a top-up delta for the remaining gap.
		const recordedAt = session.time_updated || session.time_created || Date.now();
		backfillMissingDeltas(destDb, session.id, [
			{ metric_name: "cost", value: session.cost ?? 0, recorded_at: recordedAt },
		]);

		// SUM(deltas) should now equal cumulative (0.20 + 0.30 = 0.50).
		const sumRow = destDb
			.prepare(
				"SELECT SUM(delta) AS total FROM measurement_deltas WHERE session_id = ? AND metric_name = ?",
			)
			.get("sess-1", "cost") as { total: number };
		expect(sumRow.total).toBeCloseTo(0.50);
	});
});

// ---------------------------------------------------------------------------
// V2 source layout detection
// ---------------------------------------------------------------------------

describe("source layout detection", () => {
	let tempDir: string;
	let db: Database | null = null;

	beforeEach(() => {
		tempDir = mkdtempSync(path.join(tmpdir(), "ocm-backfill-detect-"));
	});

	afterEach(() => {
		db?.close();
		db = null;
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("detects a complete V2 layout", () => {
		db = createV2SourceDb(path.join(tempDir, "v2.db"));
		expect(detectSourceLayout(db)).toBe("v2");
		expect(createSourceReader(db).layout).toBe("v2");
	});

	it("detects a complete legacy layout", () => {
		db = createSourceDb(path.join(tempDir, "legacy.db"));
		expect(detectSourceLayout(db)).toBe("legacy");
		expect(createSourceReader(db).layout).toBe("legacy");
	});

	it("names every missing V2 table in a partial layout", () => {
		for (const table of ["session_v2", "session_message", "session_part"]) {
			const partialPath = path.join(tempDir, `${table}.db`);
			const partial = createV2SourceDb(partialPath);
			partial.run(`DROP TABLE ${table}`);

			let error: unknown;
			try {
				detectSourceLayout(partial);
			} catch (err) {
				error = err;
			}

			expect(error).toBeInstanceOf(SourceSchemaError);
			expect((error as Error).message).toContain(table);
			for (const present of ["session_v2", "session_message", "session_part"]) {
				if (present !== table) {
					expect((error as Error).message).not.toContain(present);
				}
			}

			partial.close();
		}
	});

	it("rejects a database with neither layout", () => {
		db = new Database(path.join(tempDir, "empty.db"), { create: true });
		expect(() => detectSourceLayout(db as Database)).toThrow(SourceSchemaError);
		expect(() => detectSourceLayout(db as Database)).toThrow(
			/does not appear to be an OpenCode database/,
		);
	});
});

// ---------------------------------------------------------------------------
// V2 session reader
// ---------------------------------------------------------------------------

describe("V2 session reader", () => {
	let tempDir: string;
	let db: Database | null = null;

	beforeEach(() => {
		tempDir = mkdtempSync(path.join(tmpdir(), "ocm-backfill-v2-sessions-"));
		db = createV2SourceDb(path.join(tempDir, "source.db"));
		insertProject(db, "proj-1", "test-project", "/home/user/test-project");
		insertProject(db, "proj-2", null, "/home/user/other-project");

		insertV2Session(db, {
			sessionId: "s-root",
			projectId: "proj-1",
			cost: 0.1,
			tokensInput: 1000,
			tokensOutput: 500,
			tokensCacheRead: 300,
			timeCreated: 1000,
			timeUpdated: 2000,
			summaryFiles: 2,
			summaryAdditions: 10,
			summaryDeletions: 3,
		});
		insertV2Session(db, {
			sessionId: "b-session",
			projectId: "proj-2",
			timeCreated: 2000,
			timeUpdated: 2500,
		});
		insertV2Session(db, {
			sessionId: "a-session",
			projectId: "proj-1",
			timeCreated: 2000,
			timeUpdated: 2600,
		});
		insertV2Session(db, {
			sessionId: "s-late",
			projectId: "proj-1",
			parentId: "s-root",
			cost: 0.3,
			timeCreated: 3000,
			timeUpdated: 4000,
			summaryFiles: null,
			summaryAdditions: null,
			summaryDeletions: null,
		});
	});

	afterEach(() => {
		db?.close();
		db = null;
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("lists projects", () => {
		const source = createSourceReader(db as Database);
		const projects = source.listProjects();
		expect(projects).toHaveLength(2);
		expect(projects.find((project) => project.id === "proj-1")?.name).toBe("test-project");
	});

	it("counts sessions with and without --since", () => {
		const source = createSourceReader(db as Database);
		expect(source.countSessions(null)).toBe(4);
		expect(source.countSessions(2000)).toBe(3);
	});

	it("orders by time_created then id", () => {
		const source = createSourceReader(db as Database);
		const sessions = source.listSessions(null, 10, 0);
		expect(sessions.map((session) => session.id)).toEqual([
			"s-root",
			"a-session",
			"b-session",
			"s-late",
		]);
	});

	it("honours limit and offset", () => {
		const source = createSourceReader(db as Database);
		const sessions = source.listSessions(null, 2, 1);
		expect(sessions.map((session) => session.id)).toEqual(["a-session", "b-session"]);
	});

	it("filters sessions by time_created", () => {
		const source = createSourceReader(db as Database);
		const sessions = source.listSessions(2000, 10, 0);
		expect(sessions.map((session) => session.id)).toEqual(["a-session", "b-session", "s-late"]);
	});

	it("returns aggregates and preserves NULL summaries", () => {
		const source = createSourceReader(db as Database);
		const sessions = source.listSessions(null, 10, 0);
		const root = sessions.find((session) => session.id === "s-root");
		const late = sessions.find((session) => session.id === "s-late");

		expect(root?.cost).toBeCloseTo(0.1);
		expect(root?.tokens_input).toBe(1000);
		expect(root?.tokens_cache_read).toBe(300);
		expect(root?.summary_files).toBe(2);
		expect(root?.parent_id).toBeNull();

		expect(late?.summary_files).toBeNull();
		expect(late?.summary_additions).toBeNull();
		expect(late?.summary_deletions).toBeNull();
		expect(late?.parent_id).toBe("s-root");
		expect(late?.cost).toBeCloseTo(0.3);
	});
});

// ---------------------------------------------------------------------------
// V2 messages, parts, and tools
// ---------------------------------------------------------------------------

function createV2ReaderFor(tempDir: string, session: V2SessionFixture): {
	db: Database;
	reader: ReturnType<typeof createSourceReader>;
} {
	const db = createV2SourceDb(path.join(tempDir, "source.db"));
	insertV2Session(db, session);
	return { db, reader: createSourceReader(db) };
}

describe("V2 conversation messages", () => {
	let tempDir: string;
	let db: Database | null = null;

	beforeEach(() => {
		tempDir = mkdtempSync(path.join(tmpdir(), "ocm-backfill-v2-messages-"));
	});

	afterEach(() => {
		db?.close();
		db = null;
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("counts only user and assistant messages", () => {
		const created = createV2ReaderFor(tempDir, {
			sessionId: "s1",
			projectId: "proj-1",
			timeCreated: 1000,
			timeUpdated: 2000,
			messages: [
				{ type: "user", text: "hello" },
				{ type: "system", text: "ignored system" },
				{ type: "synthetic", text: "ignored synthetic" },
				{ type: "agent-switched", text: "ignored switch" },
				{ type: "model-switched", text: "ignored switch" },
				{ type: "compaction", text: "ignored compaction" },
				{ type: "idle", text: "ignored idle" },
				{ type: "assistant", content: [textPart("hi")] },
			],
		});
		db = created.db;

		expect(created.reader.getMessageCount("s1")).toBe(2);
		expect(created.reader.getFirstUserMessage("s1")).toBe("hello");
		expect(created.reader.getConversationText("s1")).toBe("hello\nhi");
	});

	it("returns an empty first message when user text is empty", () => {
		const created = createV2ReaderFor(tempDir, {
			sessionId: "s1",
			projectId: "proj-1",
			timeCreated: 1000,
			timeUpdated: 2000,
			messages: [{ type: "user", text: "" }],
		});
		db = created.db;

		expect(created.reader.getFirstUserMessage("s1")).toBe("");
	});

	it("skips malformed message JSON without throwing", () => {
		const created = createV2ReaderFor(tempDir, {
			sessionId: "s1",
			projectId: "proj-1",
			timeCreated: 1000,
			timeUpdated: 2000,
			messages: [
				{ type: "user", malformed: true },
				{ type: "assistant", content: [textPart("still readable")] },
			],
		});
		db = created.db;

		expect(created.reader.getMessageCount("s1")).toBe(2);
		expect(created.reader.getFirstUserMessage("s1")).toBe("");
		expect(created.reader.getConversationText("s1")).toBe("still readable");
	});
});

describe("V2 message parts", () => {
	let tempDir: string;
	let db: Database | null = null;

	beforeEach(() => {
		tempDir = mkdtempSync(path.join(tmpdir(), "ocm-backfill-v2-parts-"));
	});

	afterEach(() => {
		db?.close();
		db = null;
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("reads user text and assistant content embedded in message data", () => {
		const created = createV2ReaderFor(tempDir, {
			sessionId: "s1",
			projectId: "proj-1",
			timeCreated: 1000,
			timeUpdated: 2000,
			messages: [
				{ type: "user", text: "embedded question" },
				{ type: "assistant", content: [textPart("embedded answer")] },
			],
		});
		db = created.db;

		expect(created.reader.getFirstUserMessage("s1")).toBe("embedded question");
		expect(created.reader.getConversationText("s1")).toBe("embedded question\nembedded answer");
	});

	it("prefers session_part rows over embedded content, in ordinal order", () => {
		const created = createV2ReaderFor(tempDir, {
			sessionId: "s1",
			projectId: "proj-1",
			timeCreated: 1000,
			timeUpdated: 2000,
			messages: [
				{ type: "user", text: "from data", parts: [textPart("from part")] },
				{
					type: "assistant",
					content: [textPart("embedded answer")],
					parts: [textPart("part answer one"), textPart("part answer two")],
				},
			],
		});
		db = created.db;

		expect(created.reader.getFirstUserMessage("s1")).toBe("from part");
		expect(created.reader.getConversationText("s1")).toBe(
			"from part\npart answer one\npart answer two",
		);
	});

	it("falls back to embedded content when no part rows exist", () => {
		const created = createV2ReaderFor(tempDir, {
			sessionId: "s1",
			projectId: "proj-1",
			timeCreated: 1000,
			timeUpdated: 2000,
			messages: [
				{ type: "user", text: "question", parts: [] },
				{ type: "assistant", content: [textPart("embedded answer")], parts: [] },
			],
		});
		db = created.db;

		expect(created.reader.getConversationText("s1")).toBe("question\nembedded answer");
	});

	it("excludes reasoning parts from conversation text", () => {
		const created = createV2ReaderFor(tempDir, {
			sessionId: "s1",
			projectId: "proj-1",
			timeCreated: 1000,
			timeUpdated: 2000,
			messages: [
				{ type: "user", text: "question" },
				{ type: "assistant", content: [reasoningPart("secret"), textPart("visible")] },
			],
		});
		db = created.db;

		expect(created.reader.getConversationText("s1")).toBe("question\nvisible");
	});
});

describe("V2 tool parts", () => {
	let tempDir: string;
	let db: Database | null = null;

	beforeEach(() => {
		tempDir = mkdtempSync(path.join(tmpdir(), "ocm-backfill-v2-tools-"));
	});

	afterEach(() => {
		db?.close();
		db = null;
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("extracts bash and shell calls and flattens completed output", () => {
		const created = createV2ReaderFor(tempDir, {
			sessionId: "s1",
			projectId: "proj-1",
			timeCreated: 1000,
			timeUpdated: 2000,
			messages: [
				{ type: "user", text: "run things" },
				{
					type: "assistant",
					content: [
						toolPart("bash", {
							command: "gh pr create --fill",
							output: ["https://github.com/acme/widgets/pull/7", "done"],
						}),
						toolPart("shell", {
							command: "ls -la",
							status: "running",
							output: ["partial"],
						}),
						toolPart("Bash", {
							command: "git status",
							status: "error",
							output: ["boom"],
						}),
						toolPart("read", { command: "ignored" }),
						toolPart("bash", {}),
					],
				},
			],
		});
		db = created.db;

		const calls = created.reader.getBashToolCalls("s1");
		expect(calls).toHaveLength(3);
		expect(calls[0]).toEqual({
			command: "gh pr create --fill",
			output: "https://github.com/acme/widgets/pull/7\ndone",
		});
		expect(calls[1]).toEqual({ command: "ls -la", output: undefined });
		expect(calls[2]).toEqual({ command: "git status", output: undefined });
		expect(created.reader.getBashCommands("s1")).toEqual([
			"gh pr create --fill",
			"ls -la",
			"git status",
		]);
	});

	it("keeps only text entries when flattening tool output", () => {
		const created = createV2ReaderFor(tempDir, {
			sessionId: "s1",
			projectId: "proj-1",
			timeCreated: 1000,
			timeUpdated: 2000,
			messages: [
				{ type: "user", text: "run" },
				{
					type: "assistant",
					content: [
						toolPart("shell", {
							command: "echo hi",
							output: ["line one"],
							extraContent: [{ type: "image", data: "ignored" }],
						}),
					],
				},
			],
		});
		db = created.db;

		expect(created.reader.getBashToolCalls("s1")).toEqual([
			{ command: "echo hi", output: "line one" },
		]);
	});

	it("reads tool parts from session_part rows", () => {
		const created = createV2ReaderFor(tempDir, {
			sessionId: "s1",
			projectId: "proj-1",
			timeCreated: 1000,
			timeUpdated: 2000,
			messages: [
				{ type: "user", text: "run" },
				{
					type: "assistant",
					content: [],
					parts: [toolPart("shell", { command: "pwd", output: ["/tmp"] })],
				},
			],
		});
		db = created.db;

		expect(created.reader.getBashToolCalls("s1")).toEqual([
			{ command: "pwd", output: "/tmp" },
		]);
	});
});

// ---------------------------------------------------------------------------
// V2 provenance and parent links
// ---------------------------------------------------------------------------

describe("V2 provenance and parent links", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(path.join(tmpdir(), "ocm-backfill-v2-prov-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("resolves agent and model from session, message, and fallback labels", async () => {
		const sourcePath = path.join(tempDir, "source.db");
		const destDir = path.join(tempDir, "dest");
		const db = createV2SourceDb(sourcePath);

		insertProject(db, "proj-1", "test-project", "/home/user/test-project");
		insertV2Session(db, {
			sessionId: "sess-session",
			projectId: "proj-1",
			agent: "plan",
			model: '{"id":"session-model"}',
			timeCreated: 1000,
			timeUpdated: 2000,
			messages: [
				{ type: "user", text: "question" },
				{ type: "assistant", agent: "message-agent", modelId: "message-model" },
			],
		});
		insertV2Session(db, {
			sessionId: "sess-message",
			projectId: "proj-1",
			agent: null,
			model: null,
			timeCreated: 3000,
			timeUpdated: 4000,
			messages: [
				{ type: "user", text: "question" },
				{ type: "assistant", agent: "message-agent", modelId: "message-model" },
			],
		});
		insertV2Session(db, {
			sessionId: "sess-empty",
			projectId: "proj-1",
			agent: null,
			model: null,
			timeCreated: 5000,
			timeUpdated: 6000,
			messages: [],
		});
		insertV2Session(db, {
			sessionId: "sess-unknown",
			projectId: "proj-1",
			agent: null,
			model: null,
			timeCreated: 7000,
			timeUpdated: 8000,
			messages: [{ type: "user", text: "question" }],
		});
		insertV2Session(db, {
			sessionId: "sess-child",
			projectId: "proj-1",
			parentId: "sess-session",
			timeCreated: 9000,
			timeUpdated: 10000,
		});
		db.close();

		await runQuietBackfill({
			source: sourcePath,
			dest: destDir,
			dryRun: false,
			withDeltas: false,
			since: null,
			help: false,
		});

		const dest = new Database(path.join(destDir, "metrics.db"), { readonly: true });
		try {
			const rows = dest
				.prepare("SELECT session_id, agent, model, parent_session_id FROM sessions")
				.all() as Array<{
				session_id: string;
				agent: string;
				model: string;
				parent_session_id: string | null;
			}>;
			const byId = Object.fromEntries(rows.map((row) => [row.session_id, row]));

			expect(byId["sess-session"].agent).toBe("plan");
			expect(byId["sess-session"].model).toBe("session-model");
			expect(byId["sess-message"].agent).toBe("message-agent");
			expect(byId["sess-message"].model).toBe("message-model");
			expect(byId["sess-empty"].agent).toBe("empty-session");
			expect(byId["sess-empty"].model).toBe("empty-session");
			expect(byId["sess-unknown"].agent).toBe("unknown");
			expect(byId["sess-unknown"].model).toBe("unknown");
			expect(byId["sess-child"].parent_session_id).toBe("sess-session");
			expect(byId["sess-session"].parent_session_id).toBeNull();
		} finally {
			dest.close();
		}
	});
});

// ---------------------------------------------------------------------------
// V2 end-to-end backfill
// ---------------------------------------------------------------------------

describe("V2 end-to-end backfill", () => {
	let tempDir: string;
	let sourcePath: string;
	let destDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(path.join(tmpdir(), "ocm-backfill-v2-e2e-"));
		sourcePath = path.join(tempDir, "source.db");
		destDir = path.join(tempDir, "dest");
		mkdirSync(destDir, { recursive: true });

		const db = createV2SourceDb(sourcePath);
		insertProject(db, "proj-1", "test-project", "/home/user/test-project");

		insertV2Session(db, {
			sessionId: "sess-1",
			projectId: "proj-1",
			cost: 0.15,
			tokensInput: 1000,
			tokensOutput: 500,
			tokensReasoning: 200,
			tokensCacheRead: 800,
			tokensCacheWrite: 100,
			agent: "build",
			model: '{"id":"claude-opus-4-6"}',
			title: "Implement feature",
			timeCreated: 1700000000000,
			timeUpdated: 1700003600000,
			summaryFiles: 3,
			summaryAdditions: 50,
			summaryDeletions: 10,
			messages: [
				{ type: "user", text: "implement feature A" },
				{
					type: "assistant",
					content: [
						textPart("Implemented feature A."),
						toolPart("bash", {
							command: "gh pr create --fill",
							output: ["https://github.com/acme/widgets/pull/42"],
						}),
					],
					tokens: { input: 1000, cache: { read: 400, write: 100 } },
					timeStreamed: 1700000000500,
					timeCompleted: 1700000001500,
				},
				{ type: "compaction" },
			],
		});

		insertV2Session(db, {
			sessionId: "sess-2",
			projectId: "proj-1",
			cost: 0.05,
			tokensInput: 200,
			tokensOutput: 100,
			agent: null,
			model: null,
			timeCreated: 1700010000000,
			timeUpdated: 1700011000000,
			summaryFiles: null,
			summaryAdditions: null,
			summaryDeletions: null,
			messages: [],
		});

		insertV2Session(db, {
			sessionId: "sess-child",
			projectId: "proj-1",
			parentId: "sess-1",
			agent: "explore",
			model: '{"id":"claude-sonnet-4-20250514"}',
			timeCreated: 1700020000000,
			timeUpdated: 1700021000000,
			messages: [{ type: "user", text: "explore the code" }],
		});
		db.close();

		writeFileSync(
			path.join(destDir, "config.yaml"),
			[
				"budget_rules:",
				"  - budget_tag: build-work",
				"    conditions:",
				"      - field: agent",
				'        values: ["build"]',
				"",
			].join("\n"),
		);
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("imports sessions, projects, measurements, artifacts, classifications, and budget tags", async () => {
		const stats = await runQuietBackfill({
			source: sourcePath,
			dest: destDir,
			dryRun: false,
			withDeltas: false,
			since: null,
			help: false,
		});

		expect(stats.layout).toBe("v2");
		expect(stats.totalSessions).toBe(3);
		expect(stats.totalCost).toBeCloseTo(0.2);

		const dest = new Database(path.join(destDir, "metrics.db"), { readonly: true });
		try {
			const sessions = dest
				.prepare(
					"SELECT session_id, agent, model, classification, budget_tag, parent_session_id FROM sessions",
				)
				.all() as Array<{
				session_id: string;
				agent: string;
				model: string;
				classification: string;
				budget_tag: string | null;
				parent_session_id: string | null;
			}>;
			const byId = Object.fromEntries(sessions.map((row) => [row.session_id, row]));

			expect(sessions).toHaveLength(3);
			expect(byId["sess-1"].model).toBe("claude-opus-4-6");
			expect(byId["sess-1"].classification).toBe("pr-creation");
			expect(byId["sess-1"].budget_tag).toBe("build-work");
			expect(byId["sess-child"].classification).toBe("exploration");
			expect(byId["sess-child"].parent_session_id).toBe("sess-1");
			expect(byId["sess-2"].agent).toBe("empty-session");
			expect(byId["sess-2"].budget_tag).toBeNull();

			const projects = dest
				.prepare("SELECT project_id, name FROM projects")
				.all() as Array<{ project_id: string; name: string }>;
			expect(projects).toEqual([{ project_id: "proj-1", name: "test-project" }]);

			const measurementCount = dest
				.prepare("SELECT COUNT(*) AS cnt FROM measurements")
				.get() as { cnt: number };
			expect(measurementCount.cnt).toBe(65); // 21 metrics each + 2 timed-generation metrics for sess-1

			const artifacts = dest
				.prepare("SELECT artifact_type, reference FROM session_artifacts")
				.all();
			expect(artifacts).toEqual([
				{ artifact_type: "pr-created", reference: "acme/widgets#42" },
			]);

			const messagesTotal = dest
				.prepare(
					"SELECT value FROM measurements WHERE session_id = ? AND metric_name = 'messages_total'",
				)
				.get("sess-1") as { value: number };
			expect(messagesTotal.value).toBe(2);
		} finally {
			dest.close();
		}
	});

	it("records NULL summaries as 0 and counts them", async () => {
		const stats = await runQuietBackfill({
			source: sourcePath,
			dest: destDir,
			dryRun: false,
			withDeltas: false,
			since: null,
			help: false,
		});

		expect(stats.missingSummary).toBe(1);

		const dest = new Database(path.join(destDir, "metrics.db"), { readonly: true });
		try {
			const read = (sessionId: string, metric: string): number => {
				const row = dest
					.prepare(
						"SELECT value FROM measurements WHERE session_id = ? AND metric_name = ?",
					)
					.get(sessionId, metric) as { value: number };
				return row.value;
			};

			expect(read("sess-1", "files_changed")).toBe(3);
			expect(read("sess-1", "lines_added")).toBe(50);
			expect(read("sess-1", "lines_deleted")).toBe(10);
			expect(read("sess-2", "files_changed")).toBe(0);
			expect(read("sess-2", "lines_added")).toBe(0);
			expect(read("sess-2", "lines_deleted")).toBe(0);
		} finally {
			dest.close();
		}
	});

	it("derives flow metrics and child counts from persisted history", async () => {
		await runQuietBackfill({
			source: sourcePath,
			dest: destDir,
			dryRun: false,
			withDeltas: false,
			since: null,
			help: false,
		});

		const dest = new Database(path.join(destDir, "metrics.db"), { readonly: true });
		try {
			const read = (sessionId: string, metric: string): number | null => {
				const row = dest
					.prepare(
						"SELECT value FROM measurements WHERE session_id = ? AND metric_name = ?",
					)
					.get(sessionId, metric) as { value: number } | null;
				return row?.value ?? null;
			};

			// One assistant turn with 1000 input + 400 cache-read + 100
			// cache-write tokens; generated for 400 ms and completed after
			// another 1000 ms.
			expect(read("sess-1", "turns_total")).toBe(1);
			expect(read("sess-1", "context_tokens_final")).toBe(1500);
			expect(read("sess-1", "context_tokens_max")).toBe(1500);
			expect(read("sess-1", "generation_seconds")).toBeCloseTo(0.4);
			expect(read("sess-1", "post_generation_seconds")).toBeCloseTo(1.0);
			expect(read("sess-1", "compactions")).toBe(1);

			// Child counts are computed after every session is stored.
			expect(read("sess-1", "child_sessions")).toBe(1);
			expect(read("sess-child", "child_sessions")).toBe(0);
			expect(read("sess-2", "child_sessions")).toBe(0);
			expect(read("sess-2", "turns_total")).toBe(0);
		} finally {
			dest.close();
		}
	});

	it("is idempotent on a V2 source", async () => {
		const args = {
			source: sourcePath,
			dest: destDir,
			dryRun: false,
			withDeltas: false,
			since: null,
			help: false,
		};
		await runQuietBackfill(args);

		const first = new Database(path.join(destDir, "metrics.db"), { readonly: true });
		const firstCounts = {
			sessions: (first.prepare("SELECT COUNT(*) AS cnt FROM sessions").get() as { cnt: number })
				.cnt,
			measurements: (
				first.prepare("SELECT COUNT(*) AS cnt FROM measurements").get() as { cnt: number }
			).cnt,
		};
		first.close();

		await runQuietBackfill(args);

		const second = new Database(path.join(destDir, "metrics.db"), { readonly: true });
		try {
			const secondCounts = {
				sessions: (second.prepare("SELECT COUNT(*) AS cnt FROM sessions").get() as { cnt: number })
					.cnt,
				measurements: (
					second.prepare("SELECT COUNT(*) AS cnt FROM measurements").get() as { cnt: number }
				).cnt,
			};
			expect(secondCounts).toEqual(firstCounts);
			expect(secondCounts).toEqual({ sessions: 3, measurements: 65 });
		} finally {
			second.close();
		}
	});

	it("writes deltas when --with-deltas is set", async () => {
		await runQuietBackfill({
			source: sourcePath,
			dest: destDir,
			dryRun: false,
			withDeltas: true,
			since: null,
			help: false,
		});

		const dest = new Database(path.join(destDir, "metrics.db"), { readonly: true });
		try {
			const deltas = dest
				.prepare(
					"SELECT COUNT(*) AS cnt FROM measurement_deltas WHERE session_id = 'sess-1'",
				)
				.get() as { cnt: number };
			expect(deltas.cnt).toBeGreaterThan(0);

			const costDelta = dest
				.prepare(
					"SELECT delta FROM measurement_deltas WHERE session_id = 'sess-1' AND metric_name = 'cost'",
				)
				.get() as { delta: number };
			expect(costDelta.delta).toBeCloseTo(0.15);
		} finally {
			dest.close();
		}
	});

	it("writes nothing in --dry-run mode", async () => {
		const stats = await runQuietBackfill({
			source: sourcePath,
			dest: destDir,
			dryRun: true,
			withDeltas: false,
			since: null,
			help: false,
		});

		expect(stats.layout).toBe("v2");
		expect(stats.totalSessions).toBe(3);
		expect(existsSync(path.join(destDir, "metrics.db"))).toBe(false);
	});

	it("rejects an ambiguous layout without touching the destination", async () => {
		const partialPath = path.join(tempDir, "partial.db");
		const partial = createV2SourceDb(partialPath);
		partial.run("DROP TABLE session_part");
		partial.close();

		let error: unknown;
		try {
			await runQuietBackfill({
				source: partialPath,
				dest: destDir,
				dryRun: false,
				withDeltas: false,
				since: null,
				help: false,
			});
		} catch (err) {
			error = err;
		}

		expect(error).toBeInstanceOf(SourceSchemaError);
		expect((error as Error).message).toContain("session_part");
		expect(existsSync(path.join(destDir, "metrics.db"))).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Legacy reader end-to-end — confirms the reader seam preserves V1 behavior
// ---------------------------------------------------------------------------

describe("legacy reader end-to-end", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(path.join(tmpdir(), "ocm-backfill-legacy-e2e-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("keeps legacy session, metric, classification, and artifact results", async () => {
		const sourcePath = path.join(tempDir, "source.db");
		const destDir = path.join(tempDir, "dest");
		const db = createSourceDb(sourcePath);

		insertProject(db, "proj-1", "test-project", "/home/user/test-project");
		insertSessionWithData(db, {
			sessionId: "sess-root",
			projectId: "proj-1",
			cost: 0.15,
			tokensInput: 1000,
			tokensOutput: 500,
			tokensCacheRead: 800,
			agent: "build",
			model: '{"id":"claude-opus-4-6"}',
			title: "Implement feature",
			timeCreated: 1700000000000,
			timeUpdated: 1700003600000,
			summaryFiles: 3,
			summaryAdditions: 50,
			summaryDeletions: 10,
			userMessage: "implement the feature",
		});
		insertSessionWithData(db, {
			sessionId: "sess-child",
			projectId: "proj-1",
			parentId: "sess-root",
			cost: 0.05,
			tokensInput: 200,
			tokensOutput: 100,
			agent: "explore",
			model: '{"id":"claude-sonnet-4-20250514"}',
			timeCreated: 1700010000000,
			timeUpdated: 1700011000000,
			userMessage: "explore the code",
		});

		// Legacy tool part: both the classification command query and the
		// artifact extractor read state.input.command; the artifact path also
		// reads state.output. This is the pre-change runBackfill behavior.
		db.run(
			`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
			 VALUES (?, ?, ?, ?, ?, ?)`,
			[
				"part-tool-sess-root",
				"msg-asst-sess-root",
				"sess-root",
				1700000000300,
				1700000000400,
				JSON.stringify({
					type: "tool",
					tool: "bash",
					state: {
						input: { command: "gh pr create --fill" },
						output: "https://github.com/acme/widgets/pull/9",
					},
				}),
			],
		);
		db.close();

		const stats = await runQuietBackfill({
			source: sourcePath,
			dest: destDir,
			dryRun: false,
			withDeltas: false,
			since: null,
			help: false,
		});

		expect(stats.layout).toBe("legacy");
		expect(stats.totalSessions).toBe(2);

		const dest = new Database(path.join(destDir, "metrics.db"), { readonly: true });
		try {
			const sessions = dest
				.prepare(
					"SELECT session_id, model, classification, parent_session_id FROM sessions",
				)
				.all() as Array<{
				session_id: string;
				model: string;
				classification: string;
				parent_session_id: string | null;
			}>;
			const byId = Object.fromEntries(sessions.map((row) => [row.session_id, row]));

			expect(byId["sess-root"].model).toBe("claude-opus-4-6");
			expect(byId["sess-root"].classification).toBe("pr-creation");
			expect(byId["sess-root"].parent_session_id).toBeNull();
			expect(byId["sess-child"].classification).toBe("exploration");
			expect(byId["sess-child"].parent_session_id).toBe("sess-root");

			const measurements = dest
				.prepare("SELECT COUNT(*) AS cnt FROM measurements")
				.get() as { cnt: number };
			expect(measurements.cnt).toBe(42); // 2 sessions × 21 metrics (no fully timed history)

			const read = (sessionId: string, metric: string): number => {
				const row = dest
					.prepare(
						"SELECT value FROM measurements WHERE session_id = ? AND metric_name = ?",
					)
					.get(sessionId, metric) as { value: number };
				return row.value;
			};
			expect(read("sess-root", "files_changed")).toBe(3);
			expect(read("sess-root", "lines_added")).toBe(50);
			expect(read("sess-root", "lines_deleted")).toBe(10);
			expect(read("sess-root", "cache_hit_ratio")).toBeCloseTo(800 / 1800, 5);
			expect(read("sess-root", "child_sessions")).toBe(1);
			expect(read("sess-child", "child_sessions")).toBe(0);
			expect(read("sess-root", "turns_total")).toBeGreaterThan(0);

			const artifacts = dest
				.prepare("SELECT artifact_type, reference FROM session_artifacts")
				.all();
			expect(artifacts).toEqual([
				{ artifact_type: "pr-created", reference: "acme/widgets#9" },
			]);
		} finally {
			dest.close();
		}
	});
});
