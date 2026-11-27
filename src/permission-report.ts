// SPDX-License-Identifier: Apache-2.0

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import path from "node:path";
import { getDataDir } from "./db";
import { MS_PER_DAY } from "./permission-store";

/** Default report window in days. */
export const DEFAULT_REPORT_DAYS = 30;

/** One aggregated friction row in the JSON report. */
export interface PermissionFrictionRow {
	action: string;
	resource: string | null;
	project_id: string | null;
	agent: string | null;
	model: string | null;
	prompt_count: number;
	median_wait_ms: number | null;
	p95_wait_ms: number | null;
	always_count: number;
	reject_count: number;
	first_seen: string | null;
	last_seen: string | null;
}

/** Machine-readable shape of `scripts/permission-report.ts`. */
export interface PermissionReport {
	contract_version: number | null;
	generated_at: string;
	window: {
		days: number;
		since: string;
		until: string;
	};
	project: string | null;
	totals: {
		prompts: number;
		always: number;
		reject: number;
		median_wait_ms: number | null;
		p95_wait_ms: number | null;
	};
	friction: PermissionFrictionRow[];
}

/** Options for building a report. */
export interface PermissionReportOptions {
	days?: number;
	project?: string;
	/** Clock override for deterministic tests. */
	now?: number;
}

/** A raw event row read by the report. */
interface ReportEventRow {
	action: string;
	resource: string | null;
	project_id: string | null;
	agent: string | null;
	model: string | null;
	reply: string | null;
	wait_ms: number | null;
	asked_at: number | null;
	replied_at: number | null;
}

/** Aggregate accumulator for one grouping key. */
interface FrictionAccumulator {
	action: string;
	resource: string | null;
	project_id: string | null;
	agent: string | null;
	model: string | null;
	prompts: number;
	always: number;
	reject: number;
	waits: number[];
	firstSeen: number | null;
	lastSeen: number | null;
}

/** Format an epoch-millisecond timestamp as ISO-8601 UTC. */
function toIso(timestamp: number | null): string | null {
	if (timestamp === null || !Number.isFinite(timestamp)) return null;
	return new Date(timestamp).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Nearest-rank percentile over a sorted copy of the values. */
function percentile(values: readonly number[], fraction: number): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const rank = Math.max(1, Math.ceil(fraction * sorted.length));
	return sorted[Math.min(rank - 1, sorted.length - 1)] ?? null;
}

/** Median of the values, averaging the two middle entries for even counts. */
function median(values: readonly number[]): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	if (sorted.length % 2 === 1) return sorted[middle] ?? null;
	const lower = sorted[middle - 1] ?? 0;
	const upper = sorted[middle] ?? 0;
	return (lower + upper) / 2;
}

/** Grouping key that preserves nulls as distinct empty segments. */
function groupingKey(row: ReportEventRow): string {
	return [
		row.action,
		row.resource ?? "",
		row.project_id ?? "",
		row.agent ?? "",
		row.model ?? "",
	].join("\u0000");
}

/**
 * Build a friction report from an open metrics database.
 *
 * The database is only read, and only sanitized columns are selected. Raw
 * resources are never included even when `store_raw` was enabled.
 */
export function buildPermissionReport(
	db: Database,
	options: PermissionReportOptions = {},
): PermissionReport {
	const days = options.days ?? DEFAULT_REPORT_DAYS;
	if (!Number.isInteger(days) || days <= 0) {
		throw new Error("report window must be a positive integer number of days");
	}
	const now = options.now ?? Date.now();
	const since = now - days * MS_PER_DAY;

	const contract = db.prepare("SELECT version FROM permission_contract WHERE id = 1").get() as {
		version: number;
	} | null;

	const rows = db
		.prepare(
			`SELECT action, resource, project_id, agent, model, reply, wait_ms,
				asked_at, replied_at
			 FROM permission_events
			 WHERE asked_at IS NOT NULL AND asked_at >= ?
			   AND (? IS NULL OR project_id = ?)
			 ORDER BY asked_at`,
		)
		.all(since, options.project ?? null, options.project ?? null) as ReportEventRow[];

	const groups = new Map<string, FrictionAccumulator>();
	const allWaits: number[] = [];
	let always = 0;
	let reject = 0;

	for (const row of rows) {
		const key = groupingKey(row);
		let group = groups.get(key);
		if (!group) {
			group = {
				action: row.action,
				resource: row.resource,
				project_id: row.project_id,
				agent: row.agent,
				model: row.model,
				prompts: 0,
				always: 0,
				reject: 0,
				waits: [],
				firstSeen: null,
				lastSeen: null,
			};
			groups.set(key, group);
		}

		group.prompts += 1;
		if (row.reply === "always") {
			group.always += 1;
			always += 1;
		}
		if (row.reply === "reject") {
			group.reject += 1;
			reject += 1;
		}
		if (row.wait_ms !== null && Number.isFinite(row.wait_ms)) {
			group.waits.push(row.wait_ms);
			allWaits.push(row.wait_ms);
		}

		if (row.asked_at !== null && Number.isFinite(row.asked_at)) {
			group.firstSeen =
				group.firstSeen === null ? row.asked_at : Math.min(group.firstSeen, row.asked_at);
			const seenAt = row.replied_at ?? row.asked_at;
			group.lastSeen = group.lastSeen === null ? seenAt : Math.max(group.lastSeen, seenAt);
		}
	}

	const friction: PermissionFrictionRow[] = [...groups.values()]
		.map((group) => ({
			action: group.action,
			resource: group.resource,
			project_id: group.project_id,
			agent: group.agent,
			model: group.model,
			prompt_count: group.prompts,
			median_wait_ms: median(group.waits),
			p95_wait_ms: percentile(group.waits, 0.95),
			always_count: group.always,
			reject_count: group.reject,
			first_seen: toIso(group.firstSeen),
			last_seen: toIso(group.lastSeen),
		}))
		.sort(
			(a, b) =>
				b.prompt_count - a.prompt_count || (b.median_wait_ms ?? 0) - (a.median_wait_ms ?? 0),
		);

	return {
		contract_version: contract?.version ?? null,
		generated_at: toIso(now) ?? new Date(now).toISOString(),
		window: {
			days,
			since: toIso(since) ?? new Date(since).toISOString(),
			until: toIso(now) ?? new Date(now).toISOString(),
		},
		project: options.project ?? null,
		totals: {
			prompts: rows.length,
			always,
			reject,
			median_wait_ms: median(allWaits),
			p95_wait_ms: percentile(allWaits, 0.95),
		},
		friction,
	};
}

/** Resolve the metrics database path for the report. */
export function resolveDatabasePath(databasePath?: string): string {
	return databasePath ?? path.join(getDataDir(), "metrics.db");
}

/**
 * Open the metrics database read-only and build a report.
 *
 * Throws when the database does not exist or does not expose the permission
 * contract tables, so the CLI can fail with a clear message.
 */
export function generatePermissionReport(
	options: PermissionReportOptions & { databasePath?: string } = {},
): PermissionReport {
	const databasePath = resolveDatabasePath(options.databasePath);
	if (!existsSync(databasePath)) {
		throw new Error(`metrics database not found: ${databasePath}`);
	}

	const db = new Database(databasePath, { readonly: true });
	try {
		const marker = db
			.prepare(
				"SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'permission_events'",
			)
			.get() as { present: number } | null;
		if (marker === null) {
			throw new Error(
				"permission capture is not available in this database (contract version 1 tables missing)",
			);
		}
		return buildPermissionReport(db, options);
	} finally {
		db.close();
	}
}
