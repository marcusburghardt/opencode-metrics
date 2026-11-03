// SPDX-License-Identifier: Apache-2.0

import type { Database } from "bun:sqlite";
import { Plugin } from "@opencode/plugin";
import { ClassificationCache, classify, classifyBudget } from "./classifier";
import type { MetricsConfig } from "./config";
import { loadConfig, writeDefaultConfig } from "./config";
import { initDatabase } from "./db";
import type { MessageInfo, PartInfo, SDKClient } from "./extractor";
import { extractSessionData } from "./extractor";
import { syncCostPricing } from "./pricing";
import { isVersionSupported, resolvePluginVersion, SUPPORTED_PLUGIN_RANGE } from "./version";
import { writeSessionData } from "./writer";

const LOG_PREFIX = "[opencode-metrics]";

/** Default exponential backoff base for event resubscription. */
const DEFAULT_RETRY_BASE_DELAY_MS = 500;
/** Hard cap for the resubscription delay. */
const MAX_RETRY_DELAY_MS = 8000;
/** Initial attempt plus two resubscriptions. */
const DEFAULT_MAX_SUBSCRIBE_ATTEMPTS = 3;
/** Default window used to collapse duplicate terminal events for one turn. */
const DEFAULT_CAPTURE_DEBOUNCE_MS = 750;

/**
 * Event families that signal a turn may have reached a terminal state.
 *
 * V2 does not guarantee which family fires for a given turn, so we subscribe
 * to all of them and deduplicate downstream. The `types` filter still keeps
 * unrelated traffic (LSP updates, etc.) out of the stream.
 */
export const SESSION_LIFECYCLE_EVENT_TYPES = [
	"session.status",
	"session.idle",
	"session.execution.succeeded",
	"session.execution.failed",
	"session.execution.interrupted",
] as const;

/** Optional injection points for tests and for hosts that need a custom root. */
export interface SetupOptions {
	/** Sleep function used between resubscription attempts. */
	sleep?: (delayMs: number) => Promise<void>;
	/** Base delay for exponential backoff. Defaults to 500 ms. */
	retryBaseDelayMs?: number;
	/** Maximum subscribe attempts. Defaults to 3. */
	maxSubscribeAttempts?: number;
	/**
	 * Window in which duplicate terminal events for the same session collapse
	 * into one capture. Defaults to 750 ms. Set to 0 to disable debouncing.
	 */
	captureDebounceMs?: number;
	/** Clock used by the capture debouncer. Defaults to `Date.now`. */
	now?: () => number;
	/** Override the resolved `@opencode/plugin` version (tests). */
	pluginVersion?: string;
	/** Root used to resolve `@opencode/plugin` (fixtures and `check.sh`). */
	resolutionRoot?: string;
	/**
	 * Invoked once when the subscription loop has subscribed to events.
	 * Lets tests synchronize on the loop without sleeping.
	 */
	onSubscribed?: () => void;
	/**
	 * Invoked when the subscription loop settles (cleanup abort, stream
	 * completion, or terminal stop). Lets tests await loop completion so no
	 * work leaks into the next test.
	 */
	onLoopComplete?: () => void;
}

/** Options for the event subscription loop. */
export interface SubscriptionLoopOptions {
	sleep?: (delayMs: number) => Promise<void>;
	retryBaseDelayMs?: number;
	maxSubscribeAttempts?: number;
	/** Duplicate-capture debounce window. Defaults to 750 ms. */
	captureDebounceMs?: number;
	/** Clock used by the capture debouncer. Defaults to `Date.now`. */
	now?: () => number;
	/** Invoked once, immediately after the first successful subscribe call. */
	onSubscribed?: () => void;
}

/** Long-lived state created once per successful setup. */
export interface PluginRuntime {
	db: Database;
	config: MetricsConfig;
	classificationCache: ClassificationCache;
	budgetCache: ClassificationCache;
	sdkClient: SDKClient;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Render an error as `Name: message` without leaking arbitrary payloads. */
function describeError(error: unknown): string {
	if (error instanceof Error) return `${error.name}: ${error.message}`;
	return String(error);
}

function noopCleanup(): void {
	// Intentionally empty: used when the plugin is disabled.
}

function defaultSleep(delayMs: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, delayMs));
}

/** Flatten V2 tool content into a single string, ignoring non-text blocks. */
function flattenToolOutput(content: unknown): string {
	if (!Array.isArray(content)) return "";
	const text: string[] = [];
	for (const block of content) {
		if (!isRecord(block)) continue;
		if (block.type === "text" && typeof block.text === "string") {
			text.push(block.text);
		}
	}
	return text.join("\n");
}

/** Extract the string entries of an assistant snapshot's `files` array. */
function extractSnapshotFiles(message: Record<string, unknown>): string[] | undefined {
	const snapshot = message.snapshot;
	if (!isRecord(snapshot)) return undefined;
	const files = snapshot.files;
	if (!Array.isArray(files)) return undefined;
	return files.filter((file): file is string => typeof file === "string");
}

function translateUserMessage(message: Record<string, unknown>): MessageInfo {
	return {
		id: typeof message.id === "string" ? message.id : "",
		role: "user",
		parts: [{ type: "text", content: typeof message.text === "string" ? message.text : "" }],
	};
}

function translateAssistantMessage(message: Record<string, unknown>): MessageInfo {
	const parts: PartInfo[] = [];
	const content = Array.isArray(message.content) ? message.content : [];

	for (const raw of content) {
		if (!isRecord(raw)) continue;
		if (raw.type === "text" && typeof raw.text === "string") {
			parts.push({ type: "text", content: raw.text });
			continue;
		}
		if (raw.type === "tool") {
			const state = isRecord(raw.state) ? raw.state : {};
			parts.push({
				type: "tool",
				tool: typeof raw.name === "string" ? raw.name : undefined,
				args: isRecord(state.input) ? state.input : undefined,
				output: flattenToolOutput(state.content),
			});
		}
		// reasoning and unknown content variants are intentionally skipped.
	}

	const translated: MessageInfo = {
		id: typeof message.id === "string" ? message.id : "",
		role: "assistant",
		parts,
	};
	const snapshotFiles = extractSnapshotFiles(message);
	if (snapshotFiles !== undefined) translated.snapshotFiles = snapshotFiles;
	return translated;
}

/**
 * Translate V2 session messages into the local shape. Only conversation
 * messages (`user`, `assistant`) are returned; markers, idle events,
 * synthetic/system/shell messages, and unknown variants are skipped.
 */
export function translateMessages(messages: readonly unknown[]): MessageInfo[] {
	const translated: MessageInfo[] = [];
	for (const raw of messages) {
		if (!isRecord(raw)) continue;
		if (raw.type === "user") {
			translated.push(translateUserMessage(raw));
		} else if (raw.type === "assistant") {
			translated.push(translateAssistantMessage(raw));
		}
	}
	return translated;
}

/**
 * Create an SDK adapter that maps the V2 plugin context onto the unchanged
 * `SDKClient` interface.
 *
 * `session.get()` deliberately does not load messages: V2's `Session.Info`
 * already carries the session's cumulative cost and token aggregates, so the
 * message-loading path stays isolated to `session.messages()`.
 */
export function createSDKAdapter(ctx: Plugin.Context): SDKClient {
	return {
		session: {
			get: async (id) => {
				const session = await ctx.session.get({ sessionID: id });
				if (!session) return null;

				const tokens = session.tokens;
				return {
					id: session.id,
					cost: session.cost ?? 0,
					tokensInput: tokens?.input ?? 0,
					tokensOutput: tokens?.output ?? 0,
					tokensReasoning: tokens?.reasoning ?? 0,
					tokensCacheRead: tokens?.cache?.read ?? 0,
					tokensCacheWrite: tokens?.cache?.write ?? 0,
					agent: session.agent,
					model: session.model
						? {
								id: session.model.id,
								providerID: session.model.providerID,
								variant: session.model.variant,
							}
						: undefined,
					title: session.title,
					projectID: session.projectID,
					parentID: session.parentID,
					projectDirectory: session.location?.directory,
					timeCreated: session.time?.created,
					timeUpdated: session.time?.updated,
				};
			},

			messages: async (id) => {
				const messages = await ctx.session.context({ sessionID: id });
				return translateMessages(messages as readonly unknown[]);
			},
		},

		project: {
			current: async () => ({
				id: ctx.location.project.id,
				path: ctx.location.project.canonical || ctx.location.directory,
			}),
		},

		app: {
			log: (message) => {
				console.warn(message);
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
	budgetCache: ClassificationCache,
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

	// Budget classification — separate cache from work-type classification
	// so invalidation of one does not affect the other.
	let budgetTag = budgetCache.get(sessionId, data.classificationContext.message_count);
	if (!budgetTag) {
		const resolved = classifyBudget(config.budget_rules ?? [], data.classificationContext);
		if (resolved) {
			budgetCache.set(sessionId, resolved, data.classificationContext.message_count);
			budgetTag = resolved;
		}
	}

	// Update session record with the resolved classification and budget tag.
	data.session.classification = classification;
	data.session.budget_tag = budgetTag;

	// Write all data atomically to the database.
	await writeSessionData(db, data);
}

/**
 * Initialize the data directory, database, config, pricing, and caches.
 * Extracted so `setup` has exactly one error boundary and the caches are
 * created once per successful setup.
 */
export function initializePlugin(ctx: Plugin.Context): PluginRuntime {
	const { db, dataDir } = initDatabase();

	const config = loadConfig(dataDir, (message) => {
		console.warn(`${LOG_PREFIX} ${message}`);
	});

	writeDefaultConfig(dataDir);

	// Sync cost pricing rules so the adjusted-cost views can compute.
	// Failure is non-fatal — the plugin continues without adjusted costs.
	try {
		syncCostPricing(db, config.cost_pricing);
		if (config.cost_pricing.length > 0) {
			console.info(`${LOG_PREFIX} synced ${config.cost_pricing.length} cost pricing rule(s)`);
		}
	} catch (error) {
		console.error(`${LOG_PREFIX} failed to sync cost pricing: ${describeError(error)}`);
	}

	console.info(`${LOG_PREFIX} initialized`);

	return {
		db,
		config,
		classificationCache: new ClassificationCache(),
		budgetCache: new ClassificationCache(),
		sdkClient: createSDKAdapter(ctx),
	};
}

/**
 * Collapse duplicate terminal events for one turn into a single capture.
 *
 * V2 may emit several lifecycle events for the same turn (for example
 * `session.status` idle plus `session.execution.succeeded`). Keyed by session
 * id, a capture is allowed at most once per window. The map is pruned on every
 * event so a long-running process cannot grow it without bound.
 *
 * A skipped capture MUST NOT move the timestamp, otherwise a steady stream of
 * duplicates could extend the window indefinitely. A capture that throws still
 * counts as an attempt (the timestamp is recorded before the attempt) so a
 * failing session does not retry-storm.
 */
export class CaptureDebouncer {
	private readonly lastCaptureAt = new Map<string, number>();

	constructor(
		private readonly windowMs: number,
		private readonly now: () => number,
	) {}

	/** Whether a capture is allowed now; records the attempt when allowed. */
	tryAcquire(sessionId: string): boolean {
		const timestamp = this.now();

		// Evict stale entries first so the map only reflects the current window.
		for (const [id, at] of this.lastCaptureAt) {
			if (timestamp - at >= this.windowMs) this.lastCaptureAt.delete(id);
		}

		const previous = this.lastCaptureAt.get(sessionId);
		if (previous !== undefined && timestamp - previous < this.windowMs) {
			return false;
		}

		this.lastCaptureAt.set(sessionId, timestamp);
		return true;
	}

	/** Number of tracked sessions; exposed for bounded-growth tests. */
	get size(): number {
		return this.lastCaptureAt.size;
	}
}

/** Whether a `session.status` payload represents a terminal (idle) turn. */
function isTerminalStatusEvent(eventType: string, data: Record<string, unknown>): boolean | null {
	if (eventType !== "session.status") return true;

	const status = isRecord(data.status) ? data.status : undefined;
	if (!status) return null;
	return status.type === "idle";
}

/**
 * Handle one V2 lifecycle event. Validates the payload shape, decides whether
 * the family represents a terminal turn, debounces duplicates, and captures
 * the session. A capture failure is logged and swallowed so one bad session
 * cannot stop the subscription.
 *
 * Exported for testing — this is the core event handling logic separated from
 * the plugin boilerplate and SDK adapter.
 */
export async function handleSessionEvent(
	event: unknown,
	runtime: PluginRuntime,
	debouncer?: CaptureDebouncer,
): Promise<void> {
	if (!isRecord(event) || typeof event.type !== "string") return;
	const eventType = event.type;
	if (!(SESSION_LIFECYCLE_EVENT_TYPES as readonly string[]).includes(eventType)) return;

	const data = isRecord(event.data) ? event.data : undefined;
	if (!data) {
		console.warn(`${LOG_PREFIX} skipping ${eventType} event with missing data`);
		return;
	}

	const sessionId = data.sessionID;
	if (typeof sessionId !== "string" || sessionId.length === 0) {
		console.warn(`${LOG_PREFIX} skipping ${eventType} event with missing session id`);
		return;
	}

	const terminal = isTerminalStatusEvent(eventType, data);
	if (terminal === null) {
		console.warn(`${LOG_PREFIX} skipping ${eventType} event with missing status`);
		return;
	}
	// Non-terminal status transitions (busy/retry) are ignored silently.
	if (!terminal) return;

	if (debouncer && !debouncer.tryAcquire(sessionId)) {
		console.info(
			`${LOG_PREFIX} skipping duplicate capture for session ${sessionId} within debounce window`,
		);
		return;
	}

	try {
		await handleSessionIdle(
			runtime.sdkClient,
			sessionId,
			runtime.db,
			runtime.config,
			runtime.classificationCache,
			runtime.budgetCache,
		);
	} catch (error) {
		console.error(`${LOG_PREFIX} failed to capture session ${sessionId}: ${describeError(error)}`);
	}
}

/**
 * Consume the session lifecycle stream sequentially until the signal aborts,
 * the stream completes, or the retry budget is exhausted.
 *
 * Sequential handling is required for correctness: `writeMetrics` reads the
 * previous value before upserting, so overlapping handlers for the same
 * session would double-count the delta.
 */
export async function runSubscriptionLoop(
	ctx: Pick<Plugin.Context, "event">,
	runtime: PluginRuntime,
	options: SubscriptionLoopOptions,
	signal: AbortSignal,
): Promise<void> {
	const sleep = options.sleep ?? defaultSleep;
	const retryBaseDelayMs = options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
	const maxAttempts = Math.max(1, options.maxSubscribeAttempts ?? DEFAULT_MAX_SUBSCRIBE_ATTEMPTS);
	const debouncer = new CaptureDebouncer(
		options.captureDebounceMs ?? DEFAULT_CAPTURE_DEBOUNCE_MS,
		options.now ?? Date.now,
	);

	let failures = 0;
	let loggedSubscribe = false;

	while (!signal.aborted) {
		if (!loggedSubscribe) {
			console.info(`${LOG_PREFIX} subscribed to session lifecycle events`);
			loggedSubscribe = true;
			options.onSubscribed?.();
		}

		try {
			const stream = ctx.event.subscribe({ types: SESSION_LIFECYCLE_EVENT_TYPES, signal });
			for await (const event of stream) {
				// A consumed event proves the stream is healthy; the next
				// failure gets a fresh retry budget.
				failures = 0;
				if (signal.aborted) break;
				await handleSessionEvent(event, runtime, debouncer);
			}

			// Abort is a normal shutdown, not a terminal stop.
			if (signal.aborted) return;
			console.info(`${LOG_PREFIX} session lifecycle subscription completed`);
			return;
		} catch (error) {
			// Identify abort by signal state, never by message text.
			if (signal.aborted) return;

			failures += 1;
			console.error(
				`${LOG_PREFIX} session lifecycle subscription failed (attempt ${failures}/${maxAttempts}): ${describeError(error)}`,
			);

			if (failures >= maxAttempts) {
				console.error(
					`${LOG_PREFIX} session lifecycle subscription stopped after ${failures} attempts; metrics collection halted`,
				);
				return;
			}

			const delay = Math.min(retryBaseDelayMs * 2 ** (failures - 1), MAX_RETRY_DELAY_MS);
			console.info(`${LOG_PREFIX} resubscribing to session lifecycle events after ${delay}ms`);
			await sleep(delay);
		}
	}
}

/**
 * OpenCode V2 plugin setup.
 *
 * Validates the resolved `@opencode/plugin` version, initializes the data
 * store (inside a single error boundary), and starts the subscription loop.
 * Returns a cleanup function that aborts the loop. No error escapes into the
 * OpenCode runtime.
 */
export async function setupPlugin(
	ctx: Plugin.Context,
	options: SetupOptions = {},
): Promise<Plugin.Cleanup> {
	const resolution =
		options.pluginVersion !== undefined
			? {
					version: options.pluginVersion,
					compatible: isVersionSupported(options.pluginVersion),
					error: undefined,
				}
			: resolvePluginVersion(options.resolutionRoot);

	if (!resolution.compatible) {
		console.error(
			`${LOG_PREFIX} unsupported @opencode/plugin version ${resolution.version ?? "unknown"}; ` +
				`supported range is ${SUPPORTED_PLUGIN_RANGE}. Metrics collection disabled.`,
		);
		return noopCleanup;
	}

	let runtime: PluginRuntime;
	try {
		runtime = initializePlugin(ctx);
	} catch (error) {
		console.error(
			`${LOG_PREFIX} initialization failed: ${describeError(error)}. Metrics collection disabled.`,
		);
		return noopCleanup;
	}

	const controller = new AbortController();
	const loopOptions: SubscriptionLoopOptions = {
		sleep: options.sleep,
		retryBaseDelayMs: options.retryBaseDelayMs,
		maxSubscribeAttempts: options.maxSubscribeAttempts,
		captureDebounceMs: options.captureDebounceMs,
		now: options.now,
		onSubscribed: options.onSubscribed,
	};

	// The loop owns its error handling; the trailing catch is a last-resort
	// guard so a rejection can never reach the OpenCode runtime. The
	// completion hook runs in both cases so tests can await loop settlement.
	void runSubscriptionLoop(ctx, runtime, loopOptions, controller.signal).then(
		() => options.onLoopComplete?.(),
		(error) => {
			console.error(`${LOG_PREFIX} event loop terminated unexpectedly: ${describeError(error)}`);
			options.onLoopComplete?.();
		},
	);

	return () => controller.abort();
}

/**
 * OpenCode metrics plugin definition.
 *
 * Automatically collects session metrics and writes them to a local SQLite
 * database. Listens for session lifecycle events that mark a terminal turn
 * (idle status, `session.idle`, or a terminal `session.execution.*` event),
 * then extracts session data, classifies the session using configurable rules,
 * and writes metrics atomically. Duplicate terminal events for one turn are
 * debounced into a single capture.
 */
const plugin = Plugin.define({
	id: "opencode-metrics",
	setup: (ctx) => setupPlugin(ctx),
});

export default plugin;

/** Named alias so hosts and tests can call setup with injected options. */
export { setupPlugin as setup };
