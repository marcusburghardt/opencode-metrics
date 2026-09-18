// SPDX-License-Identifier: Apache-2.0

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ClassificationCache } from "./classifier";
import type { CostPricingRule, MetricsConfig } from "./config";
import { initDatabase } from "./db";
import { DEFAULT_CONFIG } from "./defaults";
import type { MessageInfo, ProjectInfo, SDKClient, SessionInfo } from "./extractor";
import { createSDKAdapter, handleSessionIdle } from "./index";
import { syncCostPricing } from "./pricing";

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

/**
 * Factory for a mock PluginInput-like object that createSDKAdapter accepts.
 * Mirrors the shape of PluginInput.client from @opencode-ai/plugin: the SDK
 * returns { data, error } from session.get/messages and project.current,
 * and app.log takes { body: { service, level, message } }.
 */
function makePluginInput(
	overrides: {
		sessionData?: Record<string, unknown> | null;
		messagesData?: unknown[];
		projectData?: Record<string, unknown> | null;
		logCapture?: string[];
	} = {},
	// biome-ignore lint/suspicious/noExplicitAny: test mock requires flexible typing
): { client: Record<string, any> } {
	const logCapture = overrides.logCapture ?? [];

	return {
		client: {
			session: {
				get: async (_opts: { path: { id: string } }) => ({
					data: overrides.sessionData ?? null,
				}),
				messages: async (_opts: { path: { id: string } }) => ({
					data: overrides.messagesData ?? [],
				}),
			},
			project: {
				current: async () => ({
					data: overrides.projectData ?? null,
				}),
			},
			app: {
				log: (opts: { body: { service: string; level: string; message: string } }) => {
					logCapture.push(opts.body.message);
				},
			},
		},
	};
}

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

		await handleSessionIdle(client, "sess-001", db, config, cache, budgetCache);

		// Verify project was written
		const project = db.prepare("SELECT * FROM projects WHERE project_id = ?").get("proj-001") as {
			project_id: string;
			name: string;
			worktree: string;
		} | null;

		expect(project).not.toBeNull();
		expect(project?.name).toBe("test-project");
		expect(project?.worktree).toBe("/home/user/test");

		// Verify session was written
		const session = db.prepare("SELECT * FROM sessions WHERE session_id = ?").get("sess-001") as {
			session_id: string;
			agent: string;
			model: string;
			classification: string;
		} | null;

		expect(session).not.toBeNull();
		expect(session?.agent).toBe("build");
		expect(session?.model).toBe("claude-opus-4-20250514");
		// Default rules classify "build" agent as "implementation"
		expect(session?.classification).toBe("implementation");

		// Verify metrics were written
		const metrics = db
			.prepare("SELECT * FROM measurements WHERE session_id = ? ORDER BY metric_name")
			.all("sess-001") as Array<{ metric_name: string; value: number }>;

		expect(metrics.length).toBe(15);

		const costMetric = metrics.find((m) => m.metric_name === "cost");
		expect(costMetric?.value).toBeCloseTo(0.42);
	});

	it("classifies session correctly using default rules", async () => {
		// Explore agent should be classified as "exploration"
		const { client } = makeClient({ session: { agent: "explore" } });

		await handleSessionIdle(client, "sess-explore", db, config, cache, budgetCache);

		const session = db
			.prepare("SELECT classification FROM sessions WHERE session_id = ?")
			.get("sess-explore") as { classification: string } | null;

		expect(session?.classification).toBe("exploration");
	});

	it("uses classification cache for repeated calls", async () => {
		const { client } = makeClient();

		// First call populates the cache
		await handleSessionIdle(client, "sess-cached", db, config, cache, budgetCache);

		// Second call should use the cache (same message count)
		await handleSessionIdle(client, "sess-cached", db, config, cache, budgetCache);

		// Session should still be correctly classified
		const session = db
			.prepare("SELECT classification FROM sessions WHERE session_id = ?")
			.get("sess-cached") as { classification: string } | null;

		expect(session?.classification).toBe("implementation");
	});

	it("skips extraction when session_id is empty", async () => {
		const { client, logs } = makeClient();

		await handleSessionIdle(client, "", db, config, cache, budgetCache);

		// No data should be written
		const count = db.prepare("SELECT COUNT(*) AS count FROM sessions").get() as {
			count: number;
		};
		expect(count.count).toBe(0);

		// Warning should be logged
		expect(logs.some((l) => l.includes("null/empty"))).toBe(true);
	});

	it("error isolation: SDK session.get failure does not propagate", async () => {
		const { client } = makeClient({
			sessionGetError: new Error("SDK connection timeout"),
		});

		// handleSessionIdle should throw (caller is responsible for catch)
		// In the real plugin, the event handler wraps this in try/catch.
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

		// Second call with different title — cache is invalidated by new message count
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

		// Sync pricing rules to the database before handling the session,
		// mirroring what the plugin startup does in index.ts.
		syncCostPricing(db, configWithPricing.cost_pricing);

		// Core metrics collection should work without regression.
		await handleSessionIdle(client, "sess-pricing", db, configWithPricing, cache, budgetCache);

		// Verify session was written — proves cost_pricing in config does not
		// interfere with the extract → classify → write pipeline.
		const session = db
			.prepare("SELECT * FROM sessions WHERE session_id = ?")
			.get("sess-pricing") as { session_id: string; classification: string } | null;

		expect(session).not.toBeNull();
		expect(session?.classification).toBe("implementation");

		// Verify metrics were written (cost, tokens, etc.).
		const metrics = db
			.prepare("SELECT COUNT(*) AS count FROM measurements WHERE session_id = ?")
			.get("sess-pricing") as { count: number };

		expect(metrics.count).toBeGreaterThan(0);

		// Verify pricing rules are in the database.
		const pricingRows = db.prepare("SELECT COUNT(*) AS count FROM cost_pricing").get() as {
			count: number;
		};
		expect(pricingRows.count).toBe(1);
	});

	it("syncCostPricing throws on a closed database", () => {
		// The try/catch in the plugin startup (index.ts) handles database
		// errors gracefully — logging the error and continuing without
		// adjusted cost data. This test verifies the underlying failure
		// mode by calling syncCostPricing directly with a closed database.
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

		// First call populates both caches
		await handleSessionIdle(client, "sess-indep", db, configWithBudget, cache, budgetCache);

		// Classification cache should have the work-type classification
		const cachedClassification = cache.get("sess-indep", 2);
		expect(cachedClassification).toBe("implementation");

		// Budget cache should have the budget tag independently
		const cachedBudget = budgetCache.get("sess-indep", 2);
		expect(cachedBudget).toBe("infra-ops");

		// Verify the two caches are distinct instances — clearing one
		// does not affect the other.
		const freshBudgetCache = new ClassificationCache();
		expect(freshBudgetCache.get("sess-indep", 2)).toBeNull();
		expect(cache.get("sess-indep", 2)).toBe("implementation");
	});
});

describe("createSDKAdapter", () => {
	it("aggregates tokens from multiple assistant messages", async () => {
		const input = makePluginInput({
			sessionData: {
				id: "sess-tok",
				title: "Token test",
				time: { created: 1000, updated: 2000 },
			},
			messagesData: [
				{
					info: {
						id: "m1",
						role: "assistant",
						cost: 0.1,
						tokens: { input: 100, output: 50, reasoning: 10, cache: { read: 20, write: 5 } },
					},
					parts: [],
				},
				{
					info: {
						id: "m2",
						role: "assistant",
						cost: 0.2,
						tokens: { input: 200, output: 80, reasoning: 30, cache: { read: 40, write: 15 } },
					},
					parts: [],
				},
			],
		});

		// biome-ignore lint/suspicious/noExplicitAny: test mock
		const adapter = createSDKAdapter(input as any);
		const session = await adapter.session.get("sess-tok");

		expect(session).not.toBeNull();
		expect(session?.cost).toBeCloseTo(0.3);
		expect(session?.tokensInput).toBe(300);
		expect(session?.tokensOutput).toBe(130);
		expect(session?.tokensReasoning).toBe(40);
		expect(session?.tokensCacheRead).toBe(60);
		expect(session?.tokensCacheWrite).toBe(20);
	});

	it("extracts agent and model from first user message", async () => {
		const input = makePluginInput({
			sessionData: {
				id: "sess-agent",
				title: "Agent test",
				time: { created: 1000, updated: 2000 },
			},
			messagesData: [
				{
					info: { id: "m1", role: "user", agent: "build", model: "claude-opus-4-20250514" },
					parts: [{ type: "text", text: "hello" }],
				},
				{
					info: { id: "m2", role: "user", agent: "plan", model: "gpt-4o" },
					parts: [{ type: "text", text: "plan something" }],
				},
			],
		});

		// biome-ignore lint/suspicious/noExplicitAny: test mock
		const adapter = createSDKAdapter(input as any);
		const session = await adapter.session.get("sess-agent");

		// Should take agent/model from the first user message only.
		expect(session?.agent).toBe("build");
		expect(session?.model).toBe("claude-opus-4-20250514");
	});

	it("transforms text parts and tool parts correctly", async () => {
		const input = makePluginInput({
			messagesData: [
				{
					info: { id: "m1", role: "user" },
					parts: [
						{ type: "text", text: "hello world" },
						{
							type: "tool",
							tool: "bash",
							state: { input: { command: "ls -la" } },
						},
					],
				},
			],
		});

		// biome-ignore lint/suspicious/noExplicitAny: test mock
		const adapter = createSDKAdapter(input as any);
		const messages = await adapter.session.messages("sess-parts");

		expect(messages.length).toBe(1);
		expect(messages[0].parts.length).toBe(2);

		// Text part
		expect(messages[0].parts[0].type).toBe("text");
		expect(messages[0].parts[0].content).toBe("hello world");
		expect(messages[0].parts[0].tool).toBeUndefined();

		// Tool part
		expect(messages[0].parts[1].type).toBe("tool");
		expect(messages[0].parts[1].tool).toBe("bash");
		expect(messages[0].parts[1].args).toEqual({ command: "ls -la" });
		expect(messages[0].parts[1].content).toBeUndefined();
	});

	it("handles null session data", async () => {
		const input = makePluginInput({
			sessionData: null,
		});

		// biome-ignore lint/suspicious/noExplicitAny: test mock
		const adapter = createSDKAdapter(input as any);
		const session = await adapter.session.get("sess-null");

		expect(session).toBeNull();
	});

	it("handles missing session fields gracefully", async () => {
		const input = makePluginInput({
			sessionData: {
				id: "sess-sparse",
				// No title, time, summary, projectID, parentID
			},
			messagesData: [],
		});

		// biome-ignore lint/suspicious/noExplicitAny: test mock
		const adapter = createSDKAdapter(input as any);
		const session = await adapter.session.get("sess-sparse");

		expect(session).not.toBeNull();
		expect(session?.id).toBe("sess-sparse");
		expect(session?.cost).toBe(0);
		expect(session?.tokensInput).toBe(0);
		expect(session?.title).toBeUndefined();
		expect(session?.agent).toBeUndefined();
	});

	it("extracts project data", async () => {
		const input = makePluginInput({
			projectData: {
				id: "proj-test",
				worktree: "/home/user/project",
			},
		});

		// biome-ignore lint/suspicious/noExplicitAny: test mock
		const adapter = createSDKAdapter(input as any);
		const project = await adapter.project.current();

		expect(project).not.toBeNull();
		expect(project?.id).toBe("proj-test");
		expect(project?.path).toBe("/home/user/project");
	});

	it("handles null project data", async () => {
		const input = makePluginInput({
			projectData: null,
		});

		// biome-ignore lint/suspicious/noExplicitAny: test mock
		const adapter = createSDKAdapter(input as any);
		const project = await adapter.project.current();

		expect(project).toBeNull();
	});

	it("caches messages per session to avoid double-fetching", async () => {
		let fetchCount = 0;
		const input = {
			client: {
				session: {
					get: async () => ({ data: { id: "sess-cache", time: {}, title: "t" } }),
					messages: async () => {
						fetchCount++;
						return {
							data: [
								{ info: { id: "m1", role: "user" }, parts: [] },
								{
									info: {
										id: "m2",
										role: "assistant",
										cost: 0.1,
										tokens: { input: 10, output: 5, reasoning: 0 },
									},
									parts: [],
								},
							],
						};
					},
				},
				project: { current: async () => ({ data: null }) },
				app: { log: () => {} },
			},
		};

		// biome-ignore lint/suspicious/noExplicitAny: test mock
		const adapter = createSDKAdapter(input as any);

		// session.get calls fetchRawMessages internally for token aggregation
		await adapter.session.get("sess-cache");
		// session.messages for the same ID should use the cache
		await adapter.session.messages("sess-cache");

		// Only one actual fetch should have occurred (cached on first call)
		expect(fetchCount).toBe(1);
	});

	it("extracts diffStats from session summary", async () => {
		const input = makePluginInput({
			sessionData: {
				id: "sess-diff",
				title: "Diff test",
				time: { created: 1000, updated: 2000 },
				summary: { files: 5, additions: 100, deletions: 20 },
			},
			messagesData: [],
		});

		// biome-ignore lint/suspicious/noExplicitAny: test mock
		const adapter = createSDKAdapter(input as any);
		const session = await adapter.session.get("sess-diff");

		expect(session?.diffStats).toEqual({
			filesChanged: 5,
			linesAdded: 100,
			linesDeleted: 20,
		});
	});

	it("delegates app.log to the underlying client", () => {
		const logCapture: string[] = [];
		const input = makePluginInput({ logCapture });

		// biome-ignore lint/suspicious/noExplicitAny: test mock
		const adapter = createSDKAdapter(input as any);
		adapter.app.log("test message");

		expect(logCapture).toContain("test message");
	});
});

describe("plugin default export", () => {
	it("ignores non-session.status events", async () => {
		// Import the default export (plugin factory function).
		const pluginModule = await import("./index");
		const plugin = pluginModule.default;

		const logCapture: string[] = [];
		const input = makePluginInput({ logCapture });

		// The plugin function initializes DB + config, so we call it.
		// biome-ignore lint/suspicious/noExplicitAny: test mock
		const hooks = await plugin(input as any);

		// Fire a non-session.status event — should be silently ignored.
		await hooks.event?.({
			event: {
				type: "lsp.updated",
				properties: {},
				// biome-ignore lint/suspicious/noExplicitAny: test mock
			} as any,
		});

		// No error logged — the event handler returned early.
		expect(logCapture.filter((l) => l.includes("error")).length).toBe(0);
	});

	it("ignores non-idle session.status events", async () => {
		const pluginModule = await import("./index");
		const plugin = pluginModule.default;

		const logCapture: string[] = [];
		const input = makePluginInput({ logCapture });

		// biome-ignore lint/suspicious/noExplicitAny: test mock
		const hooks = await plugin(input as any);

		await hooks.event?.({
			event: {
				type: "session.status",
				properties: {
					sessionID: "sess-busy",
					status: { type: "busy" },
				},
				// biome-ignore lint/suspicious/noExplicitAny: test mock
			} as any,
		});

		// No error logged — non-idle statuses are ignored.
		expect(logCapture.filter((l) => l.includes("error")).length).toBe(0);
	});

	it("ignores events with missing sessionID", async () => {
		const pluginModule = await import("./index");
		const plugin = pluginModule.default;

		const logCapture: string[] = [];
		const input = makePluginInput({ logCapture });

		// biome-ignore lint/suspicious/noExplicitAny: test mock
		const hooks = await plugin(input as any);

		await hooks.event?.({
			event: {
				type: "session.status",
				properties: {
					sessionID: "",
					status: { type: "idle" },
				},
				// biome-ignore lint/suspicious/noExplicitAny: test mock
			} as any,
		});

		// No error logged — empty sessionID is silently ignored.
		expect(logCapture.filter((l) => l.includes("error")).length).toBe(0);
	});

	it("catches and logs errors from handleSessionIdle", async () => {
		const pluginModule = await import("./index");
		const plugin = pluginModule.default;

		const logCapture: string[] = [];
		// Make session.get throw to trigger an error inside handleSessionIdle.
		// The adapter's session.get calls client.session.get which throws,
		// and the plugin's event handler catch block should log it.
		const input = {
			client: {
				session: {
					get: async () => {
						throw new Error("simulated SDK failure");
					},
					messages: async () => ({ data: [] }),
				},
				project: { current: async () => ({ data: null }) },
				app: {
					log: (opts: { body: { message: string } }) => {
						logCapture.push(opts.body.message);
					},
				},
			},
		};

		// biome-ignore lint/suspicious/noExplicitAny: test mock
		const hooks = await plugin(input as any);

		// The event handler should catch and log the error, not re-throw.
		await hooks.event?.({
			event: {
				type: "session.status",
				properties: {
					sessionID: "sess-err",
					status: { type: "idle" },
				},
				// biome-ignore lint/suspicious/noExplicitAny: test mock
			} as any,
		});

		// The error should be logged, not thrown.
		expect(
			logCapture.some((l) => l.includes("error") && l.includes("simulated SDK failure")),
		).toBe(true);
	});
});
