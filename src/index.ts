// SPDX-License-Identifier: Apache-2.0

import type { Database } from "bun:sqlite";
import type { Plugin, PluginInput } from "@opencode-ai/plugin";
import { ClassificationCache, classify } from "./classifier";
import type { MetricsConfig } from "./config";
import { loadConfig, writeDefaultConfig } from "./config";
import { initDatabase } from "./db";
import type { SDKClient } from "./extractor";
import { extractSessionData } from "./extractor";
import { writeSessionData } from "./writer";

/**
 * Create an SDK adapter that maps the real OpenCode client to our
 * simplified SDKClient interface. This decouples the extractor from
 * the generated SDK types, enabling isolated testing.
 *
 * The adapter aggregates cost/token data from assistant messages into
 * SessionInfo because the SDK's Session type does not carry per-session
 * aggregated token data — those live on individual AssistantMessage records.
 * A per-session messages cache avoids double-fetching when both session.get
 * and session.messages are called for the same session ID.
 */
export function createSDKAdapter(input: PluginInput): SDKClient {
	const { client } = input;

	// Cache raw messages per session to avoid double-fetching when both
	// session.get (for token aggregation) and session.messages are called.
	const messagesCache = new Map<string, unknown[]>();

	async function fetchRawMessages(id: string): Promise<unknown[]> {
		const cached = messagesCache.get(id);
		if (cached) return cached;

		const result = await client.session.messages({ path: { id } });
		// The HeyAPI client returns { data, error }; extract the data array.
		const data: unknown[] = ((result as Record<string, unknown>)?.data as unknown[]) ?? [];
		messagesCache.set(id, data);
		return data;
	}

	return {
		session: {
			get: async (id) => {
				const sessionResult = await client.session.get({ path: { id } });
				const session = (sessionResult as Record<string, unknown>)?.data as
					| Record<string, unknown>
					| undefined;
				if (!session) return null;

				// Aggregate cost/tokens from assistant messages since the
				// Session object itself does not carry aggregated token counts.
				const rawMsgs = await fetchRawMessages(id);
				let cost = 0;
				let tokensInput = 0;
				let tokensOutput = 0;
				let tokensReasoning = 0;
				let tokensCacheRead = 0;
				let tokensCacheWrite = 0;
				let agent: string | undefined;
				let model: string | Record<string, unknown> | undefined;

				for (const raw of rawMsgs) {
					const msg = raw as Record<string, unknown>;
					const info = (msg.info ?? msg) as Record<string, unknown>;

					if (info.role === "assistant") {
						cost += (info.cost as number) ?? 0;
						const tokens = info.tokens as Record<string, unknown> | undefined;
						if (tokens) {
							tokensInput += (tokens.input as number) ?? 0;
							tokensOutput += (tokens.output as number) ?? 0;
							tokensReasoning += (tokens.reasoning as number) ?? 0;
							const cache = tokens.cache as Record<string, unknown> | undefined;
							if (cache) {
								tokensCacheRead += (cache.read as number) ?? 0;
								tokensCacheWrite += (cache.write as number) ?? 0;
							}
						}
					}

					if (info.role === "user" && !agent) {
						agent = info.agent as string | undefined;
						model = info.model as string | Record<string, unknown> | undefined;
					}
				}

				const time = session.time as Record<string, unknown> | undefined;
				const summary = session.summary as Record<string, unknown> | undefined;

				return {
					id: session.id as string,
					cost,
					tokensInput,
					tokensOutput,
					tokensReasoning,
					tokensCacheRead,
					tokensCacheWrite,
					agent,
					model,
					title: session.title as string | undefined,
					projectID: session.projectID as string | undefined,
					parentID: session.parentID as string | undefined,
					timeCreated: time?.created as number | undefined,
					timeUpdated: time?.updated as number | undefined,
					diffStats: summary
						? {
								filesChanged: summary.files as number | undefined,
								linesAdded: summary.additions as number | undefined,
								linesDeleted: summary.deletions as number | undefined,
							}
						: undefined,
				};
			},

			messages: async (id) => {
				const rawMsgs = await fetchRawMessages(id);
				return rawMsgs.map((raw) => {
					const msg = raw as Record<string, unknown>;
					const info = (msg.info ?? msg) as Record<string, unknown>;
					const parts = (msg.parts ?? []) as Array<Record<string, unknown>>;

					return {
						id: info.id as string,
						role: info.role as string,
						parts: parts.map((p) => ({
							type: p.type as string,
							content: p.type === "text" ? (p.text as string | undefined) : undefined,
							tool: p.type === "tool" ? (p.tool as string | undefined) : undefined,
							args:
								p.type === "tool"
									? ((p.state as Record<string, unknown> | undefined)?.input as
											| Record<string, unknown>
											| undefined)
									: undefined,
						})),
					};
				});
			},
		},

		project: {
			current: async () => {
				const result = await client.project.current();
				const project = (result as Record<string, unknown>)?.data as
					| Record<string, unknown>
					| undefined;
				return project
					? {
							id: project.id as string,
							path: project.worktree as string | undefined,
						}
					: null;
			},
		},

		app: {
			log: (message) => {
				client.app.log({
					body: { service: "opencode-metrics", level: "info", message },
				});
			},
		},
	};
}

/**
 * Process a session idle event: extract data, classify, write to DB.
 * Exported for testing — this is the core event handling logic separated
 * from the plugin boilerplate and SDK adapter.
 */
export async function handleSessionIdle(
	sdkClient: SDKClient,
	sessionId: string,
	db: Database,
	config: MetricsConfig,
	classificationCache: ClassificationCache,
): Promise<void> {
	const data = await extractSessionData(sdkClient, sessionId);
	if (!data) return;

	// Check cache first; reclassify if message count changed.
	let classification = classificationCache.get(
		sessionId,
		data.classificationContext.message_count,
	);
	if (!classification) {
		classification = classify(config.classification_rules, data.classificationContext);
		classificationCache.set(sessionId, classification, data.classificationContext.message_count);
	}

	// Update session record with the resolved classification.
	data.session.classification = classification;

	// Write all data atomically to the database.
	await writeSessionData(db, data);
}

/**
 * OpenCode metrics plugin entry point.
 *
 * Automatically collects session metrics and writes them to a local
 * SQLite database. Listens for "session.status" events with idle status,
 * then extracts session data, classifies the session using configurable
 * rules, and writes metrics atomically.
 *
 * All errors are caught and logged — never propagated to OpenCode.
 */
const plugin: Plugin = async (input) => {
	const { db, dataDir } = initDatabase();

	const config = loadConfig(dataDir, (msg) =>
		input.client.app.log({
			body: { service: "opencode-metrics", level: "warn", message: msg },
		}),
	);

	writeDefaultConfig(dataDir);

	input.client.app.log({
		body: {
			service: "opencode-metrics",
			level: "info",
			message: "[opencode-metrics] initialized",
		},
	});

	const classificationCache = new ClassificationCache();
	const sdkClient = createSDKAdapter(input);

	return {
		event: async ({ event }) => {
			try {
				if (event.type !== "session.status") return;

				// Narrow the event properties to access sessionID and status.
				const properties = event.properties as {
					sessionID: string;
					status: { type: string };
				};

				if (properties.status?.type !== "idle") return;

				const sessionId = properties.sessionID;
				if (!sessionId) return;

				await handleSessionIdle(sdkClient, sessionId, db, config, classificationCache);
			} catch (error) {
				input.client.app.log({
					body: {
						service: "opencode-metrics",
						level: "error",
						message: `[opencode-metrics] error: ${
							error instanceof Error ? error.message : String(error)
						}`,
					},
				});
			}
		},
	};
};

export default plugin;
