// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig, writeDefaultConfig } from "./config";
import { DEFAULT_CONFIG } from "./defaults";

describe("config", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(path.join(tmpdir(), "ocm-config-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	describe("loadConfig", () => {
		it("returns defaults when no config file exists", () => {
			const config = loadConfig(tempDir);

			expect(config.version).toBe(DEFAULT_CONFIG.version);
			expect(config.classification_rules.length).toBe(DEFAULT_CONFIG.classification_rules.length);
		});

		it("loads a valid YAML config file", () => {
			const yaml = [
				"version: 1",
				"classification_rules:",
				"  - name: custom-rule",
				"    description: A custom rule",
				"    conditions:",
				"      - field: agent",
				"        values: ['test']",
			].join("\n");
			writeFileSync(path.join(tempDir, "config.yaml"), yaml);

			const config = loadConfig(tempDir);

			expect(config.version).toBe(1);
			expect(config.classification_rules.length).toBe(1);
			expect(config.classification_rules[0].name).toBe("custom-rule");
			expect(config.classification_rules[0].description).toBe("A custom rule");
			expect(config.classification_rules[0].conditions[0].field).toBe("agent");
			expect(config.classification_rules[0].conditions[0].values).toEqual(["test"]);
		});

		it("merges defaults for missing classification_rules", () => {
			writeFileSync(path.join(tempDir, "config.yaml"), "version: 2\n");

			const config = loadConfig(tempDir);

			expect(config.version).toBe(2);
			expect(config.classification_rules.length).toBe(DEFAULT_CONFIG.classification_rules.length);
		});

		it("falls back to defaults on invalid YAML syntax", () => {
			writeFileSync(path.join(tempDir, "config.yaml"), "{{invalid: yaml!@#$%");
			const warnings: string[] = [];

			const config = loadConfig(tempDir, (msg) => warnings.push(msg));

			expect(config.version).toBe(DEFAULT_CONFIG.version);
			expect(config.classification_rules).toEqual(DEFAULT_CONFIG.classification_rules);
			expect(warnings.length).toBeGreaterThan(0);
		});

		it("skips rules with invalid regex and keeps valid ones", () => {
			const yaml = [
				"version: 1",
				"classification_rules:",
				"  - name: bad-regex",
				"    conditions:",
				"      - field: agent",
				"        pattern: '[invalid('",
				"  - name: good-rule",
				"    conditions:",
				"      - field: agent",
				"        values: ['build']",
			].join("\n");
			writeFileSync(path.join(tempDir, "config.yaml"), yaml);
			const warnings: string[] = [];

			const config = loadConfig(tempDir, (msg) => warnings.push(msg));

			expect(config.classification_rules.length).toBe(1);
			expect(config.classification_rules[0].name).toBe("good-rule");
			expect(warnings.some((w) => w.includes("invalid regex"))).toBe(true);
		});

		it("skips rules with wrong types (conditions as string)", () => {
			const yaml = [
				"version: 1",
				"classification_rules:",
				"  - name: bad-types",
				'    conditions: "not-an-array"',
				"  - name: good-rule",
				"    conditions:",
				"      - field: agent",
				"        values: ['build']",
			].join("\n");
			writeFileSync(path.join(tempDir, "config.yaml"), yaml);
			const warnings: string[] = [];

			const config = loadConfig(tempDir, (msg) => warnings.push(msg));

			expect(config.classification_rules.length).toBe(1);
			expect(config.classification_rules[0].name).toBe("good-rule");
		});

		it("skips rules missing required name field", () => {
			const yaml = [
				"version: 1",
				"classification_rules:",
				"  - conditions:",
				"      - field: agent",
				"        values: ['build']",
				"  - name: good-rule",
				"    conditions:",
				"      - field: agent",
				"        values: ['build']",
			].join("\n");
			writeFileSync(path.join(tempDir, "config.yaml"), yaml);
			const warnings: string[] = [];

			const config = loadConfig(tempDir, (msg) => warnings.push(msg));

			expect(config.classification_rules.length).toBe(1);
			expect(config.classification_rules[0].name).toBe("good-rule");
		});

		it("ignores unrecognized fields", () => {
			const yaml = [
				"version: 1",
				"unknown_field: whatever",
				"classification_rules:",
				"  - name: custom",
				"    extra_field: true",
				"    conditions:",
				"      - field: agent",
				"        values: ['build']",
				"        extra_prop: ignored",
			].join("\n");
			writeFileSync(path.join(tempDir, "config.yaml"), yaml);

			const config = loadConfig(tempDir);

			expect(config.classification_rules.length).toBe(1);
			expect(config.classification_rules[0].name).toBe("custom");
		});

		it("ignores data_dir field in config (determined by XDG_DATA_HOME)", () => {
			const yaml = [
				"version: 1",
				"data_dir: /custom/path",
				"classification_rules:",
				"  - name: rule",
				"    conditions: []",
			].join("\n");
			writeFileSync(path.join(tempDir, "config.yaml"), yaml);

			const config = loadConfig(tempDir);

			// data_dir is no longer part of MetricsConfig — field is silently ignored.
			expect((config as Record<string, unknown>).data_dir).toBeUndefined();
			expect(config.classification_rules.length).toBe(1);
		});

		it("handles rule with exclude conditions", () => {
			const yaml = [
				"version: 1",
				"classification_rules:",
				"  - name: with-exclude",
				"    conditions:",
				"      - field: agent",
				"        values: ['build']",
				"    exclude:",
				"      - field: model",
				"        pattern: 'test-model'",
			].join("\n");
			writeFileSync(path.join(tempDir, "config.yaml"), yaml);

			const config = loadConfig(tempDir);

			expect(config.classification_rules.length).toBe(1);
			expect(config.classification_rules[0].exclude).toBeDefined();
			expect(config.classification_rules[0].exclude?.length).toBe(1);
			expect(config.classification_rules[0].exclude?.[0].pattern).toBe("test-model");
		});
	});

	describe("writeDefaultConfig", () => {
		it("creates config.yaml when it does not exist", () => {
			writeDefaultConfig(tempDir);

			const content = readFileSync(path.join(tempDir, "config.yaml"), "utf-8");
			expect(content).toContain("version: 1");
			expect(content).toContain("classification_rules:");
			expect(content).toContain("pr-review");
			expect(content).toContain("ad-hoc");
		});

		it("is idempotent — does not overwrite existing file", () => {
			writeDefaultConfig(tempDir);
			const firstContent = readFileSync(path.join(tempDir, "config.yaml"), "utf-8");

			// Overwrite with custom content.
			writeFileSync(path.join(tempDir, "config.yaml"), "# custom\nversion: 99\n");

			// Second call must not overwrite.
			writeDefaultConfig(tempDir);
			const secondContent = readFileSync(path.join(tempDir, "config.yaml"), "utf-8");

			expect(secondContent).toContain("version: 99");
			expect(secondContent).not.toBe(firstContent);
		});

		it("writes parseable YAML that matches DEFAULT_CONFIG", () => {
			writeDefaultConfig(tempDir);

			const config = loadConfig(tempDir);

			expect(config.version).toBe(DEFAULT_CONFIG.version);
			expect(config.classification_rules.length).toBe(DEFAULT_CONFIG.classification_rules.length);
			for (let i = 0; i < DEFAULT_CONFIG.classification_rules.length; i++) {
				expect(config.classification_rules[i].name).toBe(
					DEFAULT_CONFIG.classification_rules[i].name,
				);
			}
		});
	});
});
