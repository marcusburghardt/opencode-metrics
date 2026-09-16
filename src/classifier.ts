// SPDX-License-Identifier: Apache-2.0

import type { BudgetRule, ClassificationCondition, ClassificationRule } from "./config";

/** Context extracted from a session for classification. */
export interface ClassificationContext {
	agent: string;
	model: string;
	/** The project name derived from the session's working directory. */
	project_name: string;
	/** The first user message in the session. */
	first_user_message: string;
	/** Concatenated content from all message parts. */
	part_content: string;
	/** Bash commands extracted from tool calls. */
	bash_commands: string[];
	message_count: number;
}

/**
 * Retrieve a context field value as a string for pattern matching.
 * Array fields (bash_commands) are joined with newlines so regex
 * patterns can match against any element.
 * Returns undefined for unknown fields.
 */
function getFieldAsString(context: ClassificationContext, field: string): string | undefined {
	switch (field) {
		case "agent":
			return context.agent;
		case "model":
			return context.model;
		case "project_name":
			return context.project_name;
		case "first_user_message":
			return context.first_user_message;
		case "part_content":
			return context.part_content;
		case "bash_commands":
			return context.bash_commands.join("\n");
		case "message_count":
			return String(context.message_count);
		default:
			return undefined;
	}
}

/**
 * Retrieve the raw context field value for values-list matching.
 * Returns the value as-is (string, string[], or number).
 * Returns undefined for unknown fields.
 */
function getFieldRaw(
	context: ClassificationContext,
	field: string,
): string | string[] | number | undefined {
	switch (field) {
		case "agent":
			return context.agent;
		case "model":
			return context.model;
		case "project_name":
			return context.project_name;
		case "first_user_message":
			return context.first_user_message;
		case "part_content":
			return context.part_content;
		case "bash_commands":
			return context.bash_commands;
		case "message_count":
			return context.message_count;
		default:
			return undefined;
	}
}

/**
 * Evaluate a single condition against the classification context.
 *
 * - pattern: tests regex against the field value (arrays joined with newlines)
 * - values:  checks if the field value is in the values list
 *            (for array fields, checks if any element matches)
 * - unknown field: returns false
 */
function evaluateCondition(
	condition: ClassificationCondition,
	context: ClassificationContext,
): boolean {
	if (condition.pattern !== undefined) {
		const stringValue = getFieldAsString(context, condition.field);
		if (stringValue === undefined) {
			return false;
		}
		// Use pre-compiled regex from config loading when available.
		// Falls back to runtime compilation for programmatically-built conditions.
		const regex = condition.compiledPattern ?? new RegExp(condition.pattern);
		return regex.test(stringValue);
	}

	if (condition.values !== undefined) {
		const rawValue = getFieldRaw(context, condition.field);
		if (rawValue === undefined) {
			return false;
		}
		// For array fields, check if any element is in the values list.
		if (Array.isArray(rawValue)) {
			return rawValue.some((v) => condition.values?.includes(v) ?? false);
		}
		return condition.values.includes(String(rawValue));
	}

	return false;
}

/**
 * Structural type for any rule that carries conditions and optional excludes.
 * Both ClassificationRule and BudgetRule satisfy this shape, allowing
 * evaluateRule to be reused without coupling to either concrete type.
 */
type EvaluatableRule = {
	conditions: ClassificationCondition[];
	exclude?: ClassificationCondition[];
};

/**
 * Evaluate a rule against the context.
 *
 * All conditions must match (AND logic). If any exclude condition
 * matches, the rule is rejected. An empty conditions array always
 * matches (vacuous truth), enabling fallback rules like "ad-hoc".
 *
 * Accepts any rule satisfying the EvaluatableRule shape — both
 * ClassificationRule and BudgetRule are structurally compatible.
 */
function evaluateRule(rule: EvaluatableRule, context: ClassificationContext): boolean {
	// All conditions must match (AND logic).
	const conditionsMatch = rule.conditions.every((cond) => evaluateCondition(cond, context));
	if (!conditionsMatch) {
		return false;
	}

	// Any matching exclude condition rejects the rule.
	if (rule.exclude) {
		const excluded = rule.exclude.some((cond) => evaluateCondition(cond, context));
		if (excluded) {
			return false;
		}
	}

	return true;
}

/**
 * Classify a session by evaluating rules in order.
 * Returns the name of the first matching rule, or "ad-hoc" if no rules match.
 */
export function classify(rules: ClassificationRule[], context: ClassificationContext): string {
	for (const rule of rules) {
		if (evaluateRule(rule, context)) {
			return rule.name;
		}
	}
	return "ad-hoc";
}

/**
 * Classify a session's budget tag by evaluating budget rules in order.
 * Returns the budget_tag of the first matching rule, or null if no
 * rules match. Unlike classify(), there is no fallback default —
 * a null result means no budget tag applies.
 */
export function classifyBudget(
	rules: BudgetRule[],
	context: ClassificationContext,
): string | null {
	for (const rule of rules) {
		if (evaluateRule(rule, context)) {
			return rule.budget_tag;
		}
	}
	return null;
}

/**
 * LRU-bounded classification cache.
 *
 * Caches classification results per session, keyed by session ID.
 * Returns cached results only if the message count has not changed
 * (a changed message count signals new data that may alter classification).
 * Bounded to maxSize entries with LRU eviction.
 */
export class ClassificationCache {
	private cache: Map<string, { classification: string; messageCount: number }>;
	private readonly maxSize: number = 1000;

	constructor() {
		this.cache = new Map();
	}

	/**
	 * Retrieve a cached classification for a session.
	 * Returns null if the session is not cached or if the message count
	 * has changed since the last classification.
	 */
	get(sessionId: string, currentMessageCount: number): string | null {
		const entry = this.cache.get(sessionId);
		if (!entry) {
			return null;
		}

		// Invalidate cache if message count has changed.
		if (entry.messageCount !== currentMessageCount) {
			this.cache.delete(sessionId);
			return null;
		}

		// Move to end of Map (most recently used) by re-inserting.
		this.cache.delete(sessionId);
		this.cache.set(sessionId, entry);
		return entry.classification;
	}

	/**
	 * Cache a classification result for a session.
	 * Evicts the least recently used entry if the cache is full.
	 */
	set(sessionId: string, classification: string, messageCount: number): void {
		// Delete first if updating to maintain correct insertion order.
		if (this.cache.has(sessionId)) {
			this.cache.delete(sessionId);
		}

		// Evict the oldest (least recently used) entry if at capacity.
		if (this.cache.size >= this.maxSize) {
			const oldestKey = this.cache.keys().next().value;
			if (oldestKey !== undefined) {
				this.cache.delete(oldestKey);
			}
		}

		this.cache.set(sessionId, { classification, messageCount });
	}
}
