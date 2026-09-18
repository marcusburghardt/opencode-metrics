// SPDX-License-Identifier: Apache-2.0

import type { Database } from "bun:sqlite";
import type { CostPricingRule } from "./config";

/**
 * Sync cost pricing rules from config to the cost_pricing table.
 * Uses full replace strategy: DELETE all existing rows, then INSERT
 * each rule with priority = array index.
 *
 * Design decision D8: the config field is `model` but the DB column
 * is `model_pattern` — this function maps between the two schemas.
 * The DB column uses `model_pattern` because it participates in
 * SQL LIKE matching in the v_adjusted_costs view, making the
 * pattern semantics explicit at the storage layer.
 */
export function syncCostPricing(db: Database, rules: CostPricingRule[]): void {
	const syncTransaction = db.transaction(() => {
		db.run("DELETE FROM cost_pricing");

		if (rules.length === 0) return;

		const stmt = db.prepare(
			"INSERT INTO cost_pricing (model_pattern, priority, input_price, output_price, cache_read_price, cache_write_price, reasoning_price, description, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
		);

		const now = Date.now();
		for (let i = 0; i < rules.length; i++) {
			const rule = rules[i];
			stmt.run(
				rule.model,
				i,
				rule.input_price,
				rule.output_price,
				rule.cache_read_price ?? null,
				rule.cache_write_price ?? null,
				rule.reasoning_price ?? null,
				rule.description ?? null,
				now,
			);
		}
	});

	syncTransaction();
}
