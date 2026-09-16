// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import type { ClassificationContext } from "./classifier";
import { ClassificationCache, classify, classifyBudget } from "./classifier";
import type { BudgetRule, ClassificationRule } from "./config";

/** Factory for a ClassificationContext with sensible defaults. */
function makeContext(overrides: Partial<ClassificationContext> = {}): ClassificationContext {
	return {
		agent: "build",
		model: "claude-opus-4-20250514",
		project_name: "opencode-metrics",
		first_user_message: "implement feature X",
		part_content: "some content here",
		bash_commands: [],
		message_count: 5,
		...overrides,
	};
}

describe("classify", () => {
	it("returns first matching rule when multiple match", () => {
		const rules: ClassificationRule[] = [
			{
				name: "rule-a",
				conditions: [{ field: "agent", values: ["build"] }],
			},
			{
				name: "rule-b",
				conditions: [{ field: "agent", values: ["build"] }],
			},
		];

		const result = classify(rules, makeContext());

		expect(result).toBe("rule-a");
	});

	it("returns 'ad-hoc' when no rules match", () => {
		const rules: ClassificationRule[] = [
			{
				name: "only-explore",
				conditions: [{ field: "agent", values: ["explore"] }],
			},
		];

		const result = classify(rules, makeContext());

		expect(result).toBe("ad-hoc");
	});

	it("exclude condition prevents match", () => {
		const rules: ClassificationRule[] = [
			{
				name: "excluded-rule",
				conditions: [{ field: "agent", values: ["build"] }],
				exclude: [{ field: "model", pattern: "opus" }],
			},
			{
				name: "fallback",
				conditions: [],
			},
		];

		const result = classify(rules, makeContext());

		expect(result).toBe("fallback");
	});

	it("matches custom rule with exact values", () => {
		const rules: ClassificationRule[] = [
			{
				name: "planning",
				conditions: [{ field: "agent", values: ["explore", "plan"] }],
			},
		];

		const result = classify(rules, makeContext({ agent: "plan" }));

		expect(result).toBe("planning");
	});

	it("matches regex pattern on string field", () => {
		const rules: ClassificationRule[] = [
			{
				name: "pr-review",
				conditions: [
					{
						field: "first_user_message",
						pattern: "github\\.com/.+/pull/\\d+",
					},
				],
			},
		];

		const result = classify(
			rules,
			makeContext({
				first_user_message: "Review https://github.com/org/repo/pull/42",
			}),
		);

		expect(result).toBe("pr-review");
	});

	it("matches regex pattern against array fields", () => {
		const rules: ClassificationRule[] = [
			{
				name: "pr-creation",
				conditions: [{ field: "bash_commands", pattern: "gh pr create" }],
			},
		];

		const result = classify(
			rules,
			makeContext({
				bash_commands: ["git add .", "gh pr create --fill"],
			}),
		);

		expect(result).toBe("pr-creation");
	});

	it("returns false for unknown field in condition", () => {
		const rules: ClassificationRule[] = [
			{
				name: "bad-field",
				conditions: [{ field: "nonexistent", values: ["x"] }],
			},
		];

		const result = classify(rules, makeContext());

		expect(result).toBe("ad-hoc");
	});

	it("rule with empty conditions matches everything", () => {
		const rules: ClassificationRule[] = [{ name: "catch-all", conditions: [] }];

		const result = classify(rules, makeContext());

		expect(result).toBe("catch-all");
	});

	it("AND logic — all conditions must match", () => {
		const rules: ClassificationRule[] = [
			{
				name: "both-required",
				conditions: [
					{ field: "agent", values: ["build"] },
					{ field: "model", pattern: "gpt" },
				],
			},
		];

		// agent=build but model doesn't contain "gpt" → no match
		const result = classify(rules, makeContext());

		expect(result).toBe("ad-hoc");
	});

	it("exclude with no matching exclude still allows match", () => {
		const rules: ClassificationRule[] = [
			{
				name: "allowed",
				conditions: [{ field: "agent", values: ["build"] }],
				exclude: [{ field: "model", pattern: "gpt" }],
			},
		];

		// model is "claude-opus-4-20250514" which doesn't match "gpt"
		const result = classify(rules, makeContext());

		expect(result).toBe("allowed");
	});

	it("falls through to later rules when earlier ones fail", () => {
		const rules: ClassificationRule[] = [
			{
				name: "explore-only",
				conditions: [{ field: "agent", values: ["explore"] }],
			},
			{
				name: "plan-only",
				conditions: [{ field: "agent", values: ["plan"] }],
			},
			{
				name: "build-only",
				conditions: [{ field: "agent", values: ["build"] }],
			},
		];

		const result = classify(rules, makeContext({ agent: "build" }));

		expect(result).toBe("build-only");
	});
});

describe("classify — project_name field", () => {
	it("matches project_name with exact values", () => {
		const rules: ClassificationRule[] = [
			{
				name: "metrics-work",
				conditions: [{ field: "project_name", values: ["opencode-metrics", "dashboard"] }],
			},
		];

		const result = classify(rules, makeContext({ project_name: "opencode-metrics" }));

		expect(result).toBe("metrics-work");
	});

	it("does not match when project_name is not in values", () => {
		const rules: ClassificationRule[] = [
			{
				name: "other-project",
				conditions: [{ field: "project_name", values: ["dashboard"] }],
			},
		];

		const result = classify(rules, makeContext({ project_name: "opencode-metrics" }));

		expect(result).toBe("ad-hoc");
	});

	it("matches project_name with regex pattern", () => {
		const rules: ClassificationRule[] = [
			{
				name: "opencode-family",
				conditions: [{ field: "project_name", pattern: "^opencode-" }],
			},
		];

		const result = classify(rules, makeContext({ project_name: "opencode-metrics" }));

		expect(result).toBe("opencode-family");
	});

	it("does not match project_name when pattern does not match", () => {
		const rules: ClassificationRule[] = [
			{
				name: "dashboard-only",
				conditions: [{ field: "project_name", pattern: "^dashboard" }],
			},
		];

		const result = classify(rules, makeContext({ project_name: "opencode-metrics" }));

		expect(result).toBe("ad-hoc");
	});
});

describe("classifyBudget", () => {
	it("returns first matching budget_tag when multiple rules match", () => {
		const rules: BudgetRule[] = [
			{
				budget_tag: "team-alpha",
				conditions: [{ field: "agent", values: ["build"] }],
			},
			{
				budget_tag: "team-beta",
				conditions: [{ field: "agent", values: ["build"] }],
			},
		];

		const result = classifyBudget(rules, makeContext());

		expect(result).toBe("team-alpha");
	});

	it("returns null when no rules match", () => {
		const rules: BudgetRule[] = [
			{
				budget_tag: "explore-budget",
				conditions: [{ field: "agent", values: ["explore"] }],
			},
		];

		const result = classifyBudget(rules, makeContext());

		expect(result).toBeNull();
	});

	it("exclude condition prevents match", () => {
		const rules: BudgetRule[] = [
			{
				budget_tag: "excluded-budget",
				conditions: [{ field: "agent", values: ["build"] }],
				exclude: [{ field: "model", pattern: "opus" }],
			},
		];

		const result = classifyBudget(rules, makeContext());

		expect(result).toBeNull();
	});

	it("returns null for empty rules array", () => {
		const result = classifyBudget([], makeContext());

		expect(result).toBeNull();
	});

	it("matches budget rule with pattern condition", () => {
		const rules: BudgetRule[] = [
			{
				budget_tag: "pr-reviews",
				conditions: [
					{
						field: "first_user_message",
						pattern: "github\\.com/.+/pull/\\d+",
					},
				],
			},
		];

		const result = classifyBudget(
			rules,
			makeContext({
				first_user_message: "Review https://github.com/org/repo/pull/42",
			}),
		);

		expect(result).toBe("pr-reviews");
	});

	it("matches budget rule with values condition", () => {
		const rules: BudgetRule[] = [
			{
				budget_tag: "planning-budget",
				conditions: [{ field: "agent", values: ["explore", "plan"] }],
			},
		];

		const result = classifyBudget(rules, makeContext({ agent: "plan" }));

		expect(result).toBe("planning-budget");
	});

	it("matches budget rule based on project_name", () => {
		const rules: BudgetRule[] = [
			{
				budget_tag: "project-x-budget",
				conditions: [{ field: "project_name", values: ["project-x"] }],
			},
			{
				budget_tag: "metrics-budget",
				conditions: [{ field: "project_name", pattern: "^opencode-" }],
			},
		];

		const result = classifyBudget(rules, makeContext({ project_name: "opencode-metrics" }));

		expect(result).toBe("metrics-budget");
	});

	it("falls through to later rules when earlier ones fail", () => {
		const rules: BudgetRule[] = [
			{
				budget_tag: "first",
				conditions: [{ field: "agent", values: ["explore"] }],
			},
			{
				budget_tag: "second",
				conditions: [{ field: "agent", values: ["build"] }],
			},
		];

		const result = classifyBudget(rules, makeContext({ agent: "build" }));

		expect(result).toBe("second");
	});
});

describe("ClassificationCache", () => {
	it("returns null for unknown session", () => {
		const cache = new ClassificationCache();

		expect(cache.get("unknown", 5)).toBeNull();
	});

	it("returns cached result when message count matches", () => {
		const cache = new ClassificationCache();
		cache.set("sess-1", "implementation", 5);

		expect(cache.get("sess-1", 5)).toBe("implementation");
	});

	it("returns null when message count changes (cache miss)", () => {
		const cache = new ClassificationCache();
		cache.set("sess-1", "implementation", 5);

		expect(cache.get("sess-1", 6)).toBeNull();
	});

	it("invalidated entry is not retrievable afterwards", () => {
		const cache = new ClassificationCache();
		cache.set("sess-1", "implementation", 5);

		// Trigger invalidation with different message count.
		cache.get("sess-1", 6);

		// Even with original count, entry is gone.
		expect(cache.get("sess-1", 5)).toBeNull();
	});

	it("updates existing entry with new classification", () => {
		const cache = new ClassificationCache();
		cache.set("sess-1", "exploration", 5);
		cache.set("sess-1", "implementation", 10);

		expect(cache.get("sess-1", 10)).toBe("implementation");
		expect(cache.get("sess-1", 5)).toBeNull();
	});

	it("evicts oldest entry when reaching max size (LRU)", () => {
		const cache = new ClassificationCache();

		// Fill cache to max capacity (1000 entries).
		for (let i = 0; i < 1000; i++) {
			cache.set(`sess-${i}`, "type", 1);
		}

		// Adding one more should evict sess-0 (oldest).
		cache.set("sess-1000", "type", 1);

		expect(cache.get("sess-0", 1)).toBeNull();
		expect(cache.get("sess-1000", 1)).toBe("type");
	});

	it("LRU access refreshes entry position", () => {
		const cache = new ClassificationCache();

		// Fill cache to max capacity.
		for (let i = 0; i < 1000; i++) {
			cache.set(`sess-${i}`, "type", 1);
		}

		// Access sess-0 to move it to the end (most recently used).
		cache.get("sess-0", 1);

		// Add a new entry — should evict sess-1 (now the oldest), not sess-0.
		cache.set("sess-1000", "type", 1);

		expect(cache.get("sess-0", 1)).toBe("type");
		expect(cache.get("sess-1", 1)).toBeNull();
	});

	it("handles multiple sets for the same session without growing", () => {
		const cache = new ClassificationCache();

		cache.set("sess-1", "a", 1);
		cache.set("sess-1", "b", 2);
		cache.set("sess-1", "c", 3);

		// Only one entry should exist.
		expect(cache.get("sess-1", 3)).toBe("c");
	});
});
