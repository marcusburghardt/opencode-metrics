// SPDX-License-Identifier: Apache-2.0

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { initDatabase } from "./db";

/** Helper tables expected in the v1 schema. */
const EXPECTED_TABLES = ["projects", "sessions", "metric_definitions", "measurements"];

/** Helper indexes expected in the v1 schema. */
const EXPECTED_INDEXES = ["idx_measurements_time", "idx_measurements_metric"];

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
});
