// SPDX-License-Identifier: Apache-2.0

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { initDatabase } from "./db";
import {
	backfillAllPermissionMetadata,
	cleanupExpiredPermissionEvents,
	MS_PER_DAY,
	PermissionRetention,
	PermissionStore,
} from "./permission-store";

/** Row shape returned by the permission event queries. */
interface EventRow {
	permission_id: string;
	session_id: string;
	project_id: string | null;
	agent: string | null;
	model: string | null;
	action: string;
	resource: string | null;
	resource_hash: string | null;
	raw_resource: string | null;
	reply: string | null;
	asked_at: number | null;
	replied_at: number | null;
	wait_ms: number | null;
	source_tool: string | null;
	source_message_id: string | null;
	save_patterns: string | null;
	save_reusable: number | null;
	contract_version: number;
}

describe("PermissionStore", () => {
	let tempDir: string;
	let db: Database;
	let store: PermissionStore;

	beforeEach(() => {
		tempDir = mkdtempSync(path.join(tmpdir(), "ocm-permission-store-"));
		db = initDatabase(tempDir).db;
		db.run(
			`INSERT INTO sessions (session_id, project_id, agent, model, started_at)
			 VALUES ('sess-1', 'proj-1', 'build', 'opus', 1700000000000)`,
		);
		store = new PermissionStore({ db, projectDirectory: "/repo" });
	});

	afterEach(() => {
		try {
			db.close();
		} catch {
			// already closed
		}
		rmSync(tempDir, { recursive: true, force: true });
	});

	function readEvent(permissionID: string): EventRow | null {
		return db
			.prepare("SELECT * FROM permission_events WHERE permission_id = ?")
			.get(permissionID) as EventRow | null;
	}

	it("records an asked event with canonical resource and hash", () => {
		const recorded = store.recordAsked({
			sessionID: "sess-1",
			permissionID: "perm-1",
			action: "shell",
			resources: ["git push origin feature/secret"],
			source: { type: "tool", messageID: "msg-1", id: "tool-1" },
			timestamp: 1000,
		});

		expect(recorded).toBe(true);
		const row = readEvent("perm-1");
		expect(row?.action).toBe("shell");
		expect(row?.resource).toBe("git push");
		expect(row?.resource_hash).toHaveLength(32);
		expect(row?.raw_resource).toBeNull();
		expect(row?.project_id).toBe("proj-1");
		expect(row?.agent).toBe("build");
		expect(row?.model).toBe("opus");
		expect(row?.reply).toBeNull();
		expect(row?.asked_at).toBe(1000);
		expect(row?.replied_at).toBeNull();
		expect(row?.wait_ms).toBeNull();
		expect(row?.source_tool).toBe("tool");
		expect(row?.source_message_id).toBe("msg-1");
		expect(row?.contract_version).toBe(1);
	});

	it("applies a replied event with wait duration", () => {
		store.recordAsked({
			sessionID: "sess-1",
			permissionID: "perm-1",
			action: "shell",
			resources: ["git status"],
			timestamp: 1000,
		});

		const recorded = store.recordReplied({
			sessionID: "sess-1",
			permissionID: "perm-1",
			reply: "once",
			timestamp: 3500,
		});

		expect(recorded).toBe(true);
		const row = readEvent("perm-1");
		expect(row?.reply).toBe("once");
		expect(row?.replied_at).toBe(3500);
		expect(row?.wait_ms).toBe(2500);
	});

	it("deduplicates repeated asks without resetting the reply", () => {
		store.recordAsked({
			sessionID: "sess-1",
			permissionID: "perm-1",
			action: "shell",
			resources: ["git status"],
			timestamp: 1000,
		});
		store.recordReplied({
			sessionID: "sess-1",
			permissionID: "perm-1",
			reply: "always",
			timestamp: 2000,
		});
		store.recordAsked({
			sessionID: "sess-1",
			permissionID: "perm-1",
			action: "shell",
			resources: ["git diff"],
			timestamp: 9000,
		});

		const count = db
			.prepare("SELECT COUNT(*) AS count FROM permission_events WHERE permission_id = 'perm-1'")
			.get() as { count: number };
		expect(count.count).toBe(1);

		const row = readEvent("perm-1");
		expect(row?.asked_at).toBe(1000);
		expect(row?.reply).toBe("always");
		expect(row?.replied_at).toBe(2000);
		expect(row?.resource).toBe("git status");
	});

	it("ignores an orphan reply without creating a row", () => {
		const recorded = store.recordReplied({
			sessionID: "sess-1",
			permissionID: "perm-missing",
			reply: "once",
			timestamp: 2000,
		});

		expect(recorded).toBe(false);
		expect(readEvent("perm-missing")).toBeNull();
	});

	it("ignores a reply for a different session", () => {
		store.recordAsked({
			sessionID: "sess-1",
			permissionID: "perm-1",
			action: "shell",
			resources: ["git status"],
			timestamp: 1000,
		});

		expect(
			store.recordReplied({
				sessionID: "sess-other",
				permissionID: "perm-1",
				reply: "once",
				timestamp: 2000,
			}),
		).toBe(false);
		expect(readEvent("perm-1")?.reply).toBeNull();
	});

	it("supports a late reply", () => {
		store.recordAsked({
			sessionID: "sess-1",
			permissionID: "perm-1",
			action: "shell",
			resources: ["git status"],
			timestamp: 1000,
		});
		store.recordReplied({
			sessionID: "sess-1",
			permissionID: "perm-1",
			reply: "reject",
			timestamp: 1000 + 3 * MS_PER_DAY,
		});

		const row = readEvent("perm-1");
		expect(row?.reply).toBe("reject");
		expect(row?.wait_ms).toBe(3 * MS_PER_DAY);
	});

	it("fills null metadata when the session row appears before the reply", () => {
		store.recordAsked({
			sessionID: "sess-late",
			permissionID: "perm-late",
			action: "shell",
			resources: ["git status"],
			timestamp: 1000,
		});
		expect(readEvent("perm-late")?.project_id).toBeNull();

		db.run(
			`INSERT INTO sessions (session_id, project_id, agent, model, started_at)
			 VALUES ('sess-late', 'proj-late', 'plan', 'model-late', 900)`,
		);
		expect(
			store.recordReplied({
				sessionID: "sess-late",
				permissionID: "perm-late",
				reply: "once",
				timestamp: 2000,
			}),
		).toBe(true);

		const row = readEvent("perm-late");
		expect(row?.project_id).toBe("proj-late");
		expect(row?.agent).toBe("plan");
		expect(row?.model).toBe("model-late");
	});

	it("backfills all missing metadata from stored sessions", () => {
		store.recordAsked({
			sessionID: "sess-a",
			permissionID: "perm-a",
			action: "shell",
			resources: ["git status"],
			timestamp: 1000,
		});
		store.recordAsked({
			sessionID: "sess-b",
			permissionID: "perm-b",
			action: "shell",
			resources: ["git diff"],
			timestamp: 1000,
		});
		db.run(
			`INSERT INTO sessions (session_id, project_id, agent, model, started_at)
			 VALUES ('sess-a', 'proj-a', 'build', 'model-a', 900),
				('sess-b', 'proj-b', 'explore', 'model-b', 900)`,
		);

		expect(backfillAllPermissionMetadata(db)).toBe(2);
		expect(readEvent("perm-a")?.project_id).toBe("proj-a");
		expect(readEvent("perm-a")?.agent).toBe("build");
		expect(readEvent("perm-b")?.project_id).toBe("proj-b");
		expect(readEvent("perm-b")?.model).toBe("model-b");
	});

	it("persists always-reply save patterns separately from the resource", () => {
		store.recordAsked({
			sessionID: "sess-1",
			permissionID: "perm-1",
			action: "shell",
			resources: ["git push origin main"],
			save: ["git push *"],
			timestamp: 1000,
		});
		store.recordReplied({
			sessionID: "sess-1",
			permissionID: "perm-1",
			reply: "always",
			timestamp: 2000,
		});

		const row = readEvent("perm-1");
		expect(row?.resource).toBe("git push");
		expect(JSON.parse(row?.save_patterns ?? "[]")).toEqual(["git push *"]);
		expect(row?.save_reusable).toBe(1);
	});

	it("flags non-reusable save patterns", () => {
		store.recordAsked({
			sessionID: "sess-1",
			permissionID: "perm-1",
			action: "shell",
			resources: ["git status"],
			save: ["$cmd *"],
			timestamp: 1000,
		});
		store.recordReplied({
			sessionID: "sess-1",
			permissionID: "perm-1",
			reply: "always",
			timestamp: 2000,
		});

		const row = readEvent("perm-1");
		expect(row?.save_reusable).toBe(0);
	});

	it("does not persist save patterns for non-always replies", () => {
		store.recordAsked({
			sessionID: "sess-1",
			permissionID: "perm-1",
			action: "shell",
			resources: ["git status"],
			save: ["git status"],
			timestamp: 1000,
		});
		store.recordReplied({
			sessionID: "sess-1",
			permissionID: "perm-1",
			reply: "once",
			timestamp: 2000,
		});

		expect(readEvent("perm-1")?.save_patterns).toBeNull();
	});

	it("stores redacted raw resources only when opted in", () => {
		const rawStore = new PermissionStore({ db, projectDirectory: "/repo", storeRaw: true });
		rawStore.recordAsked({
			sessionID: "sess-1",
			permissionID: "perm-raw",
			action: "shell",
			resources: ["deploy --token=supersecretvalue"],
			timestamp: 1000,
		});

		const row = readEvent("perm-raw");
		expect(row?.raw_resource).not.toBeNull();
		expect(row?.raw_resource).not.toContain("supersecretvalue");
	});

	it("reports unavailable when the permission table is missing", () => {
		const bare = new Database(":memory:");
		try {
			bare.run("CREATE TABLE sessions (session_id TEXT PRIMARY KEY)");
			const bareStore = new PermissionStore({ db: bare });
			expect(bareStore.isAvailable()).toBe(false);
			expect(
				bareStore.recordAsked({
					sessionID: "sess-1",
					permissionID: "perm-1",
					action: "shell",
					resources: ["git status"],
					timestamp: 1000,
				}),
			).toBe(false);
		} finally {
			bare.close();
		}
	});

	it("throws from a closed database so callers can fail open", () => {
		store.recordAsked({
			sessionID: "sess-1",
			permissionID: "perm-1",
			action: "shell",
			resources: ["git status"],
			timestamp: 1000,
		});
		db.close();

		expect(() =>
			store.recordAsked({
				sessionID: "sess-1",
				permissionID: "perm-2",
				action: "shell",
				resources: ["git diff"],
				timestamp: 1000,
			}),
		).toThrow();
	});
});

describe("permission retention", () => {
	let tempDir: string;
	let db: Database;

	beforeEach(() => {
		tempDir = mkdtempSync(path.join(tmpdir(), "ocm-permission-retention-"));
		db = initDatabase(tempDir).db;
	});

	afterEach(() => {
		try {
			db.close();
		} catch {
			// already closed
		}
		rmSync(tempDir, { recursive: true, force: true });
	});

	function insertEvent(permissionID: string, askedAt: number): void {
		db.run(
			`INSERT INTO permission_events (permission_id, session_id, action, asked_at, contract_version)
			 VALUES (?, 'sess-1', 'shell', ?, 1)`,
			[permissionID, askedAt],
		);
	}

	it("removes expired events and leaves session measurements intact", () => {
		const now = 200 * MS_PER_DAY;
		insertEvent("perm-old", now - 100 * MS_PER_DAY);
		insertEvent("perm-new", now - 1 * MS_PER_DAY);
		db.run(
			`INSERT INTO measurements (session_id, metric_name, value, recorded_at)
			 VALUES ('sess-1', 'cost', 1.0, ?)`,
			[now - 100 * MS_PER_DAY],
		);

		const removed = cleanupExpiredPermissionEvents(db, 90, now);

		expect(removed).toBe(1);
		const remaining = db.prepare("SELECT permission_id FROM permission_events").all() as Array<{
			permission_id: string;
		}>;
		expect(remaining.map((row) => row.permission_id)).toEqual(["perm-new"]);

		const measurement = db.prepare("SELECT COUNT(*) AS count FROM measurements").get() as {
			count: number;
		};
		expect(measurement.count).toBe(1);
	});

	it("runs at most once per day", () => {
		let now = 200 * MS_PER_DAY;
		insertEvent("perm-old-1", now - 100 * MS_PER_DAY);
		const retention = new PermissionRetention(db, 90, () => now);

		expect(retention.maybeRun()).toBe(1);
		insertEvent("perm-old-2", now - 100 * MS_PER_DAY);
		expect(retention.maybeRun()).toBe(0);

		now += MS_PER_DAY;
		expect(retention.maybeRun()).toBe(1);
	});

	it("never removes events when retention is invalid", () => {
		insertEvent("perm-old", 0);
		expect(cleanupExpiredPermissionEvents(db, 0, 200 * MS_PER_DAY)).toBe(0);
		expect(cleanupExpiredPermissionEvents(db, Number.NaN, 200 * MS_PER_DAY)).toBe(0);
	});
});
