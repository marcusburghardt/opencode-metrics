#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0

/**
 * Print the permission friction report as JSON.
 *
 * The metrics database is opened read-only. Nothing in the database,
 * configuration, or metrics is modified.
 *
 * Usage:
 *   bun run scripts/permission-report.ts [--days N] [--project ID] [--db PATH]
 *
 * Output shape (stable for contract version 1):
 *   {
 *     "contract_version": 1,
 *     "generated_at": "ISO-8601",
 *     "window": { "days": 30, "since": "ISO-8601", "until": "ISO-8601" },
 *     "project": null,
 *     "totals": {
 *       "prompts": 0, "always": 0, "reject": 0,
 *       "median_wait_ms": null, "p95_wait_ms": null
 *     },
 *     "friction": [
 *       {
 *         "action": "shell", "resource": "git push",
 *         "project_id": "...", "agent": "build", "model": "...",
 *         "prompt_count": 0, "median_wait_ms": null, "p95_wait_ms": null,
 *         "always_count": 0, "reject_count": 0,
 *         "first_seen": "ISO-8601", "last_seen": "ISO-8601"
 *       }
 *     ]
 *   }
 */

import {
	DEFAULT_REPORT_DAYS,
	generatePermissionReport,
} from "../src/permission-report";

interface ReportArgs {
	days: number;
	project?: string;
	databasePath?: string;
	help: boolean;
}

function parseArgs(argv: readonly string[]): ReportArgs {
	const args: ReportArgs = { days: DEFAULT_REPORT_DAYS, help: false };

	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--help" || argument === "-h") {
			args.help = true;
			continue;
		}
		if (argument === "--days") {
			const value = argv[index + 1];
			if (value === undefined) throw new Error("--days requires a value");
			const days = Number.parseInt(value, 10);
			if (!Number.isInteger(days) || days <= 0) {
				throw new Error("--days must be a positive integer");
			}
			args.days = days;
			index += 1;
			continue;
		}
		if (argument === "--project") {
			const value = argv[index + 1];
			if (value === undefined) throw new Error("--project requires a value");
			args.project = value;
			index += 1;
			continue;
		}
		if (argument === "--db") {
			const value = argv[index + 1];
			if (value === undefined) throw new Error("--db requires a value");
			args.databasePath = value;
			index += 1;
			continue;
		}
		throw new Error(`unknown argument: ${argument}`);
	}

	return args;
}

function printHelp(): void {
	console.log(`Usage: bun run scripts/permission-report.ts [options]

Options:
  --days N       Report window in days (default ${DEFAULT_REPORT_DAYS})
  --project ID   Restrict the report to one project id
  --db PATH      Metrics database path (default: XDG data dir/metrics.db)
  -h, --help     Show this help

The database is opened read-only. Output is JSON for contract version 1.
`);
}

try {
	const args = parseArgs(process.argv.slice(2));
	if (args.help) {
		printHelp();
		process.exit(0);
	}

	const report = generatePermissionReport({
		days: args.days,
		project: args.project,
		databasePath: args.databasePath,
	});
	console.log(JSON.stringify(report, null, 2));
} catch (error) {
	console.error(`permission-report: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
}
