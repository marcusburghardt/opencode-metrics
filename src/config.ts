// SPDX-License-Identifier: Apache-2.0

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { DEFAULT_CONFIG, DEFAULT_CONFIG_YAML } from "./defaults";

/** A single condition within a classification rule. */
export interface ClassificationCondition {
	field: string;
	/** Regex pattern for string matching. */
	pattern?: string;
	/** Pre-compiled regex from pattern, created during config loading. */
	compiledPattern?: RegExp;
	/** Exact value list matching. */
	values?: string[];
}

/** A named classification rule with match/exclude conditions. */
export interface ClassificationRule {
	name: string;
	description?: string;
	/** All conditions must match (AND logic). Empty array = always matches. */
	conditions: ClassificationCondition[];
	/** If any exclude condition matches, the rule does not apply. */
	exclude?: ClassificationCondition[];
}

/**
 * A budget tagging rule that assigns a cost-tracking tag to sessions.
 * Uses the same condition semantics as ClassificationRule (AND logic,
 * regex pre-compilation) but identified by budget_tag instead of name.
 */
export interface BudgetRule {
	/** Tag identifier for budget tracking. Should be ≤128 characters (advisory). */
	budget_tag: string;
	/** All conditions must match (AND logic). */
	conditions: ClassificationCondition[];
	/** If any exclude condition matches, the rule does not apply. */
	exclude?: ClassificationCondition[];
}

/**
 * A cost pricing rule that maps a model pattern to its token pricing.
 * All price fields are in USD per million tokens.
 */
export interface CostPricingRule {
	/** Model name or pattern to match (e.g., "claude-sonnet-4-20250514"). */
	model: string;
	/** Input token price in USD per million tokens. */
	input_price: number;
	/** Output token price in USD per million tokens. */
	output_price: number;
	/** Cache read token price in USD per million tokens. */
	cache_read_price?: number;
	/** Cache write token price in USD per million tokens. */
	cache_write_price?: number;
	/** Reasoning token price in USD per million tokens. */
	reasoning_price?: number;
	/** Human-readable description of the pricing rule. */
	description?: string;
}

/** Top-level metrics configuration schema. */
export interface MetricsConfig {
	version: number;
	classification_rules: ClassificationRule[];
	budget_rules: BudgetRule[];
	cost_pricing: CostPricingRule[];
}

/**
 * Validate a single condition object from a parsed YAML rule.
 * Returns a typed ClassificationCondition or null if the condition is malformed.
 * If the condition contains an invalid regex, returns null to signal the caller
 * to skip the entire rule (per spec: invalid regex → skip that rule).
 */
function validateCondition(
	raw: unknown,
	ruleName: string,
	log?: (msg: string) => void,
): ClassificationCondition | null {
	if (typeof raw !== "object" || raw === null) {
		log?.(`Skipping rule '${ruleName}': condition is not an object`);
		return null;
	}

	const obj = raw as Record<string, unknown>;

	if (typeof obj.field !== "string") {
		log?.(`Skipping rule '${ruleName}': condition missing 'field'`);
		return null;
	}

	const condition: ClassificationCondition = { field: obj.field };

	if (typeof obj.pattern === "string") {
		try {
			// Pre-compile the regex during config loading so evaluateCondition
			// does not pay the compilation cost on every classification call.
			condition.compiledPattern = new RegExp(obj.pattern);
			condition.pattern = obj.pattern;
		} catch {
			log?.(`Skipping rule '${ruleName}': invalid regex '${obj.pattern}'`);
			return null;
		}
	}

	if (Array.isArray(obj.values)) {
		condition.values = obj.values.filter((v): v is string => typeof v === "string");
	}

	return condition;
}

/**
 * Validate a single classification rule from parsed YAML.
 * Returns a typed ClassificationRule or null if the rule is malformed.
 *
 * Validation checks:
 * - name must be a non-empty string
 * - conditions must be an array (may be empty for fallback rules)
 * - all regex patterns must compile successfully
 * - malformed conditions cause the entire rule to be skipped
 */
function validateRule(raw: unknown, log?: (msg: string) => void): ClassificationRule | null {
	if (typeof raw !== "object" || raw === null) {
		log?.("Skipping malformed rule: not an object");
		return null;
	}

	const obj = raw as Record<string, unknown>;

	if (typeof obj.name !== "string" || obj.name.length === 0) {
		log?.("Skipping rule: missing or invalid 'name'");
		return null;
	}

	if (!Array.isArray(obj.conditions)) {
		log?.(`Skipping rule '${obj.name}': 'conditions' is not an array`);
		return null;
	}

	// Validate all conditions — any invalid condition skips the entire rule.
	const conditions: ClassificationCondition[] = [];
	for (const rawCond of obj.conditions) {
		const validated = validateCondition(rawCond, obj.name, log);
		if (validated === null) {
			return null;
		}
		conditions.push(validated);
	}

	// Validate exclude conditions if present.
	let exclude: ClassificationCondition[] | undefined;
	if (Array.isArray(obj.exclude)) {
		exclude = [];
		for (const rawCond of obj.exclude) {
			const validated = validateCondition(rawCond, obj.name, log);
			if (validated === null) {
				return null;
			}
			exclude.push(validated);
		}
	}

	const rule: ClassificationRule = { name: obj.name, conditions };

	if (typeof obj.description === "string") {
		rule.description = obj.description;
	}

	if (exclude && exclude.length > 0) {
		rule.exclude = exclude;
	}

	return rule;
}

/**
 * Validate a single budget rule from parsed YAML.
 * Returns a typed BudgetRule or null if the rule is malformed.
 *
 * Reuses validateCondition() for condition validation — same semantics as
 * classification rules (AND logic, invalid regex → skip entire rule).
 *
 * Validation checks:
 * - budget_tag must be a non-empty string
 * - conditions must be an array
 * - all regex patterns must compile successfully
 * - malformed conditions cause the entire rule to be skipped
 */
function validateBudgetRule(raw: unknown, log?: (msg: string) => void): BudgetRule | null {
	if (typeof raw !== "object" || raw === null) {
		log?.("Skipping malformed budget rule: not an object");
		return null;
	}

	const obj = raw as Record<string, unknown>;

	if (typeof obj.budget_tag !== "string" || obj.budget_tag.length === 0) {
		log?.("Skipping budget rule: missing or invalid 'budget_tag'");
		return null;
	}

	if (!Array.isArray(obj.conditions)) {
		log?.(`Skipping budget rule '${obj.budget_tag}': 'conditions' is not an array`);
		return null;
	}

	// Validate all conditions — any invalid condition skips the entire rule.
	const conditions: ClassificationCondition[] = [];
	for (const rawCond of obj.conditions) {
		const validated = validateCondition(rawCond, obj.budget_tag, log);
		if (validated === null) {
			return null;
		}
		conditions.push(validated);
	}

	// Validate exclude conditions if present.
	let exclude: ClassificationCondition[] | undefined;
	if (Array.isArray(obj.exclude)) {
		exclude = [];
		for (const rawCond of obj.exclude) {
			const validated = validateCondition(rawCond, obj.budget_tag, log);
			if (validated === null) {
				return null;
			}
			exclude.push(validated);
		}
	}

	const rule: BudgetRule = { budget_tag: obj.budget_tag, conditions };

	if (exclude && exclude.length > 0) {
		rule.exclude = exclude;
	}

	return rule;
}

/**
 * Validate a single cost pricing rule from parsed YAML.
 * Returns a typed CostPricingRule or null if the rule is malformed.
 *
 * Validation checks:
 * - model must be a non-empty string
 * - input_price must be a finite positive number
 * - output_price must be a finite positive number
 * - optional price fields, when present, must be finite non-negative numbers
 * - malformed rules are skipped with a logged warning
 */
function validateCostPricingRule(
	raw: unknown,
	log?: (msg: string) => void,
): CostPricingRule | null {
	if (typeof raw !== "object" || raw === null) {
		log?.("Skipping malformed cost pricing rule: not an object");
		return null;
	}

	const obj = raw as Record<string, unknown>;

	if (typeof obj.model !== "string" || obj.model.length === 0) {
		log?.("Skipping cost pricing rule: missing or invalid 'model'");
		return null;
	}

	if (
		typeof obj.input_price !== "number" ||
		!Number.isFinite(obj.input_price) ||
		obj.input_price <= 0
	) {
		log?.(
			`Skipping cost pricing rule '${obj.model}': 'input_price' must be a finite positive number`,
		);
		return null;
	}

	if (
		typeof obj.output_price !== "number" ||
		!Number.isFinite(obj.output_price) ||
		obj.output_price <= 0
	) {
		log?.(
			`Skipping cost pricing rule '${obj.model}': 'output_price' must be a finite positive number`,
		);
		return null;
	}

	const rule: CostPricingRule = {
		model: obj.model,
		input_price: obj.input_price,
		output_price: obj.output_price,
	};

	// Validate optional price fields — must be finite non-negative when present.
	const optionalFields = ["cache_read_price", "cache_write_price", "reasoning_price"] as const;
	for (const field of optionalFields) {
		if (field in obj && obj[field] !== undefined) {
			if (
				typeof obj[field] !== "number" ||
				!Number.isFinite(obj[field] as number) ||
				(obj[field] as number) < 0
			) {
				log?.(
					`Skipping cost pricing rule '${obj.model}': '${field}' must be a finite non-negative number`,
				);
				return null;
			}
			rule[field] = obj[field] as number;
		}
	}

	if (typeof obj.description === "string") {
		rule.description = obj.description;
	}

	return rule;
}

/**
 * Load the metrics configuration from dataDir/config.yaml.
 *
 * Behavior:
 * - If the file does not exist, returns DEFAULT_CONFIG.
 * - On unparseable YAML, logs a warning and returns DEFAULT_CONFIG.
 * - On invalid regex in a rule, logs a warning and skips that rule.
 * - On type errors (e.g., conditions as string), skips the malformed rule.
 * - Merges with defaults for missing top-level fields.
 * - Unrecognized fields are silently ignored.
 */
export function loadConfig(dataDir: string, log?: (msg: string) => void): MetricsConfig {
	const configPath = path.join(dataDir, "config.yaml");

	if (!existsSync(configPath)) {
		return DEFAULT_CONFIG;
	}

	let rawYaml: string;
	try {
		rawYaml = readFileSync(configPath, "utf-8");
	} catch {
		log?.("Failed to read config.yaml, using defaults");
		return DEFAULT_CONFIG;
	}

	let parsed: unknown;
	try {
		parsed = parse(rawYaml);
	} catch {
		log?.("Invalid YAML in config.yaml, using defaults");
		return DEFAULT_CONFIG;
	}

	if (typeof parsed !== "object" || parsed === null) {
		log?.("config.yaml is not a valid object, using defaults");
		return DEFAULT_CONFIG;
	}

	const raw = parsed as Record<string, unknown>;

	// Merge with defaults: use user-provided values, fall back to defaults.
	const config: MetricsConfig = {
		version: typeof raw.version === "number" ? raw.version : DEFAULT_CONFIG.version,
		classification_rules: [],
		budget_rules: [],
		cost_pricing: [],
	};

	// If classification_rules is not provided, use defaults.
	if (!Array.isArray(raw.classification_rules)) {
		config.classification_rules = DEFAULT_CONFIG.classification_rules;
	} else {
		// Validate each rule individually — invalid rules are skipped.
		for (const rawRule of raw.classification_rules) {
			const rule = validateRule(rawRule, log);
			if (rule !== null) {
				config.classification_rules.push(rule);
			}
		}
	}

	// Parse budget_rules — defaults to empty array when absent.
	if (Array.isArray(raw.budget_rules)) {
		for (const rawRule of raw.budget_rules) {
			const rule = validateBudgetRule(rawRule, log);
			if (rule !== null) {
				config.budget_rules.push(rule);
			}
		}
	}

	// Parse cost_pricing — defaults to empty array when absent.
	// Duplicate model values are detected and skipped (first occurrence wins).
	if (Array.isArray(raw.cost_pricing)) {
		const seenModels = new Set<string>();
		for (const rawRule of raw.cost_pricing) {
			const rule = validateCostPricingRule(rawRule, log);
			if (rule !== null) {
				if (seenModels.has(rule.model)) {
					log?.(`Skipping duplicate cost pricing rule for model '${rule.model}'`);
					continue;
				}
				seenModels.add(rule.model);
				config.cost_pricing.push(rule);
			}
		}
	}

	return config;
}

/**
 * Write the default config.yaml to dataDir if the file does not exist.
 * Existing files are never overwritten — this ensures idempotency.
 */
export function writeDefaultConfig(dataDir: string): void {
	const configPath = path.join(dataDir, "config.yaml");

	if (existsSync(configPath)) {
		return;
	}

	writeFileSync(configPath, DEFAULT_CONFIG_YAML, { encoding: "utf-8", mode: 0o644 });
}
