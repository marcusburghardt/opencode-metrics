// SPDX-License-Identifier: Apache-2.0

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { initDatabase } from "./db";

/** Helper tables expected in the v1 schema. */
const EXPECTED_TABLES = [
	"projects",
	"sessions",
	"metric_definitions",
	"measurements",
	"measurement_deltas",
];

/** Helper views expected in the v1 schema. */
const EXPECTED_VIEWS = ["v_sessions", "v_measurements", "v_measurement_deltas"];

/** Helper indexes expected in the v1 schema. */
const EXPECTED_INDEXES = [
	"idx_measurements_time",
	"idx_measurements_metric",
	"idx_deltas_metric_time",
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

	it("sets user_version to 1", () => {
		const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
		expect(row.user_version).toBe(1);
	});

	it("preserves user_version on subsequent calls", () => {
		db.close();

		const first = initDatabase(tempDir);
		first.db.close();

		const second = initDatabase(tempDir);
		db = second.db;

		const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
		expect(row.user_version).toBe(1);
	});

	it("seeds 12 metric definitions", () => {
		const row = db.prepare("SELECT COUNT(*) AS count FROM metric_definitions").get() as {
			count: number;
		};
		expect(row.count).toBe(12);
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
		expect(row.count).toBe(12);
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
});
