// SPDX-License-Identifier: Apache-2.0

import {
	type BashToolCall,
	type ExtractedArtifact,
	extractIssuesReferenced,
	extractPRsCreated,
	extractPRsReviewed,
	resolveRepoContext,
} from "./artifacts";
import type { ClassificationContext } from "./classifier";
import type { SessionRecord } from "./writer";

/**
 * Interface matching the subset of OpenCode's SDK client we use.
 * Defined locally because the real SDK types are only available at
 * runtime inside the OpenCode process. This decouples the extractor
 * from the generated SDK client, enabling isolated testing.
 */
export interface SDKClient {
	session: {
		get: (id: string) => Promise<SessionInfo | null>;
		messages: (id: string) => Promise<MessageInfo[]>;
	};
	project: {
		current: () => Promise<ProjectInfo | null>;
	};
	app: {
		log: (message: string) => void;
	};
}

/** Simplified session data returned by the SDK adapter. */
export interface SessionInfo {
	id: string;
	cost?: number;
	tokensInput?: number;
	tokensOutput?: number;
	tokensReasoning?: number;
	tokensCacheRead?: number;
	tokensCacheWrite?: number;
	agent?: string;
	model?: string | Record<string, unknown>;
	title?: string;
	projectID?: string;
	parentID?: string;
	/** Epoch milliseconds when the session was created. */
	timeCreated?: number;
	/** Epoch milliseconds when the session was last updated. */
	timeUpdated?: number;
	diffStats?: {
		filesChanged?: number;
		linesAdded?: number;
		linesDeleted?: number;
	};
}

/** Simplified message data returned by the SDK adapter. */
export interface MessageInfo {
	id: string;
	role: string;
	parts?: PartInfo[];
}

/** Simplified part data for text and tool call parts. */
export interface PartInfo {
	type: string;
	/** Text content (for type "text" parts). */
	content?: string;
	/** Tool name (for type "tool" parts). */
	tool?: string;
	/** Tool call arguments (for type "tool" parts). */
	args?: Record<string, unknown>;
	/** Tool call output (for type "tool" parts). */
	output?: string;
}

/** Simplified project data returned by the SDK adapter. */
export interface ProjectInfo {
	id: string;
	name?: string;
	path?: string;
}

/** Complete extracted data ready for classification and writing. */
export interface ExtractedData {
	project: { project_id: string; name: string; worktree: string };
	session: SessionRecord;
	metrics: Array<{ metric_name: string; value: number; recorded_at: number }>;
	classificationContext: ClassificationContext;
	artifacts: ExtractedArtifact[];
}

/**
 * Tool names considered shell/bash-related for command extraction.
 * Matches both exact names and substring patterns via isShellTool().
 */
const SHELL_TOOL_NAMES = new Set(["bash", "shell", "terminal", "execute", "run"]);

/**
 * Check if a tool name is a shell/bash-related tool.
 * Matches exact names in the known set or names containing "bash" or "shell".
 */
function isShellTool(tool: string | undefined): boolean {
	if (!tool) return false;
	const lower = tool.toLowerCase();
	return SHELL_TOOL_NAMES.has(lower) || lower.includes("bash") || lower.includes("shell");
}

/**
 * Extract the command string from tool call arguments.
 * Looks for common argument names: "command", "cmd", "script".
 */
function extractCommandFromArgs(args: Record<string, unknown> | undefined): string | undefined {
	if (!args) return undefined;
	for (const key of ["command", "cmd", "script"]) {
		const val = args[key];
		if (typeof val === "string" && val.length > 0) return val;
	}
	return undefined;
}

/**
 * Extract the first user message text from a list of messages.
 * Concatenates all text parts from the first message with role "user".
 */
function extractFirstUserMessage(messages: MessageInfo[]): string {
	const firstUser = messages.find((m) => m.role === "user");
	if (!firstUser?.parts) return "";
	return firstUser.parts
		.filter((p) => p.type === "text" && p.content)
		.map((p) => p.content as string)
		.join("");
}

/**
 * Extract concatenated text content from all message parts.
 * Joins all text part content across all messages with newlines.
 */
function extractPartContent(messages: MessageInfo[]): string {
	return messages
		.flatMap((m) => m.parts ?? [])
		.filter((p) => p.type === "text" && p.content)
		.map((p) => p.content as string)
		.join("\n");
}

/**
 * Extract bash/shell commands from tool call parts across all messages.
 * Filters for parts with shell-related tool names and extracts command args.
 */
function extractBashCommands(messages: MessageInfo[]): string[] {
	return messages
		.flatMap((m) => m.parts ?? [])
		.filter((p) => p.type === "tool" && isShellTool(p.tool))
		.map((p) => extractCommandFromArgs(p.args))
		.filter((cmd): cmd is string => cmd !== undefined);
}

/**
 * Extract bash/shell tool calls with output from all messages.
 * Returns BashToolCall objects for use by artifact extraction functions.
 */
export function extractBashToolCalls(messages: MessageInfo[]): BashToolCall[] {
	return messages
		.flatMap((m) => m.parts ?? [])
		.filter((p) => p.type === "tool" && isShellTool(p.tool))
		.map((p) => {
			const command = extractCommandFromArgs(p.args);
			if (!command) return undefined;
			return { command, output: p.output } as BashToolCall;
		})
		.filter((tc): tc is BashToolCall => tc !== undefined);
}

/**
 * Resolve a model field to a display string.
 * Handles string models directly and object models by extracting modelID.
 */
function resolveModelString(model: string | Record<string, unknown> | undefined): string {
	if (typeof model === "string") return model;
	if (typeof model === "object" && model !== null) {
		if (typeof model.modelID === "string") return model.modelID;
		if (typeof model.id === "string") return model.id;
	}
	return "unknown";
}

/**
 * Compute cache hit ratio: tokensCacheRead / (tokensCacheRead + tokensInput).
 * Returns 0 when the denominator is 0 (no tokens processed).
 */
export function computeCacheHitRatio(cacheRead: number, tokensInput: number): number {
	const denominator = cacheRead + tokensInput;
	return denominator > 0 ? cacheRead / denominator : 0;
}

/**
 * Compute session duration in seconds from epoch-millisecond timestamps.
 * Returns 0 when either timestamp is missing (zero) or the result
 * would be negative (clock skew).
 */
export function computeDurationSeconds(timeCreated: number, timeUpdated: number): number {
	if (timeCreated <= 0 || timeUpdated <= 0) return 0;
	const durationMs = timeUpdated - timeCreated;
	return durationMs > 0 ? durationMs / 1000 : 0;
}

/**
 * Build the full metrics array from extracted session values.
 * All 12 metric catalog entries are always produced.
 */
function buildMetrics(
	values: {
		cost: number;
		tokensInput: number;
		tokensOutput: number;
		tokensReasoning: number;
		tokensCacheRead: number;
		tokensCacheWrite: number;
		cacheHitRatio: number;
		durationSeconds: number;
		filesChanged: number;
		linesAdded: number;
		linesDeleted: number;
		messagesTotal: number;
	},
	recordedAt: number,
): Array<{ metric_name: string; value: number; recorded_at: number }> {
	return [
		{ metric_name: "cost", value: values.cost, recorded_at: recordedAt },
		{ metric_name: "tokens_input", value: values.tokensInput, recorded_at: recordedAt },
		{ metric_name: "tokens_output", value: values.tokensOutput, recorded_at: recordedAt },
		{
			metric_name: "tokens_reasoning",
			value: values.tokensReasoning,
			recorded_at: recordedAt,
		},
		{
			metric_name: "tokens_cache_read",
			value: values.tokensCacheRead,
			recorded_at: recordedAt,
		},
		{
			metric_name: "tokens_cache_write",
			value: values.tokensCacheWrite,
			recorded_at: recordedAt,
		},
		{ metric_name: "cache_hit_ratio", value: values.cacheHitRatio, recorded_at: recordedAt },
		{
			metric_name: "duration_seconds",
			value: values.durationSeconds,
			recorded_at: recordedAt,
		},
		{ metric_name: "files_changed", value: values.filesChanged, recorded_at: recordedAt },
		{ metric_name: "lines_added", value: values.linesAdded, recorded_at: recordedAt },
		{ metric_name: "lines_deleted", value: values.linesDeleted, recorded_at: recordedAt },
		{ metric_name: "messages_total", value: values.messagesTotal, recorded_at: recordedAt },
	];
}

/**
 * Extract structured data from an OpenCode session via the SDK client.
 *
 * Queries session details, messages, and project info, then assembles:
 * - Project dimension record
 * - Session dimension record (classification set to "unknown" — caller
 *   is responsible for running the classifier and updating it)
 * - 15 metric measurements including derived cache_hit_ratio, duration_seconds,
 *   and PR/issue artifact counts
 * - PR/issue artifact references extracted from bash tool calls
 * - Classification context for the rule-based classifier
 *
 * Returns null if sessionId is empty. Missing fields on the session or
 * project are defaulted to 0 (numeric) or "unknown" (string).
 */
export async function extractSessionData(
	client: SDKClient,
	sessionId: string,
): Promise<ExtractedData | null> {
	if (!sessionId) {
		client.app.log("[opencode-metrics] warning: session_id is null/empty, skipping extraction");
		return null;
	}

	const session = await client.session.get(sessionId);
	const messages = await client.session.messages(sessionId);
	const project = await client.project.current();

	// Extract classification-relevant data from messages.
	const firstUserMessage = extractFirstUserMessage(messages);
	const messageCount = messages.length;
	const partContent = extractPartContent(messages);
	const bashCommands = extractBashCommands(messages);

	// Session fields with safe defaults for missing data.
	const cost = session?.cost ?? 0;
	const tokensInput = session?.tokensInput ?? 0;
	const tokensOutput = session?.tokensOutput ?? 0;
	const tokensReasoning = session?.tokensReasoning ?? 0;
	const tokensCacheRead = session?.tokensCacheRead ?? 0;
	const tokensCacheWrite = session?.tokensCacheWrite ?? 0;
	const agent = session?.agent ?? "unknown";
	const title = session?.title ?? "unknown";
	const projectId = project?.id ?? session?.projectID ?? "unknown";
	const projectName = project?.name ?? "unknown";
	const timeCreated = session?.timeCreated ?? 0;
	const timeUpdated = session?.timeUpdated ?? 0;
	const model = resolveModelString(session?.model);

	// Derived metrics (Task 6.5).
	const cacheHitRatio = computeCacheHitRatio(tokensCacheRead, tokensInput);
	const durationSeconds = computeDurationSeconds(timeCreated, timeUpdated);

	// Use timeUpdated as the recorded_at timestamp, falling back to now.
	const recordedAt = timeUpdated || Date.now();

	const metrics = buildMetrics(
		{
			cost,
			tokensInput,
			tokensOutput,
			tokensReasoning,
			tokensCacheRead,
			tokensCacheWrite,
			cacheHitRatio,
			durationSeconds,
			filesChanged: session?.diffStats?.filesChanged ?? 0,
			linesAdded: session?.diffStats?.linesAdded ?? 0,
			linesDeleted: session?.diffStats?.linesDeleted ?? 0,
			messagesTotal: messageCount,
		},
		recordedAt,
	);

	// Extract PR/issue artifacts from bash tool calls.
	const bashToolCalls = extractBashToolCalls(messages);
	const repoContext = project?.path ? resolveRepoContext(project.path) : null;

	const prsCreated = extractPRsCreated(bashToolCalls);
	const prsReviewed = extractPRsReviewed(bashToolCalls, repoContext);
	const issuesReferenced = extractIssuesReferenced(bashToolCalls, repoContext);
	const artifacts = [...prsCreated, ...prsReviewed, ...issuesReferenced];

	// Append artifact count metrics alongside the base 12 metrics.
	metrics.push(
		{ metric_name: "prs_created", value: prsCreated.length, recorded_at: recordedAt },
		{ metric_name: "prs_reviewed", value: prsReviewed.length, recorded_at: recordedAt },
		{
			metric_name: "issues_referenced",
			value: issuesReferenced.length,
			recorded_at: recordedAt,
		},
	);

	return {
		project: {
			project_id: projectId,
			name: project?.name ?? "unknown",
			worktree: project?.path ?? "unknown",
		},
		session: {
			session_id: sessionId,
			project_id: projectId,
			agent,
			model,
			classification: "unknown",
			title,
			started_at: timeCreated,
			ended_at: timeUpdated,
			metadata: null,
			budget_tag: null,
		},
		metrics,
		classificationContext: {
			agent,
			model,
			project_name: projectName,
			first_user_message: firstUserMessage,
			part_content: partContent,
			bash_commands: bashCommands,
			message_count: messageCount,
		},
		artifacts,
	};
}
