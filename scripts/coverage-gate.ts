#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0

/**
 * Coverage ratchet for opencode-metrics.
 *
 * Reads an lcov report (`bun test --coverage --coverage-reporter=lcov`),
 * enforces an overall line-coverage floor for `src/`, and enforces a
 * per-file floor for the files this plugin owns. Prints measured values and
 * exits non-zero on regression.
 *
 * Usage:
 *   bun run scripts/coverage-gate.ts [path/to/lcov.info]
 */

import { existsSync, readFileSync } from "node:fs";

/** Overall line-coverage floor across first-party `src/` files. */
const PROJECT_TARGET = 0.8;

/** Per-file line-coverage floors. */
const FILE_FLOORS: Readonly<Record<string, number>> = {
	"src/index.ts": 0.8,
	"src/extractor.ts": 0.8,
};

interface FileCoverage {
	file: string;
	linesFound: number;
	linesHit: number;
}

function normalize(file: string): string {
	return file.replaceAll("\\", "/");
}

/** Parse the subset of lcov we need: SF, LF, and LH records. */
export function parseLcov(report: string): FileCoverage[] {
	const records: FileCoverage[] = [];
	let file: string | null = null;
	let linesFound = 0;
	let linesHit = 0;

	const flush = () => {
		if (file !== null) records.push({ file: normalize(file), linesFound, linesHit });
		file = null;
		linesFound = 0;
		linesHit = 0;
	};

	for (const rawLine of report.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (line.startsWith("SF:")) {
			flush();
			file = line.slice("SF:".length);
		} else if (line.startsWith("LF:")) {
			linesFound = Number(line.slice("LF:".length));
		} else if (line.startsWith("LH:")) {
			linesHit = Number(line.slice("LH:".length));
		} else if (line === "end_of_record") {
			flush();
		}
	}
	flush();
	return records;
}

function ratio(hit: number, found: number): number {
	// Fail closed on an unparseable lcov record: Number("abc") is NaN, and a
	// NaN ratio must never compare as "passing" (NaN < target is false).
	if (!Number.isFinite(hit) || !Number.isFinite(found)) return Number.NaN;
	return found > 0 ? hit / found : 0;
}

function percent(value: number): string {
	return `${(value * 100).toFixed(1)}%`;
}

/** First-party source files only; scripts are exercised separately. */
export function isProjectFile(file: string): boolean {
	const normalized = normalize(file);
	return normalized.startsWith("src/") || normalized.includes("/src/");
}

/**
 * Evaluate coverage records. Returns a process exit code and the formatted
 * report lines, so the logic is testable without exiting.
 */
export function evaluateCoverage(records: FileCoverage[]): {
	exitCode: number;
	lines: string[];
} {
	const lines: string[] = [];
	let exitCode = 0;

	const projectFiles = records.filter((record) => isProjectFile(record.file));
	const totalFound = projectFiles.reduce((sum, record) => sum + record.linesFound, 0);
	const totalHit = projectFiles.reduce((sum, record) => sum + record.linesHit, 0);
	const projectRatio = ratio(totalHit, totalFound);

	lines.push(
		`Project (src/) line coverage: ${percent(projectRatio)} (${totalHit}/${totalFound}) — floor ${percent(PROJECT_TARGET)}`,
	);
	if (!Number.isFinite(projectRatio) || projectRatio < PROJECT_TARGET) {
		lines.push("FAIL: project coverage is below the floor (or unparseable)");
		exitCode = 1;
	}

	for (const [target, floor] of Object.entries(FILE_FLOORS)) {
		const record = records.find((candidate) => normalize(candidate.file).endsWith(target));
		if (!record) {
			lines.push(`FAIL: no coverage record for ${target}`);
			exitCode = 1;
			continue;
		}
		const fileRatio = ratio(record.linesHit, record.linesFound);
		lines.push(
			`${target} line coverage: ${percent(fileRatio)} (${record.linesHit}/${record.linesFound}) — floor ${percent(floor)}`,
		);
		if (!Number.isFinite(fileRatio) || fileRatio < floor) {
			lines.push(`FAIL: ${target} is below its per-file floor (or unparseable)`);
			exitCode = 1;
		}
	}

	return { exitCode, lines };
}

if (import.meta.main) {
	const reportPath = process.argv[2] ?? "coverage/lcov.info";

	if (!existsSync(reportPath)) {
		console.error(
			`coverage-gate: report not found at ${reportPath}. Run "bun test --coverage --coverage-reporter=lcov" first.`,
		);
		process.exit(1);
	}

	const records = parseLcov(readFileSync(reportPath, "utf-8"));
	const result = evaluateCoverage(records);
	for (const line of result.lines) console.log(line);
	process.exit(result.exitCode);
}
