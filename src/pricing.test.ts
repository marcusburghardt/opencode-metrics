// SPDX-License-Identifier: Apache-2.0

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CostPricingRule } from "./config";
import { initDatabase } from "./db";
import { syncCostPricing } from "./pricing";

/** Row shape returned by querying the cost_pricing table. */
interface CostPricingRow {
	model_pattern: string;
	priority: number;
	input_price: number;
	output_price: number;
	cache_read_price: number | null;
	cache_write_price: number | null;
	reasoning_price: number | null;
	description: string | null;
	updated_at: number | null;
}

/** Helper to query all rows from cost_pricing ordered by priority. */
function getAllRows(db: Database): CostPricingRow[] {
	return db.prepare("SELECT * FROM cost_pricing ORDER BY priority").all() as CostPricingRow[];
}

describe("syncCostPricing", () => {
	let tempDir: string;
	let db: Database;

	beforeEach(() => {
		tempDir = mkdtempSync(path.join(tmpdir(), "ocm-pricing-test-"));
		const result = initDatabase(tempDir);
		db = result.db;
	});

	afterEach(() => {
		db.close();
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("populates table with pricing rules", () => {
		const rules: CostPricingRule[] = [
			{
				model: "claude-sonnet-4-20250514",
				input_price: 3.0,
				output_price: 15.0,
				cache_read_price: 0.3,
				cache_write_price: 3.75,
				description: "Sonnet 4",
			},
			{
				model: "claude-opus-4-20250514",
				input_price: 15.0,
				output_price: 75.0,
				cache_read_price: 1.5,
				cache_write_price: 18.75,
				reasoning_price: 75.0,
				description: "Opus 4",
			},
		];

		syncCostPricing(db, rules);

		const rows = getAllRows(db);
		expect(rows.length).toBe(2);

		expect(rows[0].model_pattern).toBe("claude-sonnet-4-20250514");
		expect(rows[0].input_price).toBe(3.0);
		expect(rows[0].output_price).toBe(15.0);
		expect(rows[0].cache_read_price).toBe(0.3);
		expect(rows[0].cache_write_price).toBe(3.75);
		expect(rows[0].reasoning_price).toBeNull();
		expect(rows[0].description).toBe("Sonnet 4");

		expect(rows[1].model_pattern).toBe("claude-opus-4-20250514");
		expect(rows[1].input_price).toBe(15.0);
		expect(rows[1].output_price).toBe(75.0);
		expect(rows[1].reasoning_price).toBe(75.0);
		expect(rows[1].description).toBe("Opus 4");
	});

	it("clears table when given empty array", () => {
		// Seed one rule first.
		syncCostPricing(db, [{ model: "some-model", input_price: 1.0, output_price: 2.0 }]);
		expect(getAllRows(db).length).toBe(1);

		// Sync with empty array should clear.
		syncCostPricing(db, []);
		expect(getAllRows(db).length).toBe(0);
	});

	it("is idempotent — same config twice produces same rows", () => {
		const rules: CostPricingRule[] = [
			{ model: "model-a", input_price: 1.0, output_price: 2.0 },
			{ model: "model-b", input_price: 3.0, output_price: 4.0 },
		];

		syncCostPricing(db, rules);
		const firstSync = getAllRows(db);

		syncCostPricing(db, rules);
		const secondSync = getAllRows(db);

		expect(secondSync.length).toBe(firstSync.length);
		for (let i = 0; i < firstSync.length; i++) {
			expect(secondSync[i].model_pattern).toBe(firstSync[i].model_pattern);
			expect(secondSync[i].priority).toBe(firstSync[i].priority);
			expect(secondSync[i].input_price).toBe(firstSync[i].input_price);
			expect(secondSync[i].output_price).toBe(firstSync[i].output_price);
		}
	});

	it("priority reflects array order (0-indexed)", () => {
		const rules: CostPricingRule[] = [
			{ model: "first", input_price: 1.0, output_price: 1.0 },
			{ model: "second", input_price: 2.0, output_price: 2.0 },
			{ model: "third", input_price: 3.0, output_price: 3.0 },
		];

		syncCostPricing(db, rules);

		const rows = getAllRows(db);
		expect(rows[0].model_pattern).toBe("first");
		expect(rows[0].priority).toBe(0);
		expect(rows[1].model_pattern).toBe("second");
		expect(rows[1].priority).toBe(1);
		expect(rows[2].model_pattern).toBe("third");
		expect(rows[2].priority).toBe(2);
	});

	it("re-sync replaces previous rules entirely", () => {
		syncCostPricing(db, [
			{ model: "old-model-a", input_price: 1.0, output_price: 2.0 },
			{ model: "old-model-b", input_price: 3.0, output_price: 4.0 },
		]);
		expect(getAllRows(db).length).toBe(2);

		// Replace with a completely different set.
		syncCostPricing(db, [{ model: "new-model-x", input_price: 10.0, output_price: 20.0 }]);

		const rows = getAllRows(db);
		expect(rows.length).toBe(1);
		expect(rows[0].model_pattern).toBe("new-model-x");
		expect(rows[0].input_price).toBe(10.0);
		expect(rows[0].output_price).toBe(20.0);
	});

	it("sets updated_at to a recent epoch millisecond timestamp", () => {
		const before = Date.now();

		syncCostPricing(db, [{ model: "test-model", input_price: 1.0, output_price: 2.0 }]);

		const after = Date.now();
		const rows = getAllRows(db);

		expect(rows[0].updated_at).not.toBeNull();
		// updated_at should be between the timestamps bracketing the call.
		expect(rows[0].updated_at).toBeGreaterThanOrEqual(before);
		expect(rows[0].updated_at).toBeLessThanOrEqual(after);
	});

	it("maps rule.model to model_pattern column", () => {
		// Design decision D8: config uses `model`, DB uses `model_pattern`.
		const rules: CostPricingRule[] = [
			{ model: "claude-sonnet-4%", input_price: 3.0, output_price: 15.0 },
		];

		syncCostPricing(db, rules);

		const rows = getAllRows(db);
		expect(rows[0].model_pattern).toBe("claude-sonnet-4%");
		// Verify the column is actually named model_pattern (not model).
		const row = db
			.prepare("SELECT model_pattern FROM cost_pricing WHERE model_pattern = ?")
			.get("claude-sonnet-4%") as { model_pattern: string } | null;
		expect(row).not.toBeNull();
		expect(row?.model_pattern).toBe("claude-sonnet-4%");
	});

	it("stores null for optional price fields when omitted", () => {
		syncCostPricing(db, [{ model: "minimal-model", input_price: 1.0, output_price: 2.0 }]);

		const rows = getAllRows(db);
		expect(rows[0].cache_read_price).toBeNull();
		expect(rows[0].cache_write_price).toBeNull();
		expect(rows[0].reasoning_price).toBeNull();
		expect(rows[0].description).toBeNull();
	});
});
