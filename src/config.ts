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

/** Top-level metrics configuration schema. */
export interface MetricsConfig {
	version: number;
	classification_rules: ClassificationRule[];
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
	};

	// If classification_rules is not provided, use defaults.
	if (!Array.isArray(raw.classification_rules)) {
		config.classification_rules = DEFAULT_CONFIG.classification_rules;
		return config;
	}

	// Validate each rule individually — invalid rules are skipped.
	for (const rawRule of raw.classification_rules) {
		const rule = validateRule(rawRule, log);
		if (rule !== null) {
			config.classification_rules.push(rule);
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
