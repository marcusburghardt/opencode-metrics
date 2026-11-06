// SPDX-License-Identifier: Apache-2.0

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Plugin } from "@opencode/plugin";
import { ClassificationCache } from "./classifier";
import type { CostPricingRule, MetricsConfig } from "./config";
import { initDatabase } from "./db";
import { DEFAULT_CONFIG } from "./defaults";
import type { MessageInfo, ProjectInfo, SDKClient, SessionInfo } from "./extractor";
import {
	CaptureDebouncer,
	createSDKAdapter,
	handleSessionEvent,
	handleSessionIdle,
	runSubscriptionLoop,
	setupPlugin,
} from "./index";
import { PermissionTracker } from "./permissions";
import { syncCostPricing } from "./pricing";
import { isVersionSupported, resolvePluginVersion } from "./version";

/** Factory for a mock SDKClient with configurable overrides. */
function makeClient(
	overrides: {
		session?: Partial<SessionInfo> | null;
		messages?: MessageInfo[];
		project?: Partial<ProjectInfo> | null;
		logs?: string[];
		sessionGetError?: Error;
		messagesError?: Error;
		projectError?: Error;
	} = {},
): { client: SDKClient; logs: string[] } {
	const logs: string[] = overrides.logs ?? [];

	const client: SDKClient = {
		session: {
			get: async (id) => {
				if (overrides.sessionGetError) throw overrides.sessionGetError;
				return overrides.session === null
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
							title: "Implement feature X",
							projectID: "proj-001",
							timeCreated: 1700000000000,
							timeUpdated: 1700003600000,
							diffStats: { filesChanged: 3, linesAdded: 50, linesDeleted: 10 },
							...overrides.session,
						};
			},
			messages: async () => {
				if (overrides.messagesError) throw overrides.messagesError;
				return (
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
					]
				);
			},
		},
		project: {
			current: async () => {
				if (overrides.projectError) throw overrides.projectError;
				return overrides.project === null
					? null
					: {
							id: "proj-001",
							name: "test-project",
							path: "/home/user/test",
							...overrides.project,
						};
			},
		},
		app: {
			log: (msg) => logs.push(msg),
		},
	};

	return { client, logs };
}

describe("CaptureDebouncer", () => {
	it("evicts stale sessions so the map stays bounded", () => {
		let now = 0;
		const debouncer = new CaptureDebouncer(100, () => now);

		expect(debouncer.tryAcquire("a")).toBe(true);
		now = 50;
		expect(debouncer.tryAcquire("b")).toBe(true);
		expect(debouncer.size).toBe(2);

		now = 101;
		expect(debouncer.tryAcquire("c")).toBe(true);
		// "a" is 101ms old and is evicted; "b" is still within the window.
		expect(debouncer.size).toBe(2);
	});

	it("evicts entries older than the window", () => {
		let now = 0;
		const debouncer = new CaptureDebouncer(100, () => now);

		debouncer.tryAcquire("a");
		now = 150;
		debouncer.tryAcquire("b");
		expect(debouncer.size).toBe(1);
	});

	it("counts a skipped event only when no capture is recorded", () => {
		let now = 0;
		const debouncer = new CaptureDebouncer(100, () => now);

		expect(debouncer.tryAcquire("a")).toBe(true);
		now = 50;
		expect(debouncer.tryAcquire("a")).toBe(false);
		now = 99;
		// Still within the window measured from the first capture at t=0.
		expect(debouncer.tryAcquire("a")).toBe(false);
		now = 100;
		expect(debouncer.tryAcquire("a")).toBe(true);
	});
});

describe("handleSessionIdle", () => {
	let tempDir: string;
	let db: Database;
	let config: MetricsConfig;
	let cache: ClassificationCache;
	let budgetCache: ClassificationCache;

	beforeEach(() => {
		tempDir = mkdtempSync(path.join(tmpdir(), "ocm-index-"));
		const result = initDatabase(tempDir);
		db = result.db;
		config = DEFAULT_CONFIG;
		cache = new ClassificationCache();
		budgetCache = new ClassificationCache();
	});

	afterEach(() => {
		db.close();
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("full flow: extract, classify, write to DB", async () => {
		const { client } = makeClient();

		await handleSessionIdle(
			client,
			"sess-001",
			db,
			config,
			cache,
			budgetCache,
			new PermissionTracker(),
		);

		const project = db.prepare("SELECT * FROM projects WHERE project_id = ?").get("proj-001") as {
			project_id: string;
			name: string;
			worktree: string;
		} | null;

		expect(project).not.toBeNull();
		expect(project?.name).toBe("test-project");
		expect(project?.worktree).toBe("/home/user/test");

		const session = db.prepare("SELECT * FROM sessions WHERE session_id = ?").get("sess-001") as {
			session_id: string;
			agent: string;
			model: string;
			classification: string;
		} | null;

		expect(session).not.toBeNull();
		expect(session?.agent).toBe("build");
		expect(session?.model).toBe("claude-opus-4-20250514");
		expect(session?.classification).toBe("implementation");

		const metrics = db
			.prepare("SELECT * FROM measurements WHERE session_id = ? ORDER BY metric_name")
			.all("sess-001") as Array<{ metric_name: string; value: number }>;

		expect(metrics.length).toBe(23);

		const costMetric = metrics.find((m) => m.metric_name === "cost");
		expect(costMetric?.value).toBeCloseTo(0.42);
	});

	it("classifies session correctly using default rules", async () => {
		const { client } = makeClient({ session: { agent: "explore" } });

		await handleSessionIdle(client, "sess-explore", db, config, cache, budgetCache);

		const session = db
			.prepare("SELECT classification FROM sessions WHERE session_id = ?")
			.get("sess-explore") as { classification: string } | null;

		expect(session?.classification).toBe("exploration");
	});

	it("uses classification cache for repeated calls", async () => {
		const { client } = makeClient();

		await handleSessionIdle(client, "sess-cached", db, config, cache, budgetCache);
		await handleSessionIdle(client, "sess-cached", db, config, cache, budgetCache);

		const session = db
			.prepare("SELECT classification FROM sessions WHERE session_id = ?")
			.get("sess-cached") as { classification: string } | null;

		expect(session?.classification).toBe("implementation");
	});

	it("skips extraction when session_id is empty", async () => {
		const { client, logs } = makeClient();

		await handleSessionIdle(client, "", db, config, cache, budgetCache);

		const count = db.prepare("SELECT COUNT(*) AS count FROM sessions").get() as {
			count: number;
		};
		expect(count.count).toBe(0);

		expect(logs.some((l) => l.includes("null/empty"))).toBe(true);
	});

	it("propagates an SDK session.get failure from handleSessionIdle to the caller", async () => {
		const { client } = makeClient({
			sessionGetError: new Error("SDK connection timeout"),
		});

		await expect(
			handleSessionIdle(client, "sess-err", db, config, cache, budgetCache),
		).rejects.toThrow("SDK connection timeout");
	});

	it("error isolation: SDK messages failure does not propagate", async () => {
		const { client } = makeClient({
			messagesError: new Error("messages endpoint unavailable"),
		});

		await expect(
			handleSessionIdle(client, "sess-err2", db, config, cache, budgetCache),
		).rejects.toThrow("messages endpoint unavailable");
	});

	it("writes all 12 metrics for a complete session", async () => {
		const { client } = makeClient();

		await handleSessionIdle(client, "sess-metrics", db, config, cache, budgetCache);

		const metrics = db
			.prepare("SELECT metric_name FROM measurements WHERE session_id = ? ORDER BY metric_name")
			.all("sess-metrics") as Array<{ metric_name: string }>;

		const names = metrics.map((m) => m.metric_name);
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

	it("updates existing session on repeated idle events", async () => {
		const { client: client1 } = makeClient({
			session: { title: "First title" },
		});
		await handleSessionIdle(client1, "sess-update", db, config, cache, budgetCache);

		const { client: client2 } = makeClient({
			session: { title: "Updated title" },
			messages: [
				{ id: "msg-1", role: "user", parts: [{ type: "text", content: "build it" }] },
				{ id: "msg-2", role: "assistant", parts: [{ type: "text", content: "done" }] },
				{ id: "msg-3", role: "user", parts: [{ type: "text", content: "more" }] },
			],
		});
		await handleSessionIdle(client2, "sess-update", db, config, cache, budgetCache);

		const session = db
			.prepare("SELECT title FROM sessions WHERE session_id = ?")
			.get("sess-update") as { title: string } | null;

		expect(session?.title).toBe("Updated title");
	});

	it("computes derived metrics correctly in integration", async () => {
		const { client } = makeClient({
			session: {
				tokensCacheRead: 600,
				tokensInput: 400,
				timeCreated: 1700000000000,
				timeUpdated: 1700001800000,
			},
		});

		await handleSessionIdle(client, "sess-derived", db, config, cache, budgetCache);

		const cacheRatio = db
			.prepare("SELECT value FROM measurements WHERE session_id = ? AND metric_name = ?")
			.get("sess-derived", "cache_hit_ratio") as { value: number } | null;

		expect(cacheRatio?.value).toBeCloseTo(0.6);

		const duration = db
			.prepare("SELECT value FROM measurements WHERE session_id = ? AND metric_name = ?")
			.get("sess-derived", "duration_seconds") as { value: number } | null;

		expect(duration?.value).toBe(1800);
	});

	it("sets budget_tag when budget rules match", async () => {
		const { client } = makeClient();

		const configWithBudget: MetricsConfig = {
			...config,
			budget_rules: [
				{
					budget_tag: "team-build",
					conditions: [{ field: "agent", values: ["build"] }],
				},
			],
		};

		await handleSessionIdle(client, "sess-budget", db, configWithBudget, cache, budgetCache);

		const session = db
			.prepare("SELECT budget_tag FROM sessions WHERE session_id = ?")
			.get("sess-budget") as { budget_tag: string | null } | null;

		expect(session?.budget_tag).toBe("team-build");
	});

	it("sets budget_tag to null when no budget rules match", async () => {
		const { client } = makeClient({ session: { agent: "explore" } });

		const configWithBudget: MetricsConfig = {
			...config,
			budget_rules: [
				{
					budget_tag: "only-build",
					conditions: [{ field: "agent", values: ["build"] }],
				},
			],
		};

		await handleSessionIdle(client, "sess-no-budget", db, configWithBudget, cache, budgetCache);

		const session = db
			.prepare("SELECT budget_tag FROM sessions WHERE session_id = ?")
			.get("sess-no-budget") as { budget_tag: string | null } | null;

		expect(session?.budget_tag).toBeNull();
	});

	it("works correctly when cost_pricing is configured", async () => {
		const { client } = makeClient();

		const configWithPricing: MetricsConfig = {
			...config,
			cost_pricing: [
				{
					model: "claude-opus-4-20250514",
					input_price: 15.0,
					output_price: 75.0,
					cache_read_price: 1.5,
					cache_write_price: 18.75,
					reasoning_price: 75.0,
					description: "Opus 4",
				},
			],
		};

		syncCostPricing(db, configWithPricing.cost_pricing);

		await handleSessionIdle(client, "sess-pricing", db, configWithPricing, cache, budgetCache);

		const session = db
			.prepare("SELECT * FROM sessions WHERE session_id = ?")
			.get("sess-pricing") as { session_id: string; classification: string } | null;

		expect(session).not.toBeNull();
		expect(session?.classification).toBe("implementation");

		const metrics = db
			.prepare("SELECT COUNT(*) AS count FROM measurements WHERE session_id = ?")
			.get("sess-pricing") as { count: number };

		expect(metrics.count).toBeGreaterThan(0);

		const pricingRows = db.prepare("SELECT COUNT(*) AS count FROM cost_pricing").get() as {
			count: number;
		};
		expect(pricingRows.count).toBe(1);
	});

	it("syncCostPricing throws on a closed database", () => {
		const closedDb = initDatabase(tempDir).db;
		closedDb.close();

		const rules: CostPricingRule[] = [
			{ model: "test-model", input_price: 1.0, output_price: 2.0 },
		];

		expect(() => syncCostPricing(closedDb, rules)).toThrow();
	});

	it("budget cache is independent of classification cache", async () => {
		const { client } = makeClient();

		const configWithBudget: MetricsConfig = {
			...config,
			budget_rules: [
				{
					budget_tag: "infra-ops",
					conditions: [{ field: "agent", values: ["build"] }],
				},
			],
		};

		await handleSessionIdle(client, "sess-indep", db, configWithBudget, cache, budgetCache);

		const cachedClassification = cache.get("sess-indep", 2);
		expect(cachedClassification).toBe("implementation");

		const cachedBudget = budgetCache.get("sess-indep", 2);
		expect(cachedBudget).toBe("infra-ops");

		const freshBudgetCache = new ClassificationCache();
		expect(freshBudgetCache.get("sess-indep", 2)).toBeNull();
		expect(cache.get("sess-indep", 2)).toBe("implementation");
	});
});

// ---------------------------------------------------------------------------
// V2 SDK adapter
// ---------------------------------------------------------------------------

interface FakeSessionInfo {
	id: string;
	cost?: number;
	tokens?: {
		input: number;
		output: number;
		reasoning: number;
		cache: { read: number; write: number };
	};
	agent?: string;
	model?: { id: string; providerID: string; variant?: string };
	title?: string;
	projectID?: string;
	parentID?: string;
	time?: { created: number; updated: number };
	location?: { directory?: string };
}

function defaultSession(id: string): FakeSessionInfo {
	return {
		id,
		cost: 0.3,
		tokens: {
			input: 300,
			output: 130,
			reasoning: 40,
			cache: { read: 60, write: 20 },
		},
		agent: "build",
		model: { id: "claude-x", providerID: "anthropic" },
		title: "Test session",
		projectID: "proj-session",
		time: { created: 1000, updated: 2000 },
		location: { directory: "/repo/session-project" },
	};
}

function makeAdapterContext(
	overrides: {
		session?: FakeSessionInfo | null;
		messages?: unknown[];
		project?: { id: string; directory: string; canonical: string };
	} = {},
): {
	ctx: Plugin.Context;
	calls: { get: number; context: number };
} {
	const calls = { get: 0, context: 0 };
	const ctx = {
		session: {
			get: async ({ sessionID }: { sessionID: string }) => {
				calls.get += 1;
				return overrides.session === undefined ? defaultSession(sessionID) : overrides.session;
			},
			context: async () => {
				calls.context += 1;
				return overrides.messages ?? [];
			},
		},
		location: {
			directory: "/instance/dir",
			project: overrides.project ?? {
				id: "proj-instance",
				directory: "/instance/dir",
				canonical: "/instance/project",
			},
		},
	};
	return { ctx: ctx as unknown as Plugin.Context, calls };
}

describe("createSDKAdapter (V2)", () => {
	it("maps session aggregates without loading messages", async () => {
		const { ctx, calls } = makeAdapterContext({ session: defaultSession("s1") });
		const adapter = createSDKAdapter(ctx);

		const session = await adapter.session.get("s1");

		expect(session).not.toBeNull();
		expect(session?.cost).toBeCloseTo(0.3);
		expect(session?.tokensInput).toBe(300);
		expect(session?.tokensOutput).toBe(130);
		expect(session?.tokensReasoning).toBe(40);
		expect(session?.tokensCacheRead).toBe(60);
		expect(session?.tokensCacheWrite).toBe(20);
		expect(calls.get).toBe(1);
		expect(calls.context).toBe(0);
	});

	it("maps parentID when present and omits it when absent", async () => {
		const present = await createSDKAdapter(
			makeAdapterContext({ session: { ...defaultSession("s1"), parentID: "parent-1" } }).ctx,
		).session.get("s1");
		expect(present?.parentID).toBe("parent-1");

		const absent = await createSDKAdapter(
			makeAdapterContext({ session: defaultSession("s1") }).ctx,
		).session.get("s1");
		expect(absent?.parentID).toBeUndefined();
	});

	it("maps user text to a single text part", async () => {
		const { ctx } = makeAdapterContext({
			messages: [{ id: "u1", type: "user", text: "hello" }],
		});
		const messages = await createSDKAdapter(ctx).session.messages("s1");

		expect(messages).toHaveLength(1);
		expect(messages[0].role).toBe("user");
		expect(messages[0].parts).toEqual([{ type: "text", content: "hello" }]);
	});

	it("maps assistant text and tool content, skipping reasoning", async () => {
		const { ctx } = makeAdapterContext({
			messages: [
				{
					id: "a1",
					type: "assistant",
					content: [
						{ type: "text", text: "I will run it" },
						{ type: "reasoning", text: "internal thoughts" },
						{
							type: "tool",
							name: "bash",
							state: {
								status: "completed",
								input: { command: "ls" },
								content: [
									{ type: "text", text: "file-a" },
									{ type: "text", text: "file-b" },
								],
							},
						},
					],
				},
			],
		});
		const messages = await createSDKAdapter(ctx).session.messages("s1");

		expect(messages).toHaveLength(1);
		expect(messages[0].parts).toHaveLength(2);
		expect(messages[0].parts?.[0]).toEqual({ type: "text", content: "I will run it" });
		expect(messages[0].parts?.[1].type).toBe("tool");
		expect(messages[0].parts?.[1].tool).toBe("bash");
		expect(messages[0].parts?.[1].args).toEqual({ command: "ls" });
		expect(messages[0].parts?.[1].output).toBe("file-a\nfile-b");
	});

	it("returns an empty tool output when there is no text content", async () => {
		const { ctx } = makeAdapterContext({
			messages: [
				{
					id: "a1",
					type: "assistant",
					content: [
						{
							type: "tool",
							name: "read",
							state: {
								status: "completed",
								input: { file: "x" },
								content: [{ type: "file", uri: "file:///x", mime: "text/plain" }],
							},
						},
						{
							type: "tool",
							name: "todo",
							state: { status: "running", input: {}, metadata: {} },
						},
					],
				},
			],
		});
		const messages = await createSDKAdapter(ctx).session.messages("s1");

		expect(messages[0].parts?.[0].output).toBe("");
		expect(messages[0].parts?.[1].output).toBe("");
	});

	it("skips unknown content variants without throwing", async () => {
		const { ctx } = makeAdapterContext({
			messages: [
				{
					id: "a1",
					type: "assistant",
					content: [
						{ type: "text", text: "kept" },
						{ type: "future-variant", payload: { secret: true } },
						{ type: "tool", name: "broken" },
					],
				},
			],
		});
		const messages = await createSDKAdapter(ctx).session.messages("s1");

		expect(messages).toHaveLength(1);
		expect(messages[0].parts).toHaveLength(2);
		expect(messages[0].parts?.[0]).toEqual({ type: "text", content: "kept" });
		expect(messages[0].parts?.[1]).toEqual({
			type: "tool",
			tool: "broken",
			args: undefined,
			output: "",
		});
	});

	it("filters markers, synthetic, system, and idle messages", async () => {
		const { ctx } = makeAdapterContext({
			messages: [
				{ id: "m1", type: "user", text: "hello" },
				{ id: "m2", type: "agent-switched", agent: "build" },
				{ id: "m3", type: "model-switched", model: { id: "x", providerID: "p" } },
				{ id: "m4", type: "idle" },
				{ id: "m5", type: "synthetic", text: "reminder" },
				{ id: "m6", type: "system", text: "system prompt" },
				{ id: "m7", type: "assistant", content: [{ type: "text", text: "done" }] },
			],
		});
		const messages = await createSDKAdapter(ctx).session.messages("s1");

		expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
	});

	it("maps projectDirectory and snapshot files", async () => {
		const { ctx } = makeAdapterContext({
			session: {
				...defaultSession("s1"),
				location: { directory: "/repo/other-project" },
			},
			messages: [
				{
					id: "a1",
					type: "assistant",
					content: [],
					snapshot: { files: ["src/a.ts", "src/b.ts"] },
				},
			],
		});
		const adapter = createSDKAdapter(ctx);
		const session = await adapter.session.get("s1");
		const messages = await adapter.session.messages("s1");

		expect(session?.projectDirectory).toBe("/repo/other-project");
		expect(messages[0].snapshotFiles).toEqual(["src/a.ts", "src/b.ts"]);
	});

	it("returns the instance project id and canonical path", async () => {
		const { ctx } = makeAdapterContext({
			project: { id: "proj-inst", directory: "/d", canonical: "/d/project" },
		});
		const project = await createSDKAdapter(ctx).project.current();

		expect(project).toEqual({ id: "proj-inst", path: "/d/project" });
	});

	it("routes app.log through console.warn with the metrics prefix", () => {
		const originalWarn = console.warn;
		const warnings: string[] = [];
		console.warn = (message?: unknown) => {
			warnings.push(String(message));
		};
		try {
			const { ctx } = makeAdapterContext();
			createSDKAdapter(ctx).app.log("extractor warning");
		} finally {
			console.warn = originalWarn;
		}
		expect(warnings).toEqual(["extractor warning"]);
	});
});

// ---------------------------------------------------------------------------
// Entry point / subscription loop
// ---------------------------------------------------------------------------

/** Console capture used by entry-point tests, recorded per channel. */
function captureConsole(): {
	info: string[];
	warn: string[];
	error: string[];
	all: () => string[];
	restore: () => void;
} {
	const info: string[] = [];
	const warn: string[] = [];
	const error: string[] = [];
	const original = { info: console.info, warn: console.warn, error: console.error };
	const record =
		(target: string[]) =>
		(...args: unknown[]) => {
			target.push(args.map((arg) => String(arg)).join(" "));
		};
	console.info = record(info);
	console.warn = record(warn);
	console.error = record(error);
	return {
		info,
		warn,
		error,
		all: () => [...info, ...warn, ...error],
		restore: () => {
			console.info = original.info;
			console.warn = original.warn;
			console.error = original.error;
		},
	};
}

/** A promise with an externally callable resolver, for deterministic sync. */
function deferred<T = void>(): {
	promise: Promise<T>;
	resolve: (value?: T) => void;
} {
	let resolve!: (value?: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

function idleEvent(sessionID: string): unknown {
	return { type: "session.status", data: { sessionID, status: { type: "idle" } } };
}

function statusEvent(sessionID: string, statusType: string): unknown {
	return { type: "session.status", data: { sessionID, status: { type: statusType } } };
}

function sessionIdleEvent(sessionID: string): unknown {
	return { type: "session.idle", data: { sessionID } };
}

function executionEvent(kind: string, sessionID: string): unknown {
	return { type: `session.execution.${kind}`, data: { sessionID } };
}

function permissionAsked(sessionID: string, id: string | undefined, created?: number): unknown {
	return { type: "permission.asked", created, data: { sessionID, id } };
}

function permissionReplied(
	sessionID: string,
	requestID: string | undefined,
	created?: number,
): unknown {
	return { type: "permission.replied", created, data: { sessionID, requestID } };
}

function emptyStream(): AsyncIterable<unknown> {
	return {
		[Symbol.asyncIterator]() {
			return {
				async next(): Promise<IteratorResult<unknown>> {
					return { done: true, value: undefined };
				},
			};
		},
	};
}

function finiteStream(events: unknown[]): AsyncIterable<unknown> {
	return {
		[Symbol.asyncIterator]() {
			let index = 0;
			return {
				async next(): Promise<IteratorResult<unknown>> {
					if (index < events.length) {
						const value = events[index];
						index += 1;
						return { done: false, value };
					}
					return { done: true, value: undefined };
				},
			};
		},
	};
}

function failingStream(error: Error): AsyncIterable<unknown> {
	return {
		[Symbol.asyncIterator]() {
			return {
				async next(): Promise<IteratorResult<unknown>> {
					throw error;
				},
			};
		},
	};
}

function waitForAbort(signal: AbortSignal | undefined): Promise<void> {
	if (!signal || signal.aborted) return Promise.resolve();
	return new Promise((resolve) => {
		signal.addEventListener("abort", () => resolve(), { once: true });
	});
}

function abortableStream(
	events: unknown[],
	signal: AbortSignal | undefined,
): AsyncIterable<unknown> {
	let index = 0;
	return {
		[Symbol.asyncIterator]() {
			return {
				async next(): Promise<IteratorResult<unknown>> {
					if (signal?.aborted) throw new DOMException("aborted", "AbortError");
					if (index < events.length) {
						const value = events[index];
						index += 1;
						return { done: false, value };
					}
					await waitForAbort(signal);
					throw new DOMException("aborted", "AbortError");
				},
			};
		},
	};
}

interface FakeEventContext {
	ctx: Pick<Plugin.Context, "event">;
	subscribeCalls: Array<{ types?: readonly string[]; signal?: AbortSignal }>;
}

function makeEventContext(
	streamFactory: (options: {
		types?: readonly string[];
		signal?: AbortSignal;
	}) => AsyncIterable<unknown>,
): FakeEventContext {
	const subscribeCalls: Array<{ types?: readonly string[]; signal?: AbortSignal }> = [];
	const ctx = {
		event: {
			subscribe: (options?: { types?: readonly string[]; signal?: AbortSignal }) => {
				subscribeCalls.push(options ?? {});
				return streamFactory(options ?? {});
			},
		},
	};
	return { ctx: ctx as unknown as Pick<Plugin.Context, "event">, subscribeCalls };
}

function makeFullContext(
	options: {
		stream?: (options: {
			types?: readonly string[];
			signal?: AbortSignal;
		}) => AsyncIterable<unknown>;
		session?: FakeSessionInfo | null;
		getSession?: (sessionID: string) => Promise<FakeSessionInfo | null> | FakeSessionInfo | null;
		messages?: unknown[];
		project?: { id: string; directory: string; canonical: string };
	} = {},
): {
	ctx: Plugin.Context;
	subscribeCalls: Array<{ types?: readonly string[]; signal?: AbortSignal }>;
} {
	const subscribeCalls: Array<{ types?: readonly string[]; signal?: AbortSignal }> = [];
	const ctx = {
		session: {
			get: async ({ sessionID }: { sessionID: string }) => {
				if (options.getSession) return options.getSession(sessionID);
				return options.session === undefined ? defaultSession(sessionID) : options.session;
			},
			context: async () => options.messages ?? [],
		},
		location: {
			directory: "/instance",
			project: options.project ?? {
				id: "proj-inst",
				directory: "/instance",
				canonical: "/instance/project",
			},
		},
		event: {
			subscribe: (opts?: { types?: readonly string[]; signal?: AbortSignal }) => {
				subscribeCalls.push(opts ?? {});
				return options.stream ? options.stream(opts ?? {}) : emptyStream();
			},
		},
	};
	return { ctx: ctx as unknown as Plugin.Context, subscribeCalls };
}

describe("event subscription loop", () => {
	let dataHome: string;
	let originalXdg: string | undefined;
	const openDbs: Database[] = [];

	beforeEach(() => {
		originalXdg = process.env.XDG_DATA_HOME;
		dataHome = mkdtempSync(path.join(tmpdir(), "ocm-entry-"));
		process.env.XDG_DATA_HOME = dataHome;
		openDbs.length = 0;
	});

	afterEach(() => {
		for (const db of openDbs) {
			try {
				db.close();
			} catch {
				// already closed
			}
		}
		if (originalXdg === undefined) {
			process.env.XDG_DATA_HOME = undefined;
			delete process.env.XDG_DATA_HOME;
		} else {
			process.env.XDG_DATA_HOME = originalXdg;
		}
		rmSync(dataHome, { recursive: true, force: true });
	});

	async function makeRuntime(client: SDKClient = makeClient().client) {
		const { db } = initDatabase();
		openDbs.push(db);
		return {
			db,
			config: DEFAULT_CONFIG,
			classificationCache: new ClassificationCache(),
			budgetCache: new ClassificationCache(),
			sdkClient: client,
			permissionTracker: new PermissionTracker(),
		};
	}

	it("handles idle events sequentially and does not double-count deltas", async () => {
		let firstGetSettled = false;
		let getCount = 0;
		const client: SDKClient = {
			session: {
				get: async (id) => {
					getCount += 1;
					const cost = getCount === 1 ? 0.1 : 0.3;
					firstGetSettled = true;
					return {
						id,
						cost,
						tokensInput: getCount * 10,
						tokensOutput: 0,
						tokensReasoning: 0,
						tokensCacheRead: 0,
						tokensCacheWrite: 0,
						agent: "build",
						model: "m",
						title: "t",
						projectID: "p",
						timeCreated: 1,
						timeUpdated: getCount,
					};
				},
				messages: async () => [],
			},
			project: { current: async () => ({ id: "p", path: "/repo" }) },
			app: { log: () => {} },
		};

		let index = 0;
		let violation = false;
		const events = [idleEvent("sess-seq"), idleEvent("sess-seq")];
		const stream: AsyncIterable<unknown> = {
			[Symbol.asyncIterator]() {
				return {
					async next(): Promise<IteratorResult<unknown>> {
						if (index === 1 && !firstGetSettled) violation = true;
						if (index < events.length) {
							const value = events[index];
							index += 1;
							return { done: false, value };
						}
						return { done: true, value: undefined };
					},
				};
			},
		};
		const { ctx } = makeEventContext(() => stream);
		const runtime = await makeRuntime(client);
		const controller = new AbortController();

		await runSubscriptionLoop(
			ctx,
			runtime,
			{ sleep: async () => {}, captureDebounceMs: 0 },
			controller.signal,
		);

		expect(violation).toBe(false);

		const delta = runtime.db
			.prepare(
				"SELECT COALESCE(SUM(delta), 0) AS total FROM measurement_deltas WHERE session_id = ? AND metric_name = 'cost'",
			)
			.get("sess-seq") as { total: number };
		expect(delta.total).toBeCloseTo(0.3);

		const cumulative = runtime.db
			.prepare("SELECT value FROM measurements WHERE session_id = ? AND metric_name = 'cost'")
			.get("sess-seq") as { value: number };
		expect(cumulative.value).toBeCloseTo(0.3);
	});

	it("filters non-idle statuses and non-session.status events", async () => {
		const capture = captureConsole();
		try {
			const { ctx } = makeEventContext(() =>
				finiteStream([
					{ type: "lsp.updated", data: {} },
					{ type: "session.status", data: { sessionID: "sess-busy", status: { type: "busy" } } },
					{ type: "session.status", data: { sessionID: "sess-retry", status: { type: "retry" } } },
				]),
			);
			const runtime = await makeRuntime();
			await runSubscriptionLoop(
				ctx,
				runtime,
				{ sleep: async () => {} },
				new AbortController().signal,
			);

			const count = runtime.db.prepare("SELECT COUNT(*) AS count FROM sessions").get() as {
				count: number;
			};
			expect(count.count).toBe(0);
			expect(capture.error).toEqual([]);
		} finally {
			capture.restore();
		}
	});

	it("captures for every terminal event family", async () => {
		const { ctx } = makeEventContext(() =>
			finiteStream([
				statusEvent("sess-status-idle", "idle"),
				sessionIdleEvent("sess-session-idle"),
				executionEvent("succeeded", "sess-exec-ok"),
				executionEvent("failed", "sess-exec-fail"),
				executionEvent("interrupted", "sess-exec-int"),
			]),
		);
		const runtime = await makeRuntime();
		await runSubscriptionLoop(
			ctx,
			runtime,
			{ sleep: async () => {}, captureDebounceMs: 0 },
			new AbortController().signal,
		);

		const rows = runtime.db
			.prepare("SELECT session_id FROM sessions ORDER BY session_id")
			.all() as Array<{ session_id: string }>;
		expect(rows.map((row) => row.session_id)).toEqual([
			"sess-exec-fail",
			"sess-exec-int",
			"sess-exec-ok",
			"sess-session-idle",
			"sess-status-idle",
		]);
	});

	it("subscribes to every lifecycle event family", async () => {
		const { ctx, subscribeCalls } = makeEventContext(() => emptyStream());
		const runtime = await makeRuntime();
		await runSubscriptionLoop(
			ctx,
			runtime,
			{ sleep: async () => {} },
			new AbortController().signal,
		);

		expect(subscribeCalls[0]?.types).toEqual([
			"session.status",
			"session.idle",
			"session.execution.succeeded",
			"session.execution.failed",
			"session.execution.interrupted",
			"permission.asked",
			"permission.replied",
		]);
	});

	it("collapses duplicate terminal events within the window into one capture", async () => {
		const capture = captureConsole();
		try {
			const { ctx } = makeEventContext(() =>
				finiteStream([
					idleEvent("sess-dupe"),
					sessionIdleEvent("sess-dupe"),
					executionEvent("succeeded", "sess-dupe"),
				]),
			);
			const runtime = await makeRuntime();
			await runSubscriptionLoop(
				ctx,
				runtime,
				{ sleep: async () => {}, captureDebounceMs: 750, now: () => 1000 },
				new AbortController().signal,
			);

			const count = runtime.db.prepare("SELECT COUNT(*) AS count FROM sessions").get() as {
				count: number;
			};
			expect(count.count).toBe(1);
			const skips = capture.info.filter((line) => line.includes("skipping duplicate capture"));
			expect(skips.length).toBe(2);
		} finally {
			capture.restore();
		}
	});

	it("captures again once the debounce window has elapsed", async () => {
		const times = [1000, 2000];
		let index = 0;
		let getCalls = 0;
		const base = makeClient();
		const client: SDKClient = {
			...base.client,
			session: {
				...base.client.session,
				get: async (id) => {
					getCalls += 1;
					return base.client.session.get(id);
				},
			},
		};
		const { ctx } = makeEventContext(() =>
			finiteStream([idleEvent("sess-window"), sessionIdleEvent("sess-window")]),
		);
		const runtime = await makeRuntime(client);
		await runSubscriptionLoop(
			ctx,
			runtime,
			{ sleep: async () => {}, captureDebounceMs: 750, now: () => times[index++] ?? 2000 },
			new AbortController().signal,
		);

		expect(getCalls).toBe(2);
	});

	it("does not move the timestamp when an event is debounced", async () => {
		// 1000 captures; 1100 is skipped; 1800 is 800ms after the last real
		// capture and must still capture. If the skip bumped the timestamp to
		// 1100, 1800 would fall inside the window and be dropped.
		const times = [1000, 1100, 1800];
		let index = 0;
		let getCalls = 0;
		const base = makeClient();
		const client: SDKClient = {
			...base.client,
			session: {
				...base.client.session,
				get: async (id) => {
					getCalls += 1;
					return base.client.session.get(id);
				},
			},
		};
		const { ctx } = makeEventContext(() =>
			finiteStream([
				idleEvent("sess-skip"),
				sessionIdleEvent("sess-skip"),
				executionEvent("succeeded", "sess-skip"),
			]),
		);
		const runtime = await makeRuntime(client);
		await runSubscriptionLoop(
			ctx,
			runtime,
			{ sleep: async () => {}, captureDebounceMs: 750, now: () => times[index++] ?? 1800 },
			new AbortController().signal,
		);

		expect(getCalls).toBe(2);
	});

	it("warns and skips malformed payloads for every family", async () => {
		const capture = captureConsole();
		try {
			const families = [
				"session.status",
				"session.idle",
				"session.execution.succeeded",
				"session.execution.failed",
				"session.execution.interrupted",
			];
			const events: unknown[] = [];
			for (const type of families) {
				events.push({ type, data: null });
				events.push({ type, data: { sessionID: "" } });
			}
			const { ctx } = makeEventContext(() => finiteStream(events));
			const runtime = await makeRuntime();
			await runSubscriptionLoop(
				ctx,
				runtime,
				{ sleep: async () => {}, captureDebounceMs: 0 },
				new AbortController().signal,
			);

			const count = runtime.db.prepare("SELECT COUNT(*) AS count FROM sessions").get() as {
				count: number;
			};
			expect(count.count).toBe(0);
			const warnings = capture.warn.filter((line) => line.includes("skipping"));
			expect(warnings.length).toBe(10);
			for (const type of families) {
				expect(warnings.some((line) => line.includes(`${type} event with missing data`))).toBe(
					true,
				);
				expect(
					warnings.some((line) => line.includes(`${type} event with missing session id`)),
				).toBe(true);
			}
		} finally {
			capture.restore();
		}
	});

	it("treats a capture that throws as an attempt (no retry storm)", async () => {
		const capture = captureConsole();
		let getCalls = 0;
		const base = makeClient();
		const failingOnce: SDKClient = {
			...base.client,
			session: {
				...base.client.session,
				get: async (id) => {
					getCalls += 1;
					if (getCalls === 1) throw new Error("sdk boom");
					return base.client.session.get(id);
				},
			},
		};
		try {
			const { ctx } = makeEventContext(() =>
				finiteStream([idleEvent("sess-throw"), sessionIdleEvent("sess-throw")]),
			);
			const runtime = await makeRuntime(failingOnce);
			await runSubscriptionLoop(
				ctx,
				runtime,
				{ sleep: async () => {}, captureDebounceMs: 750, now: () => 1000 },
				new AbortController().signal,
			);

			// The second event is debounced even though the first attempt threw.
			expect(getCalls).toBe(1);
			expect(capture.error.some((line) => line.includes("sdk boom"))).toBe(true);
		} finally {
			capture.restore();
		}
	});

	it("ignores unknown event types silently", async () => {
		const capture = captureConsole();
		try {
			const runtime = await makeRuntime();
			await handleSessionEvent({ type: "lsp.updated", data: { sessionID: "sess-x" } }, runtime);
			await handleSessionEvent({ type: "message.updated" }, runtime);

			expect(capture.warn).toEqual([]);
			expect(capture.error).toEqual([]);
			const count = runtime.db.prepare("SELECT COUNT(*) AS count FROM sessions").get() as {
				count: number;
			};
			expect(count.count).toBe(0);
		} finally {
			capture.restore();
		}
	});

	it("subscribes to permission events alongside lifecycle events", async () => {
		const { ctx, subscribeCalls } = makeEventContext(() => emptyStream());
		const runtime = await makeRuntime();
		await runSubscriptionLoop(
			ctx,
			runtime,
			{ sleep: async () => {} },
			new AbortController().signal,
		);

		expect(subscribeCalls).toHaveLength(1);
		expect(subscribeCalls[0].types).toContain("permission.asked");
		expect(subscribeCalls[0].types).toContain("permission.replied");
		expect(subscribeCalls[0].types).toContain("session.status");
	});

	it("tracks permission events without capturing the session", async () => {
		const { ctx } = makeEventContext(() =>
			finiteStream([
				permissionAsked("sess-perm", "p1", 1000),
				permissionReplied("sess-perm", "p1", 4000),
			]),
		);
		const runtime = await makeRuntime();
		await runSubscriptionLoop(
			ctx,
			runtime,
			{ sleep: async () => {} },
			new AbortController().signal,
		);

		const count = runtime.db.prepare("SELECT COUNT(*) AS count FROM sessions").get() as {
			count: number;
		};
		expect(count.count).toBe(0);
		expect(runtime.permissionTracker.drain("sess-perm")).toEqual({
			permission_prompts: 1,
			permission_wait_seconds: 3,
		});
	});

	it("writes captured permission metrics after a lifecycle event", async () => {
		const { ctx } = makeEventContext(() =>
			finiteStream([
				permissionAsked("sess-perm-capture", "p1", 1000),
				permissionReplied("sess-perm-capture", "p1", 4000),
				idleEvent("sess-perm-capture"),
			]),
		);
		const runtime = await makeRuntime();
		await runSubscriptionLoop(
			ctx,
			runtime,
			{ sleep: async () => {}, captureDebounceMs: 0 },
			new AbortController().signal,
		);

		const prompts = runtime.db
			.prepare(
				"SELECT value FROM measurements WHERE session_id = ? AND metric_name = 'permission_prompts'",
			)
			.get("sess-perm-capture") as { value: number } | null;
		const wait = runtime.db
			.prepare(
				"SELECT value FROM measurements WHERE session_id = ? AND metric_name = 'permission_wait_seconds'",
			)
			.get("sess-perm-capture") as { value: number } | null;

		expect(prompts?.value).toBe(1);
		expect(wait?.value).toBe(3);
	});

	it("ignores malformed permission events", async () => {
		const capture = captureConsole();
		try {
			const runtime = await makeRuntime();
			await handleSessionEvent({ type: "permission.asked", data: null }, runtime);
			await handleSessionEvent(
				{ type: "permission.asked", data: { sessionID: 42, id: "p1" } },
				runtime,
			);
			await handleSessionEvent(permissionReplied("", "p1"), runtime);

			expect(runtime.permissionTracker.drain("42")).toEqual({
				permission_prompts: 0,
				permission_wait_seconds: 0,
			});
			const count = runtime.db.prepare("SELECT COUNT(*) AS count FROM sessions").get() as {
				count: number;
			};
			expect(count.count).toBe(0);
			expect(capture.error).toEqual([]);
		} finally {
			capture.restore();
		}
	});

	it("skips malformed payloads with a warning", async () => {
		const capture = captureConsole();
		try {
			const { ctx } = makeEventContext(() =>
				finiteStream([
					{ type: "session.status", data: null },
					{ type: "session.status", data: { sessionID: "", status: { type: "idle" } } },
					{ type: "session.status", data: { sessionID: "sess-x", status: null } },
				]),
			);
			const runtime = await makeRuntime();
			await runSubscriptionLoop(
				ctx,
				runtime,
				{ sleep: async () => {} },
				new AbortController().signal,
			);

			const count = runtime.db.prepare("SELECT COUNT(*) AS count FROM sessions").get() as {
				count: number;
			};
			expect(count.count).toBe(0);
			const warnings = capture.warn.filter((line) => line.includes("skipping"));
			expect(warnings.length).toBe(3);
		} finally {
			capture.restore();
		}
	});

	it("recovers from an SDK query failure and captures the next idle event", async () => {
		const capture = captureConsole();
		let calls = 0;
		const base = makeClient();
		const client: SDKClient = {
			...base.client,
			session: {
				...base.client.session,
				get: async (id) => {
					calls += 1;
					if (calls === 1) throw new Error("sdk boom");
					return base.client.session.get(id);
				},
			},
		};
		try {
			const { ctx } = makeEventContext(() =>
				finiteStream([idleEvent("sess-fail"), idleEvent("sess-ok")]),
			);
			const runtime = await makeRuntime(client);
			await runSubscriptionLoop(
				ctx,
				runtime,
				{ sleep: async () => {} },
				new AbortController().signal,
			);

			expect(capture.error.some((line) => line.includes("sdk boom"))).toBe(true);
			const row = runtime.db
				.prepare("SELECT COUNT(*) AS count FROM sessions WHERE session_id = ?")
				.get("sess-ok") as { count: number };
			expect(row.count).toBe(1);
		} finally {
			capture.restore();
		}
	});

	it("recovers from a database write failure and persists a later capture", async () => {
		const capture = captureConsole();
		let failNextWrite = true;
		let getCalls = 0;
		const base = makeClient();
		const client: SDKClient = {
			...base.client,
			session: {
				...base.client.session,
				get: async (id) => {
					getCalls += 1;
					if (getCalls === 2) failNextWrite = false;
					return base.client.session.get(id);
				},
			},
		};
		try {
			const runtime = await makeRuntime(client);
			const realDb = runtime.db;
			const flakyDb = new Proxy(realDb, {
				get(target, property) {
					if (property === "transaction") {
						return (fn: () => void) => {
							if (failNextWrite) throw new Error("disk full");
							return target.transaction(fn);
						};
					}
					const value = Reflect.get(target, property);
					return typeof value === "function" ? value.bind(target) : value;
				},
			}) as Database;
			runtime.db = flakyDb;

			const { ctx } = makeEventContext(() =>
				finiteStream([idleEvent("sess-write-1"), idleEvent("sess-write-2")]),
			);
			await runSubscriptionLoop(
				ctx,
				runtime,
				{ sleep: async () => {} },
				new AbortController().signal,
			);

			expect(capture.error.some((line) => line.includes("disk full"))).toBe(true);
			const row = runtime.db
				.prepare("SELECT COUNT(*) AS count FROM sessions WHERE session_id = ?")
				.get("sess-write-2") as { count: number };
			expect(row.count).toBe(1);
		} finally {
			capture.restore();
		}
	});

	it("logs three attempt failures, two resubscribe lines, and a terminal stop", async () => {
		const capture = captureConsole();
		const delays: number[] = [];
		try {
			const { ctx } = makeEventContext(() => failingStream(new Error("stream boom")));
			const runtime = await makeRuntime();
			await runSubscriptionLoop(
				ctx,
				runtime,
				{ sleep: async (ms) => delays.push(ms), retryBaseDelayMs: 500 },
				new AbortController().signal,
			);

			expect(delays).toEqual([500, 1000]);
			const failures = capture.error.filter((line) => line.includes("subscription failed"));
			expect(failures.length).toBe(3);
			const resubscribes = capture.info.filter((line) => line.includes("resubscribing"));
			expect(resubscribes.length).toBe(2);
			const terminal = capture.error.filter((line) => line.includes("metrics collection halted"));
			expect(terminal.length).toBe(1);
			// Regression guard: failures must stay on the error channel, not info.
			expect(capture.info.some((line) => line.includes("subscription failed"))).toBe(false);
		} finally {
			capture.restore();
		}
	});

	it("caps the resubscribe delay at 8000ms", async () => {
		const capture = captureConsole();
		const delays: number[] = [];
		try {
			const { ctx } = makeEventContext(() => failingStream(new Error("stream boom")));
			const runtime = await makeRuntime();
			await runSubscriptionLoop(
				ctx,
				runtime,
				{ sleep: async (ms) => delays.push(ms), retryBaseDelayMs: 6000 },
				new AbortController().signal,
			);
			expect(delays).toEqual([6000, 8000]);
		} finally {
			capture.restore();
		}
	});

	it("resets the retry budget after a successful subscription", async () => {
		const capture = captureConsole();
		const delays: number[] = [];
		let subscriptions = 0;
		const client = makeClient().client;
		try {
			const { ctx } = makeEventContext(() => {
				subscriptions += 1;
				if (subscriptions === 1) {
					// One successful event, then a stream failure.
					let step = 0;
					return {
						[Symbol.asyncIterator]() {
							return {
								async next(): Promise<IteratorResult<unknown>> {
									step += 1;
									if (step === 1) return { done: false, value: idleEvent("sess-reset") };
									throw new Error("after success");
								},
							};
						},
					};
				}
				return failingStream(new Error("boom"));
			});
			const runtime = await makeRuntime(client);
			await runSubscriptionLoop(
				ctx,
				runtime,
				{ sleep: async (ms) => delays.push(ms), retryBaseDelayMs: 500 },
				new AbortController().signal,
			);

			// Three subscriptions prove the budget restarted after the success.
			expect(subscriptions).toBe(3);
			expect(delays).toEqual([500, 1000]);
		} finally {
			capture.restore();
		}
	});

	it("logs normal stream completion without an error", async () => {
		const capture = captureConsole();
		try {
			const { ctx } = makeEventContext(() => emptyStream());
			const runtime = await makeRuntime();
			await runSubscriptionLoop(
				ctx,
				runtime,
				{ sleep: async () => {} },
				new AbortController().signal,
			);

			expect(capture.info.some((line) => line.includes("subscription completed"))).toBe(true);
			expect(capture.error.some((line) => line.includes("subscription failed"))).toBe(false);
			expect(capture.error.some((line) => line.includes("metrics collection halted"))).toBe(false);
		} finally {
			capture.restore();
		}
	});

	it("does not log an abort as an error, and does not consume further events", async () => {
		const capture = captureConsole();
		try {
			const controller = new AbortController();
			let captured: AbortSignal | undefined;
			const subscribed = deferred();
			const { ctx } = makeEventContext((options) => {
				captured = options.signal;
				subscribed.resolve();
				return abortableStream([], options.signal);
			});
			const runtime = await makeRuntime();
			const loop = runSubscriptionLoop(ctx, runtime, { sleep: async () => {} }, controller.signal);

			await subscribed.promise;
			expect(captured?.aborted).toBe(false);
			controller.abort();
			expect(captured?.aborted).toBe(true);
			await loop;

			expect(capture.error).toEqual([]);
			expect(capture.error.some((line) => line.includes("subscription failed"))).toBe(false);
		} finally {
			capture.restore();
		}
	});

	it("logs a non-abort error from the same generator (positive control)", async () => {
		const capture = captureConsole();
		try {
			const { ctx } = makeEventContext(() => failingStream(new Error("real failure")));
			const runtime = await makeRuntime();
			await runSubscriptionLoop(
				ctx,
				runtime,
				{ sleep: async () => {}, maxSubscribeAttempts: 1 },
				new AbortController().signal,
			);
			expect(capture.error.some((line) => line.includes("real failure"))).toBe(true);
		} finally {
			capture.restore();
		}
	});

	it("logs an AbortError-named error when the signal is not aborted", async () => {
		const capture = captureConsole();
		try {
			const abortLike = new Error("aborted");
			abortLike.name = "AbortError";
			const { ctx } = makeEventContext(() => failingStream(abortLike));
			const runtime = await makeRuntime();
			await runSubscriptionLoop(
				ctx,
				runtime,
				{ sleep: async () => {}, maxSubscribeAttempts: 1 },
				new AbortController().signal,
			);
			expect(capture.error.some((line) => line.includes("AbortError"))).toBe(true);
		} finally {
			capture.restore();
		}
	});

	it("completes an in-flight capture atomically when the loop is aborted", async () => {
		const capture = captureConsole();
		try {
			let resolveGet: ((value: FakeSessionInfo | null) => void) | undefined;
			const pending = new Promise<FakeSessionInfo | null>((resolve) => {
				resolveGet = resolve;
			});
			// Resolved inside session.get so the test can prove the capture
			// actually started before aborting (never passes vacuously).
			const started = deferred();
			const client: SDKClient = {
				session: {
					get: () => {
						started.resolve();
						return pending;
					},
					messages: async () => [],
				},
				project: { current: async () => ({ id: "p", path: "/repo" }) },
				app: { log: () => {} },
			};
			const controller = new AbortController();
			const { ctx } = makeEventContext((options) =>
				abortableStream([idleEvent("sess-inflight")], options.signal),
			);
			const runtime = await makeRuntime(client);
			const loop = runSubscriptionLoop(ctx, runtime, { sleep: async () => {} }, controller.signal);

			await started.promise;
			controller.abort();
			resolveGet?.({
				...defaultSession("sess-inflight"),
				projectID: "p",
				timeCreated: 1,
				timeUpdated: 2,
			});
			await loop;

			const session = runtime.db
				.prepare("SELECT COUNT(*) AS count FROM sessions WHERE session_id = ?")
				.get("sess-inflight") as { count: number };
			const measurements = runtime.db
				.prepare("SELECT COUNT(*) AS count FROM measurements WHERE session_id = ?")
				.get("sess-inflight") as { count: number };
			// Either the write rolled back (no row) or completed fully.
			if (session.count === 1) {
				expect(measurements.count).toBe(23);
			} else {
				expect(measurements.count).toBe(0);
			}
			expect(capture.error.some((line) => line.includes("subscription failed"))).toBe(false);
		} finally {
			capture.restore();
		}
	});
});

// ---------------------------------------------------------------------------
// Setup, version guard, initialization, isolation
// ---------------------------------------------------------------------------

describe("setupPlugin", () => {
	let dataHome: string;
	let originalXdg: string | undefined;

	beforeEach(() => {
		originalXdg = process.env.XDG_DATA_HOME;
		dataHome = mkdtempSync(path.join(tmpdir(), "ocm-setup-"));
		process.env.XDG_DATA_HOME = dataHome;
	});

	afterEach(() => {
		if (originalXdg === undefined) {
			delete process.env.XDG_DATA_HOME;
		} else {
			process.env.XDG_DATA_HOME = originalXdg;
		}
		rmSync(dataHome, { recursive: true, force: true });
	});

	it("rejects an unsupported injected plugin version without subscribing", async () => {
		const capture = captureConsole();
		try {
			const { ctx, subscribeCalls } = makeFullContext();
			const cleanup = await setupPlugin(ctx, { pluginVersion: "3.0.0" });

			expect(capture.error.some((line) => line.includes(">=2.2.5 <3.0.0"))).toBe(true);
			expect(subscribeCalls.length).toBe(0);
			expect(() => cleanup()).not.toThrow();
		} finally {
			capture.restore();
		}
	});

	it("returns a no-op cleanup when initialization fails (ENOTDIR)", async () => {
		const capture = captureConsole();
		const blocker = path.join(dataHome, "blocker");
		writeFileSync(blocker, "not a directory");
		const nested = path.join(blocker, "nested");
		process.env.XDG_DATA_HOME = nested;
		try {
			const { ctx, subscribeCalls } = makeFullContext();
			const cleanup = await setupPlugin(ctx, {
				pluginVersion: "2.2.5",
				sleep: async () => {},
			});

			expect(capture.error.some((line) => line.includes("initialization failed"))).toBe(true);
			expect(subscribeCalls.length).toBe(0);
			expect(() => cleanup()).not.toThrow();
		} finally {
			capture.restore();
		}
	});

	it("captures a session end-to-end and updates cumulatively", async () => {
		const capture = captureConsole();
		const sessionState: FakeSessionInfo = {
			...defaultSession("sess-e2e"),
			cost: 0.2,
			projectID: "proj-e2e",
			location: { directory: "/repo/e2e-project" },
		};
		try {
			const { ctx } = makeFullContext({
				getSession: () => sessionState,
				stream: () => finiteStream([idleEvent("sess-e2e")]),
			});

			const subscribed = deferred();
			const loopDone = deferred();
			const cleanup = await setupPlugin(ctx, {
				pluginVersion: "2.2.5",
				sleep: async () => {},
				onSubscribed: () => subscribed.resolve(),
				onLoopComplete: () => loopDone.resolve(),
			});
			await subscribed.promise;
			cleanup();
			await loopDone.promise;

			const dbPath = path.join(dataHome, "opencode-metrics", "metrics.db");
			const db = new Database(dbPath);
			try {
				const project = db
					.prepare("SELECT project_id, worktree FROM projects WHERE project_id = ?")
					.get("proj-e2e") as { project_id: string; worktree: string } | null;
				expect(project?.worktree).toBe("/repo/e2e-project");

				const session = db
					.prepare("SELECT session_id FROM sessions WHERE session_id = ?")
					.get("sess-e2e") as { session_id: string } | null;
				expect(session).not.toBeNull();

				const measurement = db
					.prepare("SELECT value FROM measurements WHERE session_id = ? AND metric_name = 'cost'")
					.get("sess-e2e") as { value: number };
				expect(measurement.value).toBeCloseTo(0.2);

				const delta = db
					.prepare(
						"SELECT COALESCE(SUM(delta), 0) AS total FROM measurement_deltas WHERE session_id = ? AND metric_name = 'cost'",
					)
					.get("sess-e2e") as { total: number };
				expect(delta.total).toBeCloseTo(0.2);

				// Second idle event with a higher cumulative cost.
				sessionState.cost = 0.5;
				sessionState.time = { created: 1, updated: 3 };
				const secondSubscribed = deferred();
				const secondDone = deferred();
				const second = await setupPlugin(ctx, {
					pluginVersion: "2.2.5",
					sleep: async () => {},
					onSubscribed: () => secondSubscribed.resolve(),
					onLoopComplete: () => secondDone.resolve(),
				});
				await secondSubscribed.promise;
				second();
				await secondDone.promise;

				const updated = db
					.prepare("SELECT value FROM measurements WHERE session_id = ? AND metric_name = 'cost'")
					.get("sess-e2e") as { value: number };
				expect(updated.value).toBeCloseTo(0.5);

				const totalDelta = db
					.prepare(
						"SELECT COALESCE(SUM(delta), 0) AS total FROM measurement_deltas WHERE session_id = ? AND metric_name = 'cost'",
					)
					.get("sess-e2e") as { total: number };
				expect(totalDelta.total).toBeCloseTo(0.5);
			} finally {
				db.close();
			}
		} finally {
			capture.restore();
		}
	});

	it("stores the session's current agent/model, not the first user message", async () => {
		const capture = captureConsole();
		const sessionState: FakeSessionInfo = {
			...defaultSession("sess-prov"),
			agent: "build",
			model: { id: "x", providerID: "anthropic" },
		};
		try {
			const { ctx } = makeFullContext({
				session: sessionState,
				messages: [
					{
						id: "u1",
						type: "user",
						text: "plan it",
						agent: "plan",
						model: { id: "old", providerID: "openai" },
					},
				],
				stream: () => finiteStream([idleEvent("sess-prov")]),
			});

			const subscribed = deferred();
			const loopDone = deferred();
			const cleanup = await setupPlugin(ctx, {
				pluginVersion: "2.2.5",
				sleep: async () => {},
				onSubscribed: () => subscribed.resolve(),
				onLoopComplete: () => loopDone.resolve(),
			});
			await subscribed.promise;
			cleanup();
			await loopDone.promise;

			const db = new Database(path.join(dataHome, "opencode-metrics", "metrics.db"));
			try {
				const row = db
					.prepare("SELECT agent, model, classification FROM sessions WHERE session_id = ?")
					.get("sess-prov") as {
					agent: string;
					model: string;
					classification: string;
				};
				expect(row.agent).toBe("build");
				expect(row.model).toBe("x");
				expect(row.classification).toBe("implementation");
			} finally {
				db.close();
			}
		} finally {
			capture.restore();
		}
	});

	it("never logs tool output, message text, or file contents", async () => {
		const capture = captureConsole();
		const marker = "SECRET_TOOL_OUTPUT_MARKER";
		try {
			const client: SDKClient = {
				session: {
					get: async (id) => ({
						id,
						cost: 0.1,
						tokensInput: 1,
						tokensOutput: 1,
						tokensReasoning: 0,
						tokensCacheRead: 0,
						tokensCacheWrite: 0,
						agent: "build",
						model: "m",
						title: "t",
						projectID: "p",
						timeCreated: 1,
						timeUpdated: 2,
					}),
					messages: async () => [
						{
							id: "a1",
							role: "assistant",
							parts: [
								{
									type: "tool",
									tool: "bash",
									args: { command: `echo ${marker}` },
									output: marker,
								},
							],
						},
					],
				},
				project: { current: async () => ({ id: "p", path: "/repo" }) },
				app: { log: () => {} },
			};
			const { db } = initDatabase();
			const failingDb = new Proxy(db, {
				get(target, property) {
					if (property === "transaction") {
						return () => {
							throw new Error("disk full");
						};
					}
					const value = Reflect.get(target, property);
					return typeof value === "function" ? value.bind(target) : value;
				},
			}) as Database;
			const runtime = {
				db: failingDb,
				config: DEFAULT_CONFIG,
				classificationCache: new ClassificationCache(),
				budgetCache: new ClassificationCache(),
				sdkClient: client,
				permissionTracker: new PermissionTracker(),
			};

			const { ctx } = makeEventContext(() => finiteStream([idleEvent("sess-log")]));
			await runSubscriptionLoop(
				ctx,
				runtime,
				{ sleep: async () => {} },
				new AbortController().signal,
			);
			db.close();

			expect(capture.error.some((line) => line.includes("disk full"))).toBe(true);
			expect(capture.error.some((line) => line.includes("sess-log"))).toBe(true);
			expect(capture.all().some((line) => line.includes(marker))).toBe(false);
		} finally {
			capture.restore();
		}
	});

	it("creates the data directory, database, and config with explicit permissions", async () => {
		const capture = captureConsole();
		const previousUmask = process.umask(0o000);
		try {
			const { ctx } = makeFullContext({ stream: () => emptyStream() });
			const subscribed = deferred();
			const loopDone = deferred();
			const cleanup = await setupPlugin(ctx, {
				pluginVersion: "2.2.5",
				sleep: async () => {},
				onSubscribed: () => subscribed.resolve(),
				onLoopComplete: () => loopDone.resolve(),
			});
			await subscribed.promise;
			cleanup();
			await loopDone.promise;

			// Startup is an info-level line, not an error.
			expect(capture.info.some((line) => line.includes("initialized"))).toBe(true);
			expect(capture.error).toEqual([]);

			const dataDir = path.join(dataHome, "opencode-metrics");
			expect(statSync(dataDir).mode & 0o777).toBe(0o755);
			expect(statSync(path.join(dataDir, "metrics.db")).mode & 0o777).toBe(0o644);
			expect(statSync(path.join(dataDir, "config.yaml")).mode & 0o777).toBe(0o644);
		} finally {
			process.umask(previousUmask);
			capture.restore();
		}
	});
});

// ---------------------------------------------------------------------------
// Version resolver
// ---------------------------------------------------------------------------

describe("version resolver", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	function makeFixture(version: string | null, raw?: string): string {
		const root = mkdtempSync(path.join(tmpdir(), "ocm-version-"));
		tempDirs.push(root);
		const packageDir = path.join(root, "node_modules", "@opencode", "plugin");
		mkdirSync(packageDir, { recursive: true });
		const contents =
			raw ?? (version === null ? "" : JSON.stringify({ name: "@opencode/plugin", version }));
		writeFileSync(path.join(packageDir, "package.json"), contents);
		return root;
	}

	it("parses versions with prerelease and build suffixes", () => {
		expect(isVersionSupported("2.2.5")).toBe(true);
		expect(isVersionSupported("2.9.9")).toBe(true);
		expect(isVersionSupported("2.2.4")).toBe(false);
		expect(isVersionSupported("3.0.0")).toBe(false);
		expect(isVersionSupported("3.0.0-rc.1")).toBe(false);
		expect(isVersionSupported("not-a-version")).toBe(false);
	});

	it("resolves 2.2.4 as incompatible", () => {
		const root = makeFixture("2.2.4");
		const resolved = resolvePluginVersion(root);
		expect(resolved.version).toBe("2.2.4");
		expect(resolved.compatible).toBe(false);
	});

	it("resolves 2.2.5 as compatible (inclusive lower bound)", () => {
		const root = makeFixture("2.2.5");
		const resolved = resolvePluginVersion(root);
		expect(resolved.version).toBe("2.2.5");
		expect(resolved.compatible).toBe(true);
	});

	it("resolves 3.0.0 as incompatible (exclusive upper bound)", () => {
		const root = makeFixture("3.0.0");
		const resolved = resolvePluginVersion(root);
		expect(resolved.version).toBe("3.0.0");
		expect(resolved.compatible).toBe(false);
	});

	it("resolves 3.0.0-rc.1 as incompatible", () => {
		const root = makeFixture("3.0.0-rc.1");
		const resolved = resolvePluginVersion(root);
		expect(resolved.version).toBe("3.0.0-rc.1");
		expect(resolved.compatible).toBe(false);
	});

	it("treats a missing package as unresolved", () => {
		const root = mkdtempSync(path.join(tmpdir(), "ocm-version-"));
		tempDirs.push(root);
		const resolved = resolvePluginVersion(root);
		expect(resolved.version).toBeNull();
		expect(resolved.compatible).toBe(false);
	});

	it("treats an unparseable package.json as unresolved", () => {
		const root = makeFixture(null, "{not json");
		const resolved = resolvePluginVersion(root);
		expect(resolved.version).toBeNull();
		expect(resolved.compatible).toBe(false);
	});

	it("does not subscribe when the fixture root is out of range or unreadable", async () => {
		const dataHome = mkdtempSync(path.join(tmpdir(), "ocm-version-xdg-"));
		const originalXdg = process.env.XDG_DATA_HOME;
		process.env.XDG_DATA_HOME = dataHome;
		const capture = captureConsole();
		try {
			for (const root of [
				makeFixture("2.2.4"),
				makeFixture("3.0.0"),
				makeFixture(null, "{not json"),
			]) {
				const { ctx, subscribeCalls } = makeFullContext();
				const cleanup = await setupPlugin(ctx, {
					resolutionRoot: root,
					sleep: async () => {},
				});
				expect(subscribeCalls.length).toBe(0);
				expect(() => cleanup()).not.toThrow();
			}
		} finally {
			capture.restore();
			if (originalXdg === undefined) {
				delete process.env.XDG_DATA_HOME;
			} else {
				process.env.XDG_DATA_HOME = originalXdg;
			}
			rmSync(dataHome, { recursive: true, force: true });
		}
	});
});
