// SPDX-License-Identifier: Apache-2.0

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { classify } from "../src/classifier";
import { loadConfig } from "../src/config";
import { initDatabase } from "../src/db";
import { computeCacheHitRatio, computeDurationSeconds } from "../src/extractor";
import { upsertProject, upsertSession, writeMetrics } from "../src/writer";
import {
	backfillMissingDeltas,
	deriveProjectName,
	extractModelId,
	parseDateToEpochMs,
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
	},
): void {
	db.run(
		`INSERT INTO session (
			id, project_id, cost, tokens_input, tokens_output,
			tokens_reasoning, tokens_cache_read, tokens_cache_write,
			agent, model, title, time_created, time_updated,
			summary_files, summary_additions, summary_deletions
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			opts.sessionId,
			opts.projectId,
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
