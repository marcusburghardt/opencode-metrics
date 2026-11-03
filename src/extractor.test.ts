// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { MessageInfo, ProjectInfo, SDKClient, SessionInfo } from "./extractor";
import {
	collectSnapshotFiles,
	computeCacheHitRatio,
	computeDurationSeconds,
	deriveProjectName,
	extractSessionData,
	isUsableProjectDirectory,
} from "./extractor";

/** Factory for a mock SDKClient with configurable overrides. */
function makeClient(
	overrides: {
		session?: Partial<SessionInfo> | null;
		messages?: MessageInfo[];
		project?: Partial<ProjectInfo> | null;
		logs?: string[];
	} = {},
): SDKClient {
	const logs: string[] = overrides.logs ?? [];

	return {
		session: {
			get: async (id) =>
				overrides.session === null
					? null
					: {
							id,
							cost: 0.42,
							tokensInput: 1500,
							tokensOutput: 800,
							tokensReasoning: 200,
							tokensCacheRead: 500,
							tokensCacheWrite: 100,
							agent: "build",
							model: "claude-opus-4-20250514",
							title: "Test session",
							projectID: "proj-001",
							timeCreated: 1700000000000,
							timeUpdated: 1700003600000,
							diffStats: { filesChanged: 3, linesAdded: 50, linesDeleted: 10 },
							...overrides.session,
						},
			messages: async () =>
				overrides.messages ?? [
					{
						id: "msg-1",
						role: "user",
						parts: [{ type: "text", content: "implement feature X" }],
					},
					{
						id: "msg-2",
						role: "assistant",
						parts: [{ type: "text", content: "I'll implement feature X" }],
					},
				],
		},
		project: {
			current: async () =>
				overrides.project === null
					? null
					: {
							id: "proj-001",
							name: "test-project",
							path: "/home/user/test",
							...overrides.project,
						},
		},
		app: {
			log: (msg) => logs.push(msg),
		},
	};
}

describe("extractSessionData", () => {
	it("extracts complete session with all fields present", async () => {
		const client = makeClient();
		const result = await extractSessionData(client, "sess-001");

		expect(result).not.toBeNull();

		// Project
		expect(result?.project.project_id).toBe("proj-001");
		expect(result?.project.name).toBe("test-project");
		expect(result?.project.worktree).toBe("/home/user/test");

		// Session
		expect(result?.session.session_id).toBe("sess-001");
		expect(result?.session.project_id).toBe("proj-001");
		expect(result?.session.agent).toBe("build");
		expect(result?.session.model).toBe("claude-opus-4-20250514");
		expect(result?.session.title).toBe("Test session");
		expect(result?.session.started_at).toBe(1700000000000);
		expect(result?.session.ended_at).toBe(1700003600000);
		expect(result?.session.classification).toBe("unknown");

		// Metrics: all 15 present (12 base + 3 artifact counts)
		expect(result?.metrics.length).toBe(15);

		const costMetric = result?.metrics.find((m) => m.metric_name === "cost");
		expect(costMetric?.value).toBeCloseTo(0.42);

		const tokensInputMetric = result?.metrics.find((m) => m.metric_name === "tokens_input");
		expect(tokensInputMetric?.value).toBe(1500);

		const filesMetric = result?.metrics.find((m) => m.metric_name === "files_changed");
		expect(filesMetric?.value).toBe(3);

		const msgsMetric = result?.metrics.find((m) => m.metric_name === "messages_total");
		expect(msgsMetric?.value).toBe(2);

		// Classification context
		expect(result?.classificationContext.agent).toBe("build");
		expect(result?.classificationContext.model).toBe("claude-opus-4-20250514");
		expect(result?.classificationContext.first_user_message).toBe("implement feature X");
		expect(result?.classificationContext.message_count).toBe(2);
	});

	it("applies defaults for missing session fields", async () => {
		// Pass explicit undefined to override the factory defaults — verifies
		// that the extractor falls back to 0 / "unknown" for every missing field.
		const client = makeClient({
			session: {
				cost: undefined,
				tokensInput: undefined,
				tokensOutput: undefined,
				tokensReasoning: undefined,
				tokensCacheRead: undefined,
				tokensCacheWrite: undefined,
				agent: undefined,
				model: undefined,
				title: undefined,
				timeCreated: undefined,
				timeUpdated: undefined,
				diffStats: undefined,
			},
		});
		const result = await extractSessionData(client, "sess-002");

		expect(result).not.toBeNull();
		expect(result?.session.agent).toBe("unknown");
		expect(result?.session.model).toBe("unknown");
		expect(result?.session.title).toBe("unknown");

		const costMetric = result?.metrics.find((m) => m.metric_name === "cost");
		expect(costMetric?.value).toBe(0);

		const tokensMetric = result?.metrics.find((m) => m.metric_name === "tokens_input");
		expect(tokensMetric?.value).toBe(0);

		const durationMetric = result?.metrics.find((m) => m.metric_name === "duration_seconds");
		expect(durationMetric?.value).toBe(0);
	});

	it("handles session with zero cost", async () => {
		const client = makeClient({ session: { cost: 0 } });
		const result = await extractSessionData(client, "sess-003");

		expect(result).not.toBeNull();
		const costMetric = result?.metrics.find((m) => m.metric_name === "cost");
		expect(costMetric?.value).toBe(0);
	});

	it("handles session with zero tokens (cache_hit_ratio = 0)", async () => {
		const client = makeClient({
			session: { tokensInput: 0, tokensCacheRead: 0 },
		});
		const result = await extractSessionData(client, "sess-004");

		expect(result).not.toBeNull();
		const cacheRatio = result?.metrics.find((m) => m.metric_name === "cache_hit_ratio");
		expect(cacheRatio?.value).toBe(0);
	});

	it("handles session with missing timestamps (duration = 0)", async () => {
		const client = makeClient({
			session: { timeCreated: undefined, timeUpdated: undefined },
		});
		const result = await extractSessionData(client, "sess-005");

		expect(result).not.toBeNull();
		const duration = result?.metrics.find((m) => m.metric_name === "duration_seconds");
		expect(duration?.value).toBe(0);
	});

	it("returns null for empty session_id and logs warning", async () => {
		const logs: string[] = [];
		const client = makeClient({ logs });
		const result = await extractSessionData(client, "");

		expect(result).toBeNull();
		expect(logs.length).toBeGreaterThan(0);
		expect(logs.some((l) => l.includes("null/empty"))).toBe(true);
	});

	it("extracts bash commands from tool parts", async () => {
		const client = makeClient({
			messages: [
				{
					id: "msg-1",
					role: "user",
					parts: [{ type: "text", content: "run tests" }],
				},
				{
					id: "msg-2",
					role: "assistant",
					parts: [
						{ type: "tool", tool: "bash", args: { command: "bun test" } },
						{ type: "tool", tool: "bash", args: { command: "git status" } },
					],
				},
			],
		});
		const result = await extractSessionData(client, "sess-006");

		expect(result).not.toBeNull();
		expect(result?.classificationContext.bash_commands).toEqual(["bun test", "git status"]);
	});

	it("computes cache_hit_ratio correctly", async () => {
		const client = makeClient({
			session: { tokensCacheRead: 750, tokensInput: 250 },
		});
		const result = await extractSessionData(client, "sess-007");

		const ratio = result?.metrics.find((m) => m.metric_name === "cache_hit_ratio");
		expect(ratio?.value).toBeCloseTo(0.75);
	});

	it("computes duration_seconds correctly from timestamps", async () => {
		const client = makeClient({
			session: { timeCreated: 1700000000000, timeUpdated: 1700003600000 },
		});
		const result = await extractSessionData(client, "sess-008");

		const duration = result?.metrics.find((m) => m.metric_name === "duration_seconds");
		expect(duration?.value).toBe(3600);
	});

	it("resolves object model to modelID string", async () => {
		const client = makeClient({
			session: {
				model: { modelID: "gpt-4o", providerID: "openai" } as Record<string, unknown>,
			},
		});
		const result = await extractSessionData(client, "sess-009");

		expect(result?.session.model).toBe("gpt-4o");
		expect(result?.classificationContext.model).toBe("gpt-4o");
	});

	it("handles null project by falling back to session projectID", async () => {
		const client = makeClient({ project: null });
		const result = await extractSessionData(client, "sess-010");

		expect(result?.project.project_id).toBe("proj-001");
		expect(result?.project.name).toBe("unknown");
		expect(result?.project.worktree).toBe("unknown");
	});

	it("derives project name from worktree path when name is missing", async () => {
		const client = makeClient({
			session: { projectID: undefined },
			project: { id: "proj-derived", name: undefined, path: "/home/user/repos/my-project" },
		});
		const result = await extractSessionData(client, "sess-derive");

		expect(result?.project.project_id).toBe("proj-derived");
		expect(result?.project.name).toBe("my-project");
		expect(result?.project.worktree).toBe("/home/user/repos/my-project");
		expect(result?.classificationContext.project_name).toBe("my-project");
	});

	it("extracts part_content from all text parts", async () => {
		const client = makeClient({
			messages: [
				{
					id: "msg-1",
					role: "user",
					parts: [{ type: "text", content: "line one" }],
				},
				{
					id: "msg-2",
					role: "assistant",
					parts: [
						{ type: "text", content: "line two" },
						{ type: "text", content: "line three" },
					],
				},
			],
		});
		const result = await extractSessionData(client, "sess-011");

		expect(result?.classificationContext.part_content).toBe("line one\nline two\nline three");
	});

	it("recognizes shell-related tool names (case insensitive)", async () => {
		const client = makeClient({
			messages: [
				{
					id: "msg-1",
					role: "user",
					parts: [{ type: "text", content: "go" }],
				},
				{
					id: "msg-2",
					role: "assistant",
					parts: [
						{ type: "tool", tool: "Shell", args: { command: "ls -la" } },
						{ type: "tool", tool: "MyBashRunner", args: { command: "echo hi" } },
						{ type: "tool", tool: "read", args: { command: "cat file.txt" } },
					],
				},
			],
		});
		const result = await extractSessionData(client, "sess-012");

		// "Shell" and "MyBashRunner" should match, "read" should not
		expect(result?.classificationContext.bash_commands).toEqual(["ls -la", "echo hi"]);
	});

	it("handles messages with no parts gracefully", async () => {
		const client = makeClient({
			messages: [
				{ id: "msg-1", role: "user" },
				{ id: "msg-2", role: "assistant", parts: [] },
			],
		});
		const result = await extractSessionData(client, "sess-013");

		expect(result).not.toBeNull();
		expect(result?.classificationContext.first_user_message).toBe("");
		expect(result?.classificationContext.part_content).toBe("");
		expect(result?.classificationContext.bash_commands).toEqual([]);
		expect(result?.classificationContext.message_count).toBe(2);
	});

	it("handles null session (session.get returns null)", async () => {
		const client = makeClient({ session: null });
		const result = await extractSessionData(client, "sess-014");

		expect(result).not.toBeNull();
		expect(result?.session.agent).toBe("unknown");
		expect(result?.session.model).toBe("unknown");
		expect(result?.session.title).toBe("unknown");

		const costMetric = result?.metrics.find((m) => m.metric_name === "cost");
		expect(costMetric?.value).toBe(0);
	});

	it("sets project_name in classificationContext from project name", async () => {
		const client = makeClient({
			project: { id: "proj-42", name: "my-cool-project", path: "/home/user/my-cool-project" },
		});
		const result = await extractSessionData(client, "sess-015");

		expect(result).not.toBeNull();
		expect(result?.classificationContext.project_name).toBe("my-cool-project");
	});

	it("defaults project_name to 'unknown' when project is null", async () => {
		const client = makeClient({ project: null });
		const result = await extractSessionData(client, "sess-016");

		expect(result).not.toBeNull();
		expect(result?.classificationContext.project_name).toBe("unknown");
	});

	it("includes budget_tag as null in session record", async () => {
		const client = makeClient();
		const result = await extractSessionData(client, "sess-017");

		expect(result).not.toBeNull();
		expect(result?.session.budget_tag).toBeNull();
	});

	it("propagates parentID to the session record and classification context", async () => {
		const client = makeClient({ session: { parentID: "sess-parent-abc" } });
		const result = await extractSessionData(client, "sess-sub");

		expect(result?.session.parent_session_id).toBe("sess-parent-abc");
		expect(result?.classificationContext.parent_session_id).toBe("sess-parent-abc");
	});

	it("stores NULL and empty-string parent context for a root session", async () => {
		const client = makeClient({ session: { parentID: undefined } });
		const result = await extractSessionData(client, "sess-root");

		expect(result?.session.parent_session_id).toBeNull();
		expect(result?.classificationContext.parent_session_id).toBe("");
	});
});

describe("extractSessionData project precedence", () => {
	it("prefers the session's own projectID and projectDirectory", async () => {
		const client = makeClient({
			session: {
				projectID: "proj-session",
				projectDirectory: "/home/user/other-project",
			},
			project: { id: "proj-instance", name: "instance", path: "/home/user/instance" },
		});
		const result = await extractSessionData(client, "sess-precedence");

		expect(result?.project.project_id).toBe("proj-session");
		expect(result?.project.worktree).toBe("/home/user/other-project");
		expect(result?.project.name).toBe("other-project");
		expect(result?.session.project_id).toBe("proj-session");
	});

	it("ignores a relative projectDirectory and falls back to the instance path", async () => {
		const client = makeClient({
			session: {
				projectID: "proj-session",
				projectDirectory: "relative/path",
			},
			project: { id: "proj-instance", name: "instance", path: "/home/user/instance" },
		});
		const result = await extractSessionData(client, "sess-relative");

		expect(result?.project.worktree).toBe("/home/user/instance");
		expect(result?.project.name).toBe("instance");
	});

	it("falls back to the instance project when the session has no project data", async () => {
		const client = makeClient({
			session: { projectID: undefined, projectDirectory: undefined },
			project: { id: "proj-instance", name: "instance", path: "/home/user/instance" },
		});
		const result = await extractSessionData(client, "sess-fallback");

		expect(result?.project.project_id).toBe("proj-instance");
		expect(result?.project.worktree).toBe("/home/user/instance");
	});

	it("uses the session project directory for artifact repo context", async () => {
		// Seed a real git repo at the session directory with a GitHub remote.
		// If the extractor used the instance path instead, resolveRepoContext
		// would fail there and no PR artifact would be produced.
		const repoDir = mkdtempSync(path.join(tmpdir(), "ocm-repo-"));
		const instanceDir = mkdtempSync(path.join(tmpdir(), "ocm-instance-"));
		const runGit = (...args: string[]) => {
			const proc = Bun.spawnSync(["git", "-C", repoDir, ...args], {
				stdout: "pipe",
				stderr: "pipe",
			});
			if (proc.exitCode !== 0) {
				throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString()}`);
			}
		};

		try {
			runGit("init");
			runGit("remote", "add", "origin", "git@github.com:stub-org/stub-repo.git");

			const client = makeClient({
				session: { projectID: "proj-session", projectDirectory: repoDir },
				project: { id: "proj-instance", path: instanceDir },
				messages: [
					{
						id: "msg-1",
						role: "assistant",
						parts: [{ type: "tool", tool: "bash", args: { command: "gh pr view 1" } }],
					},
				],
			});
			const result = await extractSessionData(client, "sess-repo");

			// The resolved path is the session's directory, not the instance path.
			expect(result?.project.worktree).toBe(repoDir);
			// The artifact resolves against the session repo, proving
			// resolveRepoContext received the session directory.
			expect(result?.artifacts).toContainEqual({
				artifact_type: "pr-reviewed",
				reference: "stub-org/stub-repo#1",
			});
			expect(result?.metrics.find((m) => m.metric_name === "prs_reviewed")?.value).toBe(1);
		} finally {
			rmSync(repoDir, { recursive: true, force: true });
			rmSync(instanceDir, { recursive: true, force: true });
		}
	});
});

describe("extractSessionData snapshot files", () => {
	it("derives files_changed from the distinct union of assistant snapshots", async () => {
		const client = makeClient({
			session: { diffStats: undefined },
			messages: [
				{
					id: "a1",
					role: "assistant",
					parts: [{ type: "text", content: "one" }],
					snapshotFiles: ["src/a.ts", "src/b.ts"],
				},
				{
					id: "a2",
					role: "assistant",
					parts: [{ type: "text", content: "two" }],
					snapshotFiles: ["src/b.ts", "src/c.ts"],
				},
			],
		});
		const result = await extractSessionData(client, "sess-snap");

		const files = result?.metrics.find((m) => m.metric_name === "files_changed");
		expect(files?.value).toBe(3);
	});

	it("records zero line counts for V2 sessions", async () => {
		const client = makeClient({
			session: { diffStats: undefined },
			messages: [
				{
					id: "a1",
					role: "assistant",
					parts: [],
					snapshotFiles: ["src/a.ts"],
				},
			],
		});
		const result = await extractSessionData(client, "sess-v2-lines");

		expect(result?.metrics.find((m) => m.metric_name === "lines_added")?.value).toBe(0);
		expect(result?.metrics.find((m) => m.metric_name === "lines_deleted")?.value).toBe(0);
	});

	it("records files_changed as 0 when there are no snapshots", async () => {
		const client = makeClient({
			session: { diffStats: undefined },
			messages: [
				{ id: "a1", role: "assistant", parts: [] },
				{ id: "u1", role: "user", parts: [] },
			],
		});
		const result = await extractSessionData(client, "sess-no-snap");

		expect(result?.metrics.find((m) => m.metric_name === "files_changed")?.value).toBe(0);
		expect(result?.session.session_id).toBe("sess-no-snap");
	});

	it("preserves diffStats when a caller supplies them", async () => {
		const client = makeClient({
			messages: [{ id: "a1", role: "assistant", parts: [], snapshotFiles: ["src/a.ts"] }],
		});
		const result = await extractSessionData(client, "sess-legacy-diff");

		expect(result?.metrics.find((m) => m.metric_name === "files_changed")?.value).toBe(3);
		expect(result?.metrics.find((m) => m.metric_name === "lines_added")?.value).toBe(50);
		expect(result?.metrics.find((m) => m.metric_name === "lines_deleted")?.value).toBe(10);
	});

	it("normalizes Windows separators and deduplicates paths", () => {
		const files = collectSnapshotFiles([
			{ id: "a1", role: "assistant", snapshotFiles: ["src\\a.ts", "./src/a.ts"] },
			{ id: "a2", role: "assistant", snapshotFiles: ["src/b.ts", "src/b.ts"] },
			{ id: "u1", role: "user", snapshotFiles: ["ignored.ts"] },
		]);
		expect(files.sort()).toEqual(["src/a.ts", "src/b.ts"]);
	});

	it("ignores non-string and empty snapshot entries", () => {
		const files = collectSnapshotFiles([
			{
				id: "a1",
				role: "assistant",
				// biome-ignore lint/suspicious/noExplicitAny: exercising malformed input
				snapshotFiles: ["", "src/a.ts", 42 as any, null as any],
			},
		]);
		expect(files).toEqual(["src/a.ts"]);
	});

	it("validates absolute project directories", () => {
		expect(isUsableProjectDirectory("/abs/path")).toBe(true);
		expect(isUsableProjectDirectory("relative/path")).toBe(false);
		expect(isUsableProjectDirectory("")).toBe(false);
		expect(isUsableProjectDirectory(undefined)).toBe(false);
		expect(isUsableProjectDirectory(42)).toBe(false);
	});
});

describe("computeCacheHitRatio", () => {
	it("returns ratio when denominator is positive", () => {
		expect(computeCacheHitRatio(750, 250)).toBeCloseTo(0.75);
	});

	it("returns 0 when both values are 0", () => {
		expect(computeCacheHitRatio(0, 0)).toBe(0);
	});

	it("returns 1 when all tokens are from cache", () => {
		expect(computeCacheHitRatio(1000, 0)).toBe(1);
	});

	it("returns 0 when cacheRead is 0 and input is positive", () => {
		expect(computeCacheHitRatio(0, 500)).toBe(0);
	});
});

describe("computeDurationSeconds", () => {
	it("returns duration in seconds", () => {
		expect(computeDurationSeconds(1000, 4000)).toBe(3);
	});

	it("returns 0 when timeCreated is 0", () => {
		expect(computeDurationSeconds(0, 4000)).toBe(0);
	});

	it("returns 0 when timeUpdated is 0", () => {
		expect(computeDurationSeconds(1000, 0)).toBe(0);
	});

	it("returns 0 when result would be negative (clock skew)", () => {
		expect(computeDurationSeconds(4000, 1000)).toBe(0);
	});

	it("returns 0 when both timestamps are 0", () => {
		expect(computeDurationSeconds(0, 0)).toBe(0);
	});
});

describe("deriveProjectName", () => {
	it("returns the SDK-provided name when available", () => {
		expect(deriveProjectName("my-project", "/home/user/repos/my-project")).toBe("my-project");
	});

	it("derives name from worktree path when name is undefined", () => {
		expect(deriveProjectName(undefined, "/home/user/repos/my-project")).toBe("my-project");
	});

	it("derives name from worktree path when name is null", () => {
		expect(deriveProjectName(null, "/home/user/GIT/ProdSec/complyctl")).toBe("complyctl");
	});

	it("derives name from worktree path when name is empty string", () => {
		expect(deriveProjectName("", "/home/user/repos/ansible-role-ai")).toBe("ansible-role-ai");
	});

	it("falls back to 'unknown' when both name and path are missing", () => {
		expect(deriveProjectName(undefined, undefined)).toBe("unknown");
	});

	it("falls back to 'unknown' when name is undefined and path is null", () => {
		expect(deriveProjectName(undefined, null)).toBe("unknown");
	});

	it("falls back to 'unknown' for root path where basename is empty", () => {
		expect(deriveProjectName(undefined, "/")).toBe("unknown");
	});
});
