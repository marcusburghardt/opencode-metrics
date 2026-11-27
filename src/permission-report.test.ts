// SPDX-License-Identifier: Apache-2.0

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { initDatabase } from "./db";
import {
	buildPermissionReport,
	generatePermissionReport,
	resolveDatabasePath,
} from "./permission-report";
import { MS_PER_DAY } from "./permission-store";

describe("permission report", () => {
	let tempDir: string;
	let db: Database;
	let databasePath: string;
	const now = Date.UTC(2026, 0, 10, 12, 0, 0);

	beforeEach(() => {
		tempDir = mkdtempSync(path.join(tmpdir(), "ocm-permission-report-"));
		const initialized = initDatabase(tempDir);
		db = initialized.db;
		databasePath = path.join(tempDir, "metrics.db");

		const rows: Array<[string, string, number, number, string, number]> = [
			["perm-1", "git push", 1000, 0, "once", 100],
			["perm-2", "git push", 2000, 0, "always", 200],
			["perm-3", "git push", 3000, 0, "reject", 300],
			["perm-4", "git push", 4000, 0, "once", 400],
			["perm-5", "make test", 5000, 0, "always", null],
		];

		for (const [id, resource, offset, , reply, wait] of rows) {
			db.run(
				`INSERT INTO permission_events (
					permission_id, session_id, project_id, agent, model, action, resource,
					reply, asked_at, replied_at, wait_ms, contract_version
				 ) VALUES (?, 'sess-1', 'proj-1', 'build', 'opus', 'shell', ?, ?, ?, ?, ?, 1)`,
				[id, resource, reply, now - offset, now - offset + (wait ?? 0), wait],
			);
		}
	});

	afterEach(() => {
		try {
			db.close();
		} catch {
			// already closed
		}
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("prints the stable JSON shape with window, totals, and friction rows", () => {
		const report = buildPermissionReport(db, { days: 7, now });

		expect(report.contract_version).toBe(1);
		expect(report.generated_at).toBe("2026-01-10T12:00:00Z");
		expect(report.window).toEqual({
			days: 7,
			since: "2026-01-03T12:00:00Z",
			until: "2026-01-10T12:00:00Z",
		});
		expect(report.project).toBeNull();
		expect(report.totals).toEqual({
			prompts: 5,
			always: 2,
			reject: 1,
			median_wait_ms: 250,
			p95_wait_ms: 400,
		});

		const gitPush = report.friction.find((row) => row.resource === "git push");
		expect(gitPush).toBeDefined();
		expect(gitPush?.prompt_count).toBe(4);
		expect(gitPush?.median_wait_ms).toBe(250);
		expect(gitPush?.p95_wait_ms).toBe(400);
		expect(gitPush?.always_count).toBe(1);
		expect(gitPush?.reject_count).toBe(1);
		expect(gitPush?.agent).toBe("build");
		expect(gitPush?.model).toBe("opus");
		expect(gitPush?.first_seen).toBe("2026-01-10T11:59:56Z");
		expect(gitPush?.last_seen).toBe("2026-01-10T11:59:59Z");
	});

	it("returns no rows for an empty window", () => {
		const report = buildPermissionReport(db, { days: 1, now: now + 30 * MS_PER_DAY });

		expect(report.friction).toEqual([]);
		expect(report.totals.prompts).toBe(0);
		expect(report.totals.median_wait_ms).toBeNull();
	});

	it("filters by project", () => {
		const matching = buildPermissionReport(db, { days: 7, project: "proj-1", now });
		const missing = buildPermissionReport(db, { days: 7, project: "proj-other", now });

		expect(matching.totals.prompts).toBe(5);
		expect(missing.totals.prompts).toBe(0);
	});

	it("rejects an invalid window", () => {
		expect(() => buildPermissionReport(db, { days: 0, now })).toThrow();
		expect(() => buildPermissionReport(db, { days: 1.5, now })).toThrow();
	});

	it("opens the database read-only and leaves rows untouched", () => {
		db.close();

		const report = generatePermissionReport({ databasePath, days: 7, now });
		expect(report.totals.prompts).toBe(5);

		const reopened = new Database(databasePath, { readonly: true });
		try {
			const count = reopened.prepare("SELECT COUNT(*) AS count FROM permission_events").get() as {
				count: number;
			};
			expect(count.count).toBe(5);
		} finally {
			reopened.close();
		}
	});

	it("fails clearly when the database lacks the permission tables", () => {
		const barePath = path.join(tempDir, "bare.db");
		const bare = new Database(barePath, { create: true });
		bare.close();

		expect(() => generatePermissionReport({ databasePath: barePath, now })).toThrow(
			/permission capture is not available/,
		);
	});

	it("resolves the default database path from the data directory", () => {
		expect(resolveDatabasePath()).toContain("opencode-metrics");
		expect(resolveDatabasePath("/custom/metrics.db")).toBe("/custom/metrics.db");
	});
});
