// SPDX-License-Identifier: Apache-2.0

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { initDatabase } from "./db";
import type { MetricRecord, ProjectRecord, SessionRecord } from "./writer";
import {
	MONOTONIC_METRICS,
	upsertArtifacts,
	upsertProject,
	upsertSession,
	withRetry,
	writeMetrics,
	writeSessionData,
} from "./writer";

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
		budget_tag: null,
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

		it("does not overwrite a valid name with 'unknown'", () => {
			upsertProject(db, makeProject({ name: "real-project" }));
			upsertProject(db, makeProject({ name: "unknown", worktree: "/updated/path" }));

			const row = db.prepare("SELECT * FROM projects WHERE project_id = ?").get("proj-001") as {
				name: string;
				worktree: string;
			};

			expect(row.name).toBe("real-project");
			expect(row.worktree).toBe("/updated/path");
		});

		it("allows overwriting 'unknown' with a valid name", () => {
			upsertProject(db, makeProject({ name: "unknown" }));
			upsertProject(db, makeProject({ name: "resolved-project" }));

			const row = db.prepare("SELECT * FROM projects WHERE project_id = ?").get("proj-001") as {
				name: string;
			};

			expect(row.name).toBe("resolved-project");
		});

		it("allows overwriting 'unknown' with 'unknown' (no-op)", () => {
			upsertProject(db, makeProject({ name: "unknown" }));
			upsertProject(db, makeProject({ name: "unknown" }));

			const row = db.prepare("SELECT * FROM projects WHERE project_id = ?").get("proj-001") as {
				name: string;
			};

			expect(row.name).toBe("unknown");
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

		it("writes session with budget_tag correctly", () => {
			upsertSession(db, makeSession({ budget_tag: "infra" }));

			const row = db.prepare("SELECT * FROM sessions WHERE session_id = ?").get("sess-001") as {
				budget_tag: string | null;
			};

			expect(row.budget_tag).toBe("infra");
		});

		it("writes session with null budget_tag correctly", () => {
			upsertSession(db, makeSession({ budget_tag: null }));

			const row = db.prepare("SELECT * FROM sessions WHERE session_id = ?").get("sess-001") as {
				budget_tag: string | null;
			};

			expect(row.budget_tag).toBeNull();
		});

		it("updates budget_tag on re-upsert", () => {
			upsertSession(db, makeSession({ budget_tag: null }));

			// Verify initially null.
			const row1 = db
				.prepare("SELECT budget_tag FROM sessions WHERE session_id = ?")
				.get("sess-001") as {
				budget_tag: string | null;
			};
			expect(row1.budget_tag).toBeNull();

			// Re-upsert with a budget tag.
			upsertSession(db, makeSession({ budget_tag: "frontend" }));

			const row2 = db
				.prepare("SELECT budget_tag FROM sessions WHERE session_id = ?")
				.get("sess-001") as {
				budget_tag: string | null;
			};
			expect(row2.budget_tag).toBe("frontend");

			// Re-upsert back to null.
			upsertSession(db, makeSession({ budget_tag: null }));

			const row3 = db
				.prepare("SELECT budget_tag FROM sessions WHERE session_id = ?")
				.get("sess-001") as {
				budget_tag: string | null;
			};
			expect(row3.budget_tag).toBeNull();
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

	describe("upsertArtifacts", () => {
		it("inserts artifact rows with correct columns", () => {
			upsertArtifacts(
				db,
				"sess-001",
				[{ artifact_type: "pr-created", reference: "org/repo#42" }],
				1700003600000,
			);

			const row = db
				.prepare("SELECT * FROM session_artifacts WHERE session_id = ?")
				.get("sess-001") as {
				session_id: string;
				artifact_type: string;
				reference: string;
				recorded_at: number;
			};

			expect(row.session_id).toBe("sess-001");
			expect(row.artifact_type).toBe("pr-created");
			expect(row.reference).toBe("org/repo#42");
			expect(row.recorded_at).toBe(1700003600000);
		});

		it("duplicate PK produces one row (OR IGNORE)", () => {
			upsertArtifacts(
				db,
				"sess-001",
				[{ artifact_type: "pr-created", reference: "org/repo#42" }],
				1700003600000,
			);
			upsertArtifacts(
				db,
				"sess-001",
				[{ artifact_type: "pr-created", reference: "org/repo#42" }],
				1700003600001,
			);

			const count = db
				.prepare("SELECT COUNT(*) AS count FROM session_artifacts WHERE session_id = ?")
				.get("sess-001") as { count: number };
			expect(count.count).toBe(1);
		});

		it("handles multiple artifacts in a single call", () => {
			upsertArtifacts(
				db,
				"sess-001",
				[
					{ artifact_type: "pr-created", reference: "org/repo#1" },
					{ artifact_type: "pr-reviewed", reference: "org/repo#2" },
					{ artifact_type: "issue-referenced", reference: "org/repo#3" },
				],
				1700003600000,
			);

			const rows = db
				.prepare("SELECT * FROM session_artifacts WHERE session_id = ? ORDER BY reference")
				.all("sess-001") as Array<{ artifact_type: string; reference: string }>;

			expect(rows.length).toBe(3);
			expect(rows[0].artifact_type).toBe("pr-created");
			expect(rows[1].artifact_type).toBe("pr-reviewed");
			expect(rows[2].artifact_type).toBe("issue-referenced");
		});

		it("participates in transaction (rollback removes artifact rows)", () => {
			const brokenTransaction = db.transaction(() => {
				upsertProject(db, makeProject({ project_id: "proj-fail" }));
				upsertSession(db, makeSession({ session_id: "sess-fail" }));
				upsertArtifacts(
					db,
					"sess-fail",
					[{ artifact_type: "pr-created", reference: "org/repo#1" }],
					1700003600000,
				);
				throw new Error("simulated failure after artifacts");
			});

			expect(() => brokenTransaction()).toThrow("simulated failure after artifacts");

			// Artifact rows from the failed transaction must not exist.
			const artifactRow = db
				.prepare("SELECT COUNT(*) AS count FROM session_artifacts WHERE session_id = ?")
				.get("sess-fail") as { count: number };
			expect(artifactRow.count).toBe(0);

			// Session from the failed transaction must not exist either.
			const sessionRow = db
				.prepare("SELECT COUNT(*) AS count FROM sessions WHERE session_id = ?")
				.get("sess-fail") as { count: number };
			expect(sessionRow.count).toBe(0);
		});
	});

	describe("writeMetrics delta tracking", () => {
		it("first write creates a delta row equal to the full value", () => {
			writeMetrics(db, "sess-001", [
				{ metric_name: "cost", value: 0.42, recorded_at: 1700000000000 },
			]);

			const deltas = db
				.prepare("SELECT delta FROM measurement_deltas WHERE session_id = ? AND metric_name = ?")
				.all("sess-001", "cost") as Array<{ delta: number }>;

			expect(deltas.length).toBe(1);
			expect(deltas[0].delta).toBeCloseTo(0.42);
		});

		it("second write creates a delta row with the difference", () => {
			writeMetrics(db, "sess-001", [
				{ metric_name: "cost", value: 0.42, recorded_at: 1700000000000 },
			]);
			writeMetrics(db, "sess-001", [
				{ metric_name: "cost", value: 1.0, recorded_at: 1700001000000 },
			]);

			const deltas = db
				.prepare(
					"SELECT delta FROM measurement_deltas WHERE session_id = ? AND metric_name = ? ORDER BY recorded_at",
				)
				.all("sess-001", "cost") as Array<{ delta: number }>;

			expect(deltas.length).toBe(2);
			expect(deltas[0].delta).toBeCloseTo(0.42);
			expect(deltas[1].delta).toBeCloseTo(0.58);
		});

		it("write with unchanged value creates no delta row (zero skipped)", () => {
			writeMetrics(db, "sess-001", [
				{ metric_name: "cost", value: 0.42, recorded_at: 1700000000000 },
			]);
			writeMetrics(db, "sess-001", [
				{ metric_name: "cost", value: 0.42, recorded_at: 1700001000000 },
			]);

			const deltas = db
				.prepare("SELECT delta FROM measurement_deltas WHERE session_id = ? AND metric_name = ?")
				.all("sess-001", "cost") as Array<{ delta: number }>;

			// Only the first write should produce a delta row.
			expect(deltas.length).toBe(1);
		});

		it("SUM(delta) equals the final cumulative value after multiple updates", () => {
			const values = [0.1, 0.3, 0.3, 0.75, 1.0];
			for (let i = 0; i < values.length; i++) {
				writeMetrics(db, "sess-001", [
					{ metric_name: "cost", value: values[i], recorded_at: 1700000000000 + i * 1000 },
				]);
			}

			const sumRow = db
				.prepare(
					"SELECT SUM(delta) AS total FROM measurement_deltas WHERE session_id = ? AND metric_name = ?",
				)
				.get("sess-001", "cost") as { total: number };

			const measurementRow = db
				.prepare("SELECT value FROM measurements WHERE session_id = ? AND metric_name = ?")
				.get("sess-001", "cost") as { value: number };

			expect(sumRow.total).toBeCloseTo(1.0);
			expect(measurementRow.value).toBeCloseTo(1.0);
		});

		it("negative delta is recorded correctly for non-monotonic metrics (value decreases)", () => {
			writeMetrics(db, "sess-001", [
				{ metric_name: "files_changed", value: 5, recorded_at: 1700000000000 },
			]);
			writeMetrics(db, "sess-001", [
				{ metric_name: "files_changed", value: 3, recorded_at: 1700001000000 },
			]);

			const deltas = db
				.prepare(
					"SELECT delta FROM measurement_deltas WHERE session_id = ? AND metric_name = ? ORDER BY recorded_at",
				)
				.all("sess-001", "files_changed") as Array<{ delta: number }>;

			expect(deltas.length).toBe(2);
			expect(deltas[0].delta).toBe(5);
			expect(deltas[1].delta).toBe(-2);

			// Cumulative should reflect the lower value for non-monotonic metrics.
			const cumulative = db
				.prepare("SELECT value FROM measurements WHERE session_id = ? AND metric_name = ?")
				.get("sess-001", "files_changed") as { value: number };
			expect(cumulative.value).toBe(3);
		});

		it("monotonic metric skips negative delta and preserves high-water mark", () => {
			// Simulate: cost goes up to 5.0, then compaction drops it to 3.0.
			writeMetrics(db, "sess-001", [
				{ metric_name: "cost", value: 5.0, recorded_at: 1700000000000 },
			]);
			writeMetrics(db, "sess-001", [
				{ metric_name: "cost", value: 3.0, recorded_at: 1700001000000 },
			]);

			// No negative delta should be recorded.
			const deltas = db
				.prepare(
					"SELECT delta FROM measurement_deltas WHERE session_id = ? AND metric_name = ? ORDER BY recorded_at",
				)
				.all("sess-001", "cost") as Array<{ delta: number }>;

			expect(deltas.length).toBe(1);
			expect(deltas[0].delta).toBeCloseTo(5.0);

			// Cumulative should retain the high-water mark, NOT the lower value.
			const cumulative = db
				.prepare("SELECT value FROM measurements WHERE session_id = ? AND metric_name = ?")
				.get("sess-001", "cost") as { value: number };
			expect(cumulative.value).toBeCloseTo(5.0);
		});

		it("monotonic metric recovers correctly after compaction", () => {
			// Simulate: cost 5.0 → compaction drops to 3.0 → real growth to 7.0
			writeMetrics(db, "sess-001", [
				{ metric_name: "cost", value: 5.0, recorded_at: 1700000000000 },
			]);
			writeMetrics(db, "sess-001", [
				{ metric_name: "cost", value: 3.0, recorded_at: 1700001000000 },
			]);
			writeMetrics(db, "sess-001", [
				{ metric_name: "cost", value: 7.0, recorded_at: 1700002000000 },
			]);

			const deltas = db
				.prepare(
					"SELECT delta FROM measurement_deltas WHERE session_id = ? AND metric_name = ? ORDER BY recorded_at",
				)
				.all("sess-001", "cost") as Array<{ delta: number }>;

			// First delta: 5.0 (initial). Second: skipped (negative).
			// Third: 7.0 - 5.0 = 2.0 (delta from high-water mark, not from 3.0).
			expect(deltas.length).toBe(2);
			expect(deltas[0].delta).toBeCloseTo(5.0);
			expect(deltas[1].delta).toBeCloseTo(2.0);

			// SUM(deltas) should equal the final cumulative value.
			const sumRow = db
				.prepare(
					"SELECT SUM(delta) AS total FROM measurement_deltas WHERE session_id = ? AND metric_name = ?",
				)
				.get("sess-001", "cost") as { total: number };
			expect(sumRow.total).toBeCloseTo(7.0);

			const cumulative = db
				.prepare("SELECT value FROM measurements WHERE session_id = ? AND metric_name = ?")
				.get("sess-001", "cost") as { value: number };
			expect(cumulative.value).toBeCloseTo(7.0);
		});

		it("files_changed is NOT in the monotonic set", () => {
			expect(MONOTONIC_METRICS.has("files_changed")).toBe(false);
			expect(MONOTONIC_METRICS.has("lines_added")).toBe(false);
			expect(MONOTONIC_METRICS.has("lines_deleted")).toBe(false);
			expect(MONOTONIC_METRICS.has("cache_hit_ratio")).toBe(false);
		});

		it("cost IS in the monotonic set", () => {
			expect(MONOTONIC_METRICS.has("cost")).toBe(true);
			expect(MONOTONIC_METRICS.has("tokens_input")).toBe(true);
			expect(MONOTONIC_METRICS.has("messages_total")).toBe(true);
		});

		it("multiple metrics in a single writeMetrics() call each get their own delta rows", () => {
			writeMetrics(db, "sess-001", [
				{ metric_name: "cost", value: 0.42, recorded_at: 1700000000000 },
				{ metric_name: "tokens_input", value: 1500, recorded_at: 1700000000000 },
			]);

			const costDeltas = db
				.prepare("SELECT delta FROM measurement_deltas WHERE session_id = ? AND metric_name = ?")
				.all("sess-001", "cost") as Array<{ delta: number }>;

			const tokenDeltas = db
				.prepare("SELECT delta FROM measurement_deltas WHERE session_id = ? AND metric_name = ?")
				.all("sess-001", "tokens_input") as Array<{ delta: number }>;

			expect(costDeltas.length).toBe(1);
			expect(costDeltas[0].delta).toBeCloseTo(0.42);
			expect(tokenDeltas.length).toBe(1);
			expect(tokenDeltas[0].delta).toBe(1500);
		});

		it("delta rows are rolled back when the enclosing transaction fails", () => {
			const brokenTransaction = db.transaction(() => {
				writeMetrics(db, "sess-rollback", [
					{ metric_name: "cost", value: 0.42, recorded_at: 1700000000000 },
				]);
				throw new Error("simulated failure");
			});

			expect(() => brokenTransaction()).toThrow("simulated failure");

			const deltas = db
				.prepare("SELECT COUNT(*) AS count FROM measurement_deltas WHERE session_id = ?")
				.get("sess-rollback") as { count: number };

			expect(deltas.count).toBe(0);

			const measurements = db
				.prepare("SELECT COUNT(*) AS count FROM measurements WHERE session_id = ?")
				.get("sess-rollback") as { count: number };

			expect(measurements.count).toBe(0);
		});

		it("5-step invariant: individual deltas and SUM match expectations", () => {
			const values = [0.1, 0.3, 0.3, 0.75, 1.0];
			for (let i = 0; i < values.length; i++) {
				writeMetrics(db, "sess-invariant", [
					{ metric_name: "cost", value: values[i], recorded_at: 1700000000000 + i * 1000 },
				]);
			}

			const deltas = db
				.prepare(
					"SELECT delta FROM measurement_deltas WHERE session_id = ? AND metric_name = ? ORDER BY recorded_at",
				)
				.all("sess-invariant", "cost") as Array<{ delta: number }>;

			// Expected deltas: 0.10, 0.20, (skipped: 0.30→0.30 = 0), 0.45, 0.25
			expect(deltas.length).toBe(4);
			expect(deltas[0].delta).toBeCloseTo(0.1);
			expect(deltas[1].delta).toBeCloseTo(0.2);
			expect(deltas[2].delta).toBeCloseTo(0.45);
			expect(deltas[3].delta).toBeCloseTo(0.25);

			// SUM(delta) must equal the final cumulative value.
			const sumRow = db
				.prepare(
					"SELECT SUM(delta) AS total FROM measurement_deltas WHERE session_id = ? AND metric_name = ?",
				)
				.get("sess-invariant", "cost") as { total: number };
			expect(sumRow.total).toBeCloseTo(1.0);

			// measurements.value must equal the final cumulative value.
			const measurementRow = db
				.prepare("SELECT value FROM measurements WHERE session_id = ? AND metric_name = ?")
				.get("sess-invariant", "cost") as { value: number };
			expect(measurementRow.value).toBeCloseTo(1.0);
		});

		it("skipDeltas option prevents delta row creation", () => {
			writeMetrics(
				db,
				"sess-nodelete",
				[
					{ metric_name: "cost", value: 5.0, recorded_at: 1700000000000 },
					{ metric_name: "tokens_input", value: 1000, recorded_at: 1700000000000 },
				],
				{ skipDeltas: true },
			);

			// Cumulative values should be written
			const measurement = db
				.prepare("SELECT value FROM measurements WHERE session_id = ? AND metric_name = ?")
				.get("sess-nodelete", "cost") as { value: number };
			expect(measurement.value).toBe(5.0);

			// No delta rows should exist
			const deltas = db
				.prepare("SELECT COUNT(*) as count FROM measurement_deltas WHERE session_id = ?")
				.get("sess-nodelete") as { count: number };
			expect(deltas.count).toBe(0);
		});

		it("skipDeltas still allows subsequent live deltas", () => {
			// Backfill with skipDeltas
			writeMetrics(
				db,
				"sess-hybrid",
				[{ metric_name: "cost", value: 5.0, recorded_at: 1700000000000 }],
				{ skipDeltas: true },
			);

			// Subsequent live write without skipDeltas
			writeMetrics(db, "sess-hybrid", [
				{ metric_name: "cost", value: 7.5, recorded_at: 1700003600000 },
			]);

			// Should have one delta row: 7.5 - 5.0 = 2.5
			const deltas = db
				.prepare("SELECT delta FROM measurement_deltas WHERE session_id = ? AND metric_name = ?")
				.all("sess-hybrid", "cost") as Array<{ delta: number }>;
			expect(deltas.length).toBe(1);
			expect(deltas[0].delta).toBeCloseTo(2.5);
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
