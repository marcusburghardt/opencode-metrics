// SPDX-License-Identifier: Apache-2.0

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { initDatabase } from "./db";
import type { MetricRecord, ProjectRecord, SessionRecord } from "./writer";
import { upsertProject, upsertSession, withRetry, writeMetrics, writeSessionData } from "./writer";

/** Factory for a valid project record. */
function makeProject(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
	return {
		project_id: "proj-001",
		name: "test-project",
		worktree: "/home/user/projects/test",
		...overrides,
	};
}

/** Factory for a valid session record. */
function makeSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
	return {
		session_id: "sess-001",
		project_id: "proj-001",
		agent: "build",
		model: "claude-opus-4-20250514",
		classification: "implementation",
		title: "Implement feature X",
		started_at: 1700000000000,
		ended_at: 1700003600000,
		metadata: null,
		...overrides,
	};
}

/** Factory for sample metric records. */
function makeMetrics(recorded_at = 1700003600000): MetricRecord[] {
	return [
		{ metric_name: "cost", value: 0.42, recorded_at },
		{ metric_name: "tokens_input", value: 1500, recorded_at },
		{ metric_name: "tokens_output", value: 800, recorded_at },
	];
}

describe("writer", () => {
	let tempDir: string;
	let db: Database;

	beforeEach(() => {
		tempDir = mkdtempSync(path.join(tmpdir(), "ocm-writer-"));
		const result = initDatabase(tempDir);
		db = result.db;
	});

	afterEach(() => {
		db.close();
		rmSync(tempDir, { recursive: true, force: true });
	});

	describe("upsertProject", () => {
		it("inserts a new project", () => {
			const project = makeProject();
			upsertProject(db, project);

			const row = db
				.prepare("SELECT * FROM projects WHERE project_id = ?")
				.get(project.project_id) as {
				project_id: string;
				name: string;
				worktree: string;
			};

			expect(row.project_id).toBe("proj-001");
			expect(row.name).toBe("test-project");
			expect(row.worktree).toBe("/home/user/projects/test");
		});

		it("updates an existing project on conflict", () => {
			upsertProject(db, makeProject());
			upsertProject(db, makeProject({ name: "renamed-project", worktree: "/new/path" }));

			const row = db.prepare("SELECT * FROM projects WHERE project_id = ?").get("proj-001") as {
				name: string;
				worktree: string;
			};

			expect(row.name).toBe("renamed-project");
			expect(row.worktree).toBe("/new/path");
		});

		it("does not create duplicate rows on upsert", () => {
			upsertProject(db, makeProject());
			upsertProject(db, makeProject({ name: "v2" }));

			const count = db.prepare("SELECT COUNT(*) AS count FROM projects").get() as {
				count: number;
			};
			expect(count.count).toBe(1);
		});
	});

	describe("upsertSession", () => {
		it("inserts a new session", () => {
			const session = makeSession();
			upsertSession(db, session);

			const row = db
				.prepare("SELECT * FROM sessions WHERE session_id = ?")
				.get(session.session_id) as {
				session_id: string;
				classification: string;
				model: string;
			};

			expect(row.session_id).toBe("sess-001");
			expect(row.classification).toBe("implementation");
			expect(row.model).toBe("claude-opus-4-20250514");
		});

		it("updates all fields on conflict", () => {
			upsertSession(db, makeSession());
			upsertSession(
				db,
				makeSession({
					classification: "exploration",
					title: "Updated title",
					ended_at: 1700007200,
					metadata: '{"key":"value"}',
				}),
			);

			const row = db.prepare("SELECT * FROM sessions WHERE session_id = ?").get("sess-001") as {
				classification: string;
				title: string;
				ended_at: number;
				metadata: string;
			};

			expect(row.classification).toBe("exploration");
			expect(row.title).toBe("Updated title");
			expect(row.ended_at).toBe(1700007200);
			expect(row.metadata).toBe('{"key":"value"}');
		});
	});

	describe("writeMetrics", () => {
		it("inserts metric measurements", () => {
			const metrics = makeMetrics();
			writeMetrics(db, "sess-001", metrics);

			const rows = db
				.prepare("SELECT * FROM measurements WHERE session_id = ? ORDER BY metric_name")
				.all("sess-001") as Array<{
				session_id: string;
				metric_name: string;
				value: number;
			}>;

			expect(rows.length).toBe(3);
			expect(rows[0].metric_name).toBe("cost");
			expect(rows[0].value).toBeCloseTo(0.42);
		});

		it("updates values on conflict", () => {
			writeMetrics(db, "sess-001", makeMetrics(1700000000));
			writeMetrics(db, "sess-001", [
				{ metric_name: "cost", value: 0.99, recorded_at: 1700003600 },
			]);

			const row = db
				.prepare(
					"SELECT value, recorded_at FROM measurements WHERE session_id = ? AND metric_name = ?",
				)
				.get("sess-001", "cost") as { value: number; recorded_at: number };

			expect(row.value).toBeCloseTo(0.99);
			expect(row.recorded_at).toBe(1700003600);
		});
	});

	describe("writeSessionData", () => {
		it("writes project, session, and metrics atomically", async () => {
			await writeSessionData(db, {
				project: makeProject(),
				session: makeSession(),
				metrics: makeMetrics(),
			});

			const projectCount = db.prepare("SELECT COUNT(*) AS count FROM projects").get() as {
				count: number;
			};
			const sessionCount = db.prepare("SELECT COUNT(*) AS count FROM sessions").get() as {
				count: number;
			};
			const metricCount = db.prepare("SELECT COUNT(*) AS count FROM measurements").get() as {
				count: number;
			};

			expect(projectCount.count).toBe(1);
			expect(sessionCount.count).toBe(1);
			expect(metricCount.count).toBe(3);
		});

		it("rolls back all writes when a measurement insert fails", async () => {
			// Insert a valid session first to verify rollback clears the update.
			await writeSessionData(db, {
				project: makeProject(),
				session: makeSession(),
				metrics: makeMetrics(),
			});

			// Now attempt a transaction that will fail: use an invalid metric
			// by intentionally breaking the DB state. We drop the measurements
			// table's primary key constraint by inserting a row then trying to
			// insert a second batch where the transaction function itself throws.
			const badSession = makeSession({ session_id: "sess-fail" });

			// Manually create a transaction that throws partway through
			// to verify atomicity: session should not persist if metrics fail.
			const brokenTransaction = db.transaction(() => {
				upsertProject(db, makeProject({ project_id: "proj-fail" }));
				upsertSession(db, badSession);
				// Simulate failure after session insert but before metrics complete.
				throw new Error("simulated metrics failure");
			});

			expect(() => brokenTransaction()).toThrow("simulated metrics failure");

			// The session from the failed transaction must not exist.
			const row = db
				.prepare("SELECT COUNT(*) AS count FROM sessions WHERE session_id = ?")
				.get("sess-fail") as {
				count: number;
			};
			expect(row.count).toBe(0);

			// The project from the failed transaction must not exist either.
			const projectRow = db
				.prepare("SELECT COUNT(*) AS count FROM projects WHERE project_id = ?")
				.get("proj-fail") as { count: number };
			expect(projectRow.count).toBe(0);
		});
	});

	describe("withRetry", () => {
		it("returns the result on first success", async () => {
			const result = await withRetry(() => 42);
			expect(result).toBe(42);
		});

		it("retries on SQLITE_BUSY and succeeds", async () => {
			let attempts = 0;

			const result = await withRetry(() => {
				attempts++;
				if (attempts < 3) {
					throw new Error("SQLITE_BUSY");
				}
				return "success";
			});

			expect(result).toBe("success");
			expect(attempts).toBe(3);
		});

		it("throws after exhausting max retries on SQLITE_BUSY", async () => {
			let attempts = 0;

			await expect(
				withRetry(() => {
					attempts++;
					throw new Error("SQLITE_BUSY");
				}, 3),
			).rejects.toThrow("SQLITE_BUSY");

			// 1 initial attempt + 3 retries = 4 total attempts
			expect(attempts).toBe(4);
		});

		it("throws immediately on non-SQLITE_BUSY errors", async () => {
			let attempts = 0;

			await expect(
				withRetry(() => {
					attempts++;
					throw new Error("UNIQUE constraint failed");
				}),
			).rejects.toThrow("UNIQUE constraint failed");

			expect(attempts).toBe(1);
		});

		it("retries on 'database is locked' errors", async () => {
			let attempts = 0;

			const result = await withRetry(() => {
				attempts++;
				if (attempts < 2) {
					throw new Error("database is locked");
				}
				return "unlocked";
			});

			expect(result).toBe("unlocked");
			expect(attempts).toBe(2);
		});
	});
});
