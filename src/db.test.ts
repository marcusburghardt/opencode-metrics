// SPDX-License-Identifier: Apache-2.0

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CostPricingRule } from "./config";
import { initDatabase } from "./db";
import { syncCostPricing } from "./pricing";

/** Helper tables expected in the v4 schema. */
const EXPECTED_TABLES = [
	"projects",
	"sessions",
	"metric_definitions",
	"measurements",
	"measurement_deltas",
	"session_artifacts",
	"cost_pricing",
];

/** Helper views expected in the v4 schema. */
const EXPECTED_VIEWS = [
	"v_sessions",
	"v_measurements",
	"v_measurement_deltas",
	"v_session_artifacts",
	"v_adjusted_costs",
	"v_adjusted_cost_deltas",
];

/** Helper indexes expected in the v2 schema. */
const EXPECTED_INDEXES = [
	"idx_measurements_time",
	"idx_measurements_metric",
	"idx_deltas_metric_time",
	"idx_artifacts_reference",
];

describe("initDatabase", () => {
	let tempDir: string;
	let db: Database;

	beforeEach(() => {
		tempDir = mkdtempSync(path.join(tmpdir(), "ocm-test-"));
		const result = initDatabase(tempDir);
		db = result.db;
	});

	afterEach(() => {
		db.close();
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("creates all schema tables", () => {
		const tables = db
			.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
			.all() as Array<{ name: string }>;

		const tableNames = tables.map((row) => row.name);

		for (const expected of EXPECTED_TABLES) {
			expect(tableNames).toContain(expected);
		}
	});

	it("creates all expected indexes", () => {
		const indexes = db
			.prepare("SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name")
			.all() as Array<{ name: string }>;

		const indexNames = indexes.map((row) => row.name);

		for (const expected of EXPECTED_INDEXES) {
			expect(indexNames).toContain(expected);
		}
	});

	it("is idempotent — running twice on the same path causes no errors", () => {
		// Close the db from beforeEach so we can re-initialize.
		db.close();

		const first = initDatabase(tempDir);
		first.db.close();

		// Second call on the same directory must not throw.
		const second = initDatabase(tempDir);
		db = second.db;

		const tables = db
			.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
			.all() as Array<{ name: string }>;

		const tableNames = tables.map((row) => row.name);
		for (const expected of EXPECTED_TABLES) {
			expect(tableNames).toContain(expected);
		}
	});

	it("enables WAL journal mode", () => {
		const row = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
		expect(row.journal_mode).toBe("wal");
	});

	it("sets user_version to 4", () => {
		const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
		expect(row.user_version).toBe(4);
	});

	it("preserves user_version on subsequent calls", () => {
		db.close();

		const first = initDatabase(tempDir);
		first.db.close();

		const second = initDatabase(tempDir);
		db = second.db;

		const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
		expect(row.user_version).toBe(4);
	});

	it("fresh database has budget_tag column on sessions table", () => {
		const columns = db.prepare("PRAGMA table_info(sessions)").all() as Array<{
			name: string;
			type: string;
		}>;

		const columnMap = new Map(columns.map((col) => [col.name, col.type]));
		expect(columnMap.has("budget_tag")).toBe(true);
		expect(columnMap.get("budget_tag")).toBe("TEXT");
	});

	it("migration from v2 adds budget_tag column without data loss", () => {
		// Close the current v3 database and simulate a v2 database.
		db.close();

		// Create a fresh temp dir for the v2 simulation.
		const v2Dir = mkdtempSync(path.join(tmpdir(), "ocm-v2-migration-"));
		const v2DbPath = path.join(v2Dir, "metrics.db");
		const { Database } = require("bun:sqlite");
		const v2Db = new Database(v2DbPath, { create: true });

		// Create a v2-style sessions table (without budget_tag).
		v2Db.run(`
			CREATE TABLE sessions (
				session_id     TEXT PRIMARY KEY,
				project_id     TEXT,
				agent          TEXT,
				model          TEXT,
				classification TEXT,
				title          TEXT,
				started_at     INTEGER,
				ended_at       INTEGER,
				metadata       TEXT
			)
		`);

		// Insert a session row with v2 schema.
		v2Db.run(
			`INSERT INTO sessions (session_id, project_id, agent, model, classification, title, started_at, ended_at, metadata)
			 VALUES ('existing-sess', 'proj-1', 'build', 'opus', 'impl', 'existing session', 1700000000000, 1700003600000, '{"key":"val"}')`,
		);

		// Mark as v2.
		v2Db.run("PRAGMA user_version = 2");
		v2Db.close();

		// Now run initDatabase on this v2 directory — should migrate to v4
		// (applying all pending migrations: v2→v3 adds budget_tag, v3→v4
		// adds cost_pricing table and adjusted cost views).
		const migrated = initDatabase(v2Dir);
		db = migrated.db;

		// Schema version should be 4 (latest).
		const versionRow = db.prepare("PRAGMA user_version").get() as { user_version: number };
		expect(versionRow.user_version).toBe(4);

		// budget_tag column should exist.
		const columns = db.prepare("PRAGMA table_info(sessions)").all() as Array<{
			name: string;
			type: string;
		}>;
		const columnMap = new Map(columns.map((col) => [col.name, col.type]));
		expect(columnMap.has("budget_tag")).toBe(true);

		// Existing data should be preserved — no data loss.
		const row = db
			.prepare("SELECT * FROM sessions WHERE session_id = ?")
			.get("existing-sess") as Record<string, unknown>;
		expect(row.project_id).toBe("proj-1");
		expect(row.agent).toBe("build");
		expect(row.model).toBe("opus");
		expect(row.classification).toBe("impl");
		expect(row.title).toBe("existing session");
		expect(row.metadata).toBe('{"key":"val"}');
		// budget_tag should be NULL for pre-existing rows.
		expect(row.budget_tag).toBeNull();

		// Cleanup
		db.close();
		rmSync(v2Dir, { recursive: true, force: true });

		// Re-open original tempDir for afterEach cleanup
		const result = initDatabase(tempDir);
		db = result.db;
	});

	it("seeds 15 metric definitions", () => {
		const row = db.prepare("SELECT COUNT(*) AS count FROM metric_definitions").get() as {
			count: number;
		};
		expect(row.count).toBe(15);
	});

	it("seeds correct metric names", () => {
		const rows = db
			.prepare("SELECT metric_name FROM metric_definitions ORDER BY metric_name")
			.all() as Array<{
			metric_name: string;
		}>;

		const names = rows.map((row) => row.metric_name);

		expect(names).toContain("cost");
		expect(names).toContain("tokens_input");
		expect(names).toContain("tokens_output");
		expect(names).toContain("tokens_reasoning");
		expect(names).toContain("tokens_cache_read");
		expect(names).toContain("tokens_cache_write");
		expect(names).toContain("cache_hit_ratio");
		expect(names).toContain("duration_seconds");
		expect(names).toContain("files_changed");
		expect(names).toContain("lines_added");
		expect(names).toContain("lines_deleted");
		expect(names).toContain("messages_total");
		expect(names).toContain("prs_created");
		expect(names).toContain("prs_reviewed");
		expect(names).toContain("issues_referenced");
	});

	it("does not duplicate metric definitions on repeated calls", () => {
		db.close();

		const first = initDatabase(tempDir);
		first.db.close();

		const second = initDatabase(tempDir);
		db = second.db;

		const row = db.prepare("SELECT COUNT(*) AS count FROM metric_definitions").get() as {
			count: number;
		};
		expect(row.count).toBe(15);
	});

	it("returns the resolved data directory path", () => {
		// The dataDir returned by initDatabase must match the override we passed.
		db.close();
		const result = initDatabase(tempDir);
		db = result.db;
		expect(result.dataDir).toBe(tempDir);
	});

	it("creates v_sessions and v_measurements convenience views", () => {
		const views = db
			.prepare("SELECT name FROM sqlite_master WHERE type = 'view' ORDER BY name")
			.all() as Array<{ name: string }>;

		const viewNames = views.map((row) => row.name);
		for (const expected of EXPECTED_VIEWS) {
			expect(viewNames).toContain(expected);
		}
	});

	it("v_sessions converts epoch milliseconds to epoch seconds and ISO-8601", () => {
		// Insert a session with known epoch-millisecond timestamps.
		// 1700000000000 ms = 2023-11-14T22:13:20Z
		db.run(
			`INSERT INTO sessions (session_id, project_id, agent, model, classification, title, started_at, ended_at)
			 VALUES ('s1', 'p1', 'build', 'opus', 'impl', 'test', 1700000000000, 1700003600000)`,
		);

		const row = db.prepare("SELECT * FROM v_sessions WHERE session_id = 's1'").get() as Record<
			string,
			unknown
		>;

		expect(row.started_at_epoch).toBe(1700000000);
		expect(row.ended_at_epoch).toBe(1700003600);
		expect(row.started_at_iso).toBe("2023-11-14T22:13:20Z");
		expect(row.ended_at_iso).toBe("2023-11-14T23:13:20Z");
		// Dimension columns pass through unchanged.
		expect(row.agent).toBe("build");
		expect(row.classification).toBe("impl");
	});

	it("v_measurements converts epoch milliseconds to epoch seconds and ISO-8601", () => {
		db.run(
			`INSERT INTO measurements (session_id, metric_name, value, recorded_at)
			 VALUES ('s1', 'cost', 0.42, 1700003600000)`,
		);

		const row = db.prepare("SELECT * FROM v_measurements WHERE session_id = 's1'").get() as Record<
			string,
			unknown
		>;

		expect(row.recorded_at_epoch).toBe(1700003600);
		expect(row.recorded_at_iso).toBe("2023-11-14T23:13:20Z");
		expect(row.value).toBe(0.42);
		expect(row.metric_name).toBe("cost");
	});

	it("measurement_deltas table exists with correct columns", () => {
		const columns = db.prepare("PRAGMA table_info(measurement_deltas)").all() as Array<{
			name: string;
			type: string;
		}>;

		const columnMap = new Map(columns.map((col) => [col.name, col.type]));

		expect(columnMap.get("session_id")).toBe("TEXT");
		expect(columnMap.get("metric_name")).toBe("TEXT");
		expect(columnMap.get("delta")).toBe("REAL");
		expect(columnMap.get("recorded_at")).toBe("INTEGER");
		expect(columns.length).toBe(4);
	});

	it("idx_deltas_metric_time index exists", () => {
		const indexes = db
			.prepare("SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name")
			.all() as Array<{ name: string }>;

		const indexNames = indexes.map((row) => row.name);
		expect(indexNames).toContain("idx_deltas_metric_time");
	});

	it("v_measurement_deltas view exists", () => {
		const views = db
			.prepare("SELECT name FROM sqlite_master WHERE type = 'view' ORDER BY name")
			.all() as Array<{ name: string }>;

		const viewNames = views.map((row) => row.name);
		expect(viewNames).toContain("v_measurement_deltas");
	});

	it("v_measurement_deltas returns correct epoch and ISO columns", () => {
		// Insert a delta row with known timestamp: 1700003600000 ms
		// = 1700003600 epoch seconds = 2023-11-14T23:13:20Z
		db.run(
			`INSERT INTO measurement_deltas (session_id, metric_name, delta, recorded_at)
			 VALUES ('s1', 'cost', 0.42, 1700003600000)`,
		);

		const row = db
			.prepare("SELECT * FROM v_measurement_deltas WHERE session_id = 's1'")
			.get() as Record<string, unknown>;

		expect(row.recorded_at_epoch).toBe(1700003600);
		expect(row.recorded_at_iso).toBe("2023-11-14T23:13:20Z");
		expect(row.delta).toBe(0.42);
		expect(row.metric_name).toBe("cost");
	});

	it("session_artifacts table exists with correct columns", () => {
		const columns = db.prepare("PRAGMA table_info(session_artifacts)").all() as Array<{
			name: string;
			type: string;
		}>;

		const columnMap = new Map(columns.map((col) => [col.name, col.type]));

		expect(columnMap.get("session_id")).toBe("TEXT");
		expect(columnMap.get("artifact_type")).toBe("TEXT");
		expect(columnMap.get("reference")).toBe("TEXT");
		expect(columnMap.get("recorded_at")).toBe("INTEGER");
		expect(columns.length).toBe(4);
	});

	it("v_session_artifacts returns correct epoch and ISO columns", () => {
		// Insert an artifact with known timestamp: 1700003600000 ms
		// = 1700003600 epoch seconds = 2023-11-14T23:13:20Z
		db.run(
			`INSERT INTO session_artifacts (session_id, artifact_type, reference, recorded_at)
			 VALUES ('s1', 'pr-created', 'org/repo#1', 1700003600000)`,
		);

		const row = db
			.prepare("SELECT * FROM v_session_artifacts WHERE session_id = 's1'")
			.get() as Record<string, unknown>;

		expect(row.recorded_at_epoch).toBe(1700003600);
		expect(row.recorded_at_iso).toBe("2023-11-14T23:13:20Z");
		expect(row.artifact_type).toBe("pr-created");
		expect(row.reference).toBe("org/repo#1");
	});

	it("cost_pricing table exists with correct columns", () => {
		const columns = db.prepare("PRAGMA table_info(cost_pricing)").all() as Array<{
			name: string;
			type: string;
			notnull: number;
			pk: number;
		}>;

		const columnMap = new Map(columns.map((col) => [col.name, col]));

		expect(columnMap.get("model_pattern")?.type).toBe("TEXT");
		expect(columnMap.get("model_pattern")?.pk).toBe(1);
		expect(columnMap.get("priority")?.type).toBe("INTEGER");
		expect(columnMap.get("priority")?.notnull).toBe(1);
		expect(columnMap.get("input_price")?.type).toBe("REAL");
		expect(columnMap.get("input_price")?.notnull).toBe(1);
		expect(columnMap.get("output_price")?.type).toBe("REAL");
		expect(columnMap.get("output_price")?.notnull).toBe(1);
		expect(columnMap.get("cache_read_price")?.type).toBe("REAL");
		expect(columnMap.get("cache_write_price")?.type).toBe("REAL");
		expect(columnMap.get("reasoning_price")?.type).toBe("REAL");
		expect(columnMap.get("description")?.type).toBe("TEXT");
		expect(columnMap.get("updated_at")?.type).toBe("INTEGER");
		expect(columns.length).toBe(9);
	});

	it("v_adjusted_costs view is queryable", () => {
		// The view must be queryable even with no data — SELECT should
		// not throw, just return an empty result set.
		const rows = db.prepare("SELECT * FROM v_adjusted_costs").all();
		expect(rows).toEqual([]);
	});

	it("v_adjusted_cost_deltas view is queryable", () => {
		// Same pattern — verify the view exists and is queryable.
		const rows = db.prepare("SELECT * FROM v_adjusted_cost_deltas").all();
		expect(rows).toEqual([]);
	});

	it("migration from v3 to v4 adds cost_pricing table and views", () => {
		// Close the current v4 database and simulate a v3 database.
		db.close();

		const v3Dir = mkdtempSync(path.join(tmpdir(), "ocm-v3-migration-"));
		const v3DbPath = path.join(v3Dir, "metrics.db");
		const { Database } = require("bun:sqlite");
		const v3Db = new Database(v3DbPath, { create: true });

		// Create v3-style tables (without cost_pricing or adjusted views).
		v3Db.run(`
			CREATE TABLE sessions (
				session_id     TEXT PRIMARY KEY,
				project_id     TEXT,
				agent          TEXT,
				model          TEXT,
				classification TEXT,
				title          TEXT,
				started_at     INTEGER,
				ended_at       INTEGER,
				metadata       TEXT,
				budget_tag     TEXT
			)
		`);
		v3Db.run(`
			CREATE TABLE measurements (
				session_id  TEXT,
				metric_name TEXT,
				value       REAL,
				recorded_at INTEGER,
				PRIMARY KEY (session_id, metric_name)
			)
		`);
		v3Db.run(`
			CREATE TABLE measurement_deltas (
				session_id  TEXT,
				metric_name TEXT,
				delta       REAL,
				recorded_at INTEGER,
				PRIMARY KEY (session_id, metric_name, recorded_at)
			)
		`);

		// Mark as v3.
		v3Db.run("PRAGMA user_version = 3");
		v3Db.close();

		// Run initDatabase — should migrate to v4.
		const migrated = initDatabase(v3Dir);
		db = migrated.db;

		// Schema version should be 4.
		const versionRow = db.prepare("PRAGMA user_version").get() as { user_version: number };
		expect(versionRow.user_version).toBe(4);

		// cost_pricing table should exist.
		const tables = db
			.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cost_pricing'")
			.all() as Array<{ name: string }>;
		expect(tables.length).toBe(1);

		// Adjusted cost views should exist and be queryable.
		const views = db
			.prepare(
				"SELECT name FROM sqlite_master WHERE type = 'view' AND name IN ('v_adjusted_costs', 'v_adjusted_cost_deltas') ORDER BY name",
			)
			.all() as Array<{ name: string }>;
		expect(views.length).toBe(2);

		// Cleanup
		db.close();
		rmSync(v3Dir, { recursive: true, force: true });

		// Re-open original tempDir for afterEach cleanup.
		const result = initDatabase(tempDir);
		db = result.db;
	});
});

// ---------------------------------------------------------------------------
// Task 4.1: Integration tests for v_adjusted_costs view
// ---------------------------------------------------------------------------

describe("v_adjusted_costs", () => {
	let tempDir: string;
	let db: Database;

	beforeEach(() => {
		tempDir = mkdtempSync(path.join(tmpdir(), "ocm-adj-costs-"));
		const result = initDatabase(tempDir);
		db = result.db;
	});

	afterEach(() => {
		db.close();
		rmSync(tempDir, { recursive: true, force: true });
	});

	/** Seed a session and its 6 core measurements in one call. */
	function seedSessionWithMetrics(
		sessionId: string,
		model: string,
		metrics: {
			cost: number;
			tokens_input: number;
			tokens_output: number;
			tokens_reasoning: number;
			tokens_cache_read: number;
			tokens_cache_write: number;
		},
		opts?: { classification?: string; budgetTag?: string; projectId?: string },
	): void {
		const classification = opts?.classification ?? "impl";
		const budgetTag = opts?.budgetTag ?? null;
		const projectId = opts?.projectId ?? "p1";

		db.run(
			`INSERT INTO sessions (session_id, project_id, model, classification, budget_tag, started_at)
			 VALUES (?, ?, ?, ?, ?, 1700000000000)`,
			[sessionId, projectId, model, classification, budgetTag],
		);

		const recordedAt = 1700003600000;
		const entries: Array<[string, number]> = [
			["cost", metrics.cost],
			["tokens_input", metrics.tokens_input],
			["tokens_output", metrics.tokens_output],
			["tokens_reasoning", metrics.tokens_reasoning],
			["tokens_cache_read", metrics.tokens_cache_read],
			["tokens_cache_write", metrics.tokens_cache_write],
		];

		for (const [metricName, value] of entries) {
			db.run(
				`INSERT INTO measurements (session_id, metric_name, value, recorded_at)
				 VALUES (?, ?, ?, ?)`,
				[sessionId, metricName, value, recordedAt],
			);
		}
	}

	it("adjusted_cost computation matches spec formula", () => {
		seedSessionWithMetrics(
			"s1",
			"google-vertex-anthropic/claude-opus-4-6@default",
			{
				cost: 0.42,
				tokens_input: 5000,
				tokens_output: 1000,
				tokens_reasoning: 0,
				tokens_cache_read: 0,
				tokens_cache_write: 0,
			},
			{ classification: "impl", budgetTag: "team-a" },
		);

		const rules: CostPricingRule[] = [
			{ model: "%claude-opus-4%", input_price: 15.0, output_price: 75.0 },
		];
		syncCostPricing(db, rules);

		const row = db
			.prepare("SELECT * FROM v_adjusted_costs WHERE session_id = 's1'")
			.get() as Record<string, unknown>;

		// original_cost = 0.42
		expect(row.original_cost).toBeCloseTo(0.42, 10);
		// adjusted_cost = (5000 * 15 / 1e6) + (1000 * 75 / 1e6) = 0.075 + 0.075 = 0.15
		expect(row.adjusted_cost).toBeCloseTo(0.15, 10);
		// cost_difference = 0.15 - 0.42 = -0.27
		expect(row.cost_difference).toBeCloseTo(-0.27, 10);
		// Dimension passthrough
		expect(row.model).toBe("google-vertex-anthropic/claude-opus-4-6@default");
		expect(row.classification).toBe("impl");
		expect(row.budget_tag).toBe("team-a");
		expect(row.project_id).toBe("p1");
	});

	it("falls back to original_cost when no pricing rule matches", () => {
		seedSessionWithMetrics("s2", "unknown-model", {
			cost: 0.42,
			tokens_input: 5000,
			tokens_output: 1000,
			tokens_reasoning: 0,
			tokens_cache_read: 0,
			tokens_cache_write: 0,
		});

		// No pricing rules synced — cost_pricing table is empty.

		const row = db
			.prepare("SELECT * FROM v_adjusted_costs WHERE session_id = 's2'")
			.get() as Record<string, unknown>;

		expect(row.adjusted_cost).toBeCloseTo(0.42, 10);
		expect(row.cost_difference).toBeCloseTo(0, 10);
	});

	it("first-match-wins with multiple matching rules", () => {
		seedSessionWithMetrics("s3", "claude-opus-4-6", {
			cost: 1.0,
			tokens_input: 10000,
			tokens_output: 2000,
			tokens_reasoning: 0,
			tokens_cache_read: 0,
			tokens_cache_write: 0,
		});

		// Two rules: first matches more specifically, second is a broader
		// pattern. Priority is determined by array order (index 0 wins).
		const rules: CostPricingRule[] = [
			{ model: "%claude-opus-4%", input_price: 15.0, output_price: 75.0 },
			{ model: "%claude%", input_price: 10.0, output_price: 50.0 },
		];
		syncCostPricing(db, rules);

		const row = db
			.prepare("SELECT * FROM v_adjusted_costs WHERE session_id = 's3'")
			.get() as Record<string, unknown>;

		// First rule (priority 0): (10000*15/1e6) + (2000*75/1e6) = 0.15 + 0.15 = 0.30
		// Second rule (priority 1) would give: (10000*10/1e6) + (2000*50/1e6) = 0.10 + 0.10 = 0.20
		expect(row.adjusted_cost).toBeCloseTo(0.3, 10);
	});
});

// ---------------------------------------------------------------------------
// Task 4.2: Integration tests for v_adjusted_cost_deltas view
// ---------------------------------------------------------------------------

describe("v_adjusted_cost_deltas", () => {
	let tempDir: string;
	let db: Database;

	beforeEach(() => {
		tempDir = mkdtempSync(path.join(tmpdir(), "ocm-adj-deltas-"));
		const result = initDatabase(tempDir);
		db = result.db;
	});

	afterEach(() => {
		db.close();
		rmSync(tempDir, { recursive: true, force: true });
	});

	/** Seed a session row (no measurements). */
	function seedSession(sessionId: string, model: string): void {
		db.run(
			`INSERT INTO sessions (session_id, project_id, model, classification, started_at)
			 VALUES (?, 'p1', ?, 'impl', 1700000000000)`,
			[sessionId, model],
		);
	}

	/** Seed a full set of measurement deltas at a given timestamp. */
	function seedDeltas(
		sessionId: string,
		recordedAt: number,
		deltas: {
			cost: number;
			tokens_input: number;
			tokens_output: number;
			tokens_reasoning: number;
			tokens_cache_read: number;
			tokens_cache_write: number;
		},
	): void {
		const entries: Array<[string, number]> = [
			["cost", deltas.cost],
			["tokens_input", deltas.tokens_input],
			["tokens_output", deltas.tokens_output],
			["tokens_reasoning", deltas.tokens_reasoning],
			["tokens_cache_read", deltas.tokens_cache_read],
			["tokens_cache_write", deltas.tokens_cache_write],
		];

		for (const [metricName, delta] of entries) {
			db.run(
				`INSERT INTO measurement_deltas (session_id, metric_name, delta, recorded_at)
				 VALUES (?, ?, ?, ?)`,
				[sessionId, metricName, delta, recordedAt],
			);
		}
	}

	it("adjusted_cost_delta computation matches spec formula", () => {
		seedSession("s1", "google-vertex-anthropic/claude-opus-4-6@default");
		seedDeltas("s1", 1700003600000, {
			cost: 0.1,
			tokens_input: 2000,
			tokens_output: 500,
			tokens_reasoning: 0,
			tokens_cache_read: 0,
			tokens_cache_write: 0,
		});

		const rules: CostPricingRule[] = [
			{ model: "%claude-opus-4%", input_price: 15.0, output_price: 75.0 },
		];
		syncCostPricing(db, rules);

		const row = db
			.prepare("SELECT * FROM v_adjusted_cost_deltas WHERE session_id = 's1'")
			.get() as Record<string, unknown>;

		// original_cost_delta = 0.10
		expect(row.original_cost_delta).toBeCloseTo(0.1, 10);
		// adjusted_cost_delta = (2000*15/1e6) + (500*75/1e6)
		//                     = 0.03 + 0.0375 = 0.0675
		expect(row.adjusted_cost_delta).toBeCloseTo(0.0675, 10);
		// cost_delta_difference = 0.0675 - 0.10 = -0.0325
		expect(row.cost_delta_difference).toBeCloseTo(-0.0325, 10);
	});

	it("falls back to original when no rule matches", () => {
		seedSession("s2", "unknown-model");
		seedDeltas("s2", 1700003600000, {
			cost: 0.25,
			tokens_input: 3000,
			tokens_output: 700,
			tokens_reasoning: 0,
			tokens_cache_read: 0,
			tokens_cache_write: 0,
		});

		// No pricing rules — cost_pricing table is empty.

		const row = db
			.prepare("SELECT * FROM v_adjusted_cost_deltas WHERE session_id = 's2'")
			.get() as Record<string, unknown>;

		expect(row.adjusted_cost_delta).toBeCloseTo(0.25, 10);
		expect(row.cost_delta_difference).toBeCloseTo(0, 10);
	});

	it("time-series aggregation — each delta row has correct adjusted values", () => {
		seedSession("s3", "google-vertex-anthropic/claude-opus-4-6@default");

		// Two delta snapshots at different timestamps.
		const t1 = 1700003600000;
		const t2 = 1700007200000;

		seedDeltas("s3", t1, {
			cost: 0.1,
			tokens_input: 2000,
			tokens_output: 500,
			tokens_reasoning: 0,
			tokens_cache_read: 0,
			tokens_cache_write: 0,
		});
		seedDeltas("s3", t2, {
			cost: 0.2,
			tokens_input: 3000,
			tokens_output: 800,
			tokens_reasoning: 0,
			tokens_cache_read: 0,
			tokens_cache_write: 0,
		});

		const rules: CostPricingRule[] = [
			{ model: "%claude-opus-4%", input_price: 15.0, output_price: 75.0 },
		];
		syncCostPricing(db, rules);

		const rows = db
			.prepare(
				"SELECT * FROM v_adjusted_cost_deltas WHERE session_id = 's3' ORDER BY recorded_at_epoch",
			)
			.all() as Array<Record<string, unknown>>;

		expect(rows.length).toBe(2);

		// t1: adjusted = (2000*15/1e6) + (500*75/1e6) = 0.03 + 0.0375 = 0.0675
		expect(rows[0].recorded_at_epoch).toBe(t1 / 1000);
		expect(rows[0].adjusted_cost_delta).toBeCloseTo(0.0675, 10);

		// t2: adjusted = (3000*15/1e6) + (800*75/1e6) = 0.045 + 0.06 = 0.105
		expect(rows[1].recorded_at_epoch).toBe(t2 / 1000);
		expect(rows[1].adjusted_cost_delta).toBeCloseTo(0.105, 10);
	});
});

// ---------------------------------------------------------------------------
// Task 4.3: Edge case tests for adjusted cost views
// ---------------------------------------------------------------------------

describe("adjusted cost edge cases", () => {
	let tempDir: string;
	let db: Database;

	beforeEach(() => {
		tempDir = mkdtempSync(path.join(tmpdir(), "ocm-adj-edge-"));
		const result = initDatabase(tempDir);
		db = result.db;
	});

	afterEach(() => {
		db.close();
		rmSync(tempDir, { recursive: true, force: true });
	});

	/** Seed a session row. */
	function seedSession(sessionId: string, model: string): void {
		db.run(
			`INSERT INTO sessions (session_id, project_id, model, classification, started_at)
			 VALUES (?, 'p1', ?, 'impl', 1700000000000)`,
			[sessionId, model],
		);
	}

	/** Seed all 6 core measurements for a session. */
	function seedMeasurements(
		sessionId: string,
		metrics: {
			cost: number;
			tokens_input: number;
			tokens_output: number;
			tokens_reasoning: number;
			tokens_cache_read: number;
			tokens_cache_write: number;
		},
	): void {
		const recordedAt = 1700003600000;
		const entries: Array<[string, number]> = [
			["cost", metrics.cost],
			["tokens_input", metrics.tokens_input],
			["tokens_output", metrics.tokens_output],
			["tokens_reasoning", metrics.tokens_reasoning],
			["tokens_cache_read", metrics.tokens_cache_read],
			["tokens_cache_write", metrics.tokens_cache_write],
		];

		for (const [metricName, value] of entries) {
			db.run(
				`INSERT INTO measurements (session_id, metric_name, value, recorded_at)
				 VALUES (?, ?, ?, ?)`,
				[sessionId, metricName, value, recordedAt],
			);
		}
	}

	it("NULL optional price fields — reasoning falls back to output_price, cache defaults to 0", () => {
		seedSession("s1", "claude-opus-4-6");
		seedMeasurements("s1", {
			cost: 1.0,
			tokens_input: 10000,
			tokens_output: 2000,
			tokens_reasoning: 500,
			tokens_cache_read: 3000,
			tokens_cache_write: 1000,
		});

		// Sync pricing with only required fields — no cache or reasoning prices.
		// cache_read_price and cache_write_price default to 0.
		// reasoning_price falls back to output_price.
		const rules: CostPricingRule[] = [
			{ model: "%claude-opus-4%", input_price: 15.0, output_price: 75.0 },
		];
		syncCostPricing(db, rules);

		const row = db
			.prepare("SELECT * FROM v_adjusted_costs WHERE session_id = 's1'")
			.get() as Record<string, unknown>;

		// adjusted_cost =
		//   (10000 * 15 / 1e6)          input:       0.15
		// + (2000  * 75 / 1e6)          output:      0.15
		// + (3000  * 0  / 1e6)          cache_read:  0      (NULL → 0)
		// + (1000  * 0  / 1e6)          cache_write: 0      (NULL → 0)
		// + (500   * 75 / 1e6)          reasoning:   0.0375 (NULL → output_price)
		//                               total:       0.3375
		expect(row.adjusted_cost).toBeCloseTo(0.3375, 10);
		// Verify cache tokens contribute 0 (not priced).
		// Verify reasoning tokens are priced at output_price (75), not 0.
		expect(row.cost_difference).toBeCloseTo(0.3375 - 1.0, 10);
	});

	it("empty cost_pricing table — all sessions use original cost", () => {
		seedSession("s1", "claude-opus-4-6");
		seedMeasurements("s1", {
			cost: 0.42,
			tokens_input: 5000,
			tokens_output: 1000,
			tokens_reasoning: 0,
			tokens_cache_read: 0,
			tokens_cache_write: 0,
		});

		// No pricing rules synced — cost_pricing table is empty.

		const row = db
			.prepare("SELECT * FROM v_adjusted_costs WHERE session_id = 's1'")
			.get() as Record<string, unknown>;

		expect(row.adjusted_cost).toBeCloseTo(0.42, 10);
		expect(row.cost_difference).toBeCloseTo(0, 10);
	});

	it("session with zero token counts — adjusted_cost is 0", () => {
		seedSession("s1", "claude-opus-4-6");
		seedMeasurements("s1", {
			cost: 0.5,
			tokens_input: 0,
			tokens_output: 0,
			tokens_reasoning: 0,
			tokens_cache_read: 0,
			tokens_cache_write: 0,
		});

		const rules: CostPricingRule[] = [
			{ model: "%claude-opus-4%", input_price: 15.0, output_price: 75.0 },
		];
		syncCostPricing(db, rules);

		const row = db
			.prepare("SELECT * FROM v_adjusted_costs WHERE session_id = 's1'")
			.get() as Record<string, unknown>;

		// All token counts are 0, so all terms in the formula are 0.
		expect(row.adjusted_cost).toBeCloseTo(0, 10);
		expect(row.original_cost).toBeCloseTo(0.5, 10);
		expect(row.cost_difference).toBeCloseTo(-0.5, 10);
	});
});
