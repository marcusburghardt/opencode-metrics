// SPDX-License-Identifier: Apache-2.0

import type { Database } from "bun:sqlite";

/** Record for the projects dimension table. */
export interface ProjectRecord {
	project_id: string;
	name: string;
	worktree: string;
}

/** Record for the sessions dimension table. */
export interface SessionRecord {
	session_id: string;
	project_id: string;
	agent: string;
	model: string;
	classification: string;
	title: string;
	started_at: number;
	ended_at: number;
	metadata: string | null;
}

/** A single metric measurement to write. */
export interface MetricRecord {
	metric_name: string;
	value: number;
	recorded_at: number;
}

/**
 * Insert or update a project record.
 * On conflict (same project_id), update name and worktree to keep
 * the dimension table current with the latest project metadata.
 */
export function upsertProject(db: Database, project: ProjectRecord): void {
	db.run(
		`INSERT INTO projects (project_id, name, worktree)
		 VALUES (?, ?, ?)
		 ON CONFLICT(project_id) DO UPDATE SET
			name     = excluded.name,
			worktree = excluded.worktree`,
		[project.project_id, project.name, project.worktree],
	);
}

/**
 * Insert or update a session record.
 * On conflict (same session_id), update all fields — this allows
 * re-classification and metadata updates for ongoing sessions.
 */
export function upsertSession(db: Database, session: SessionRecord): void {
	db.run(
		`INSERT INTO sessions (session_id, project_id, agent, model, classification, title, started_at, ended_at, metadata)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(session_id) DO UPDATE SET
			project_id     = excluded.project_id,
			agent          = excluded.agent,
			model          = excluded.model,
			classification = excluded.classification,
			title          = excluded.title,
			started_at     = excluded.started_at,
			ended_at       = excluded.ended_at,
			metadata       = excluded.metadata`,
		[
			session.session_id,
			session.project_id,
			session.agent,
			session.model,
			session.classification,
			session.title,
			session.started_at,
			session.ended_at,
			session.metadata,
		],
	);
}

/** Options for writeMetrics(). */
export interface WriteMetricsOptions {
	/**
	 * When true, skip computing and storing incremental deltas in
	 * measurement_deltas. Use this for backfill imports where the
	 * cumulative value is the only data available — recording a single
	 * delta equal to the full cumulative value would distort time-sliced
	 * aggregations (e.g., attributing a multi-day session's entire cost
	 * to one day).
	 */
	skipDeltas?: boolean;
}

/**
 * Batch-upsert measurement rows for a session, optionally computing
 * and storing incremental deltas before each upsert.
 *
 * For each metric: (a) read the current cumulative value from
 * measurements, (b) compute delta = new_value - previous_value,
 * (c) INSERT OR IGNORE the delta into measurement_deltas if non-zero,
 * (d) UPSERT into measurements as before.
 *
 * The OR IGNORE clause on the delta insert ensures that a primary key
 * collision (near-impossible sub-millisecond idle events) degrades
 * gracefully without aborting the cumulative upsert.
 *
 * Pass `{ skipDeltas: true }` for backfill imports where only
 * cumulative totals are available.
 */
export function writeMetrics(
	db: Database,
	sessionId: string,
	metrics: ReadonlyArray<MetricRecord>,
	options?: WriteMetricsOptions,
): void {
	const skipDeltas = options?.skipDeltas ?? false;

	const upsertStmt = db.prepare(
		`INSERT INTO measurements (session_id, metric_name, value, recorded_at)
		 VALUES (?, ?, ?, ?)
		 ON CONFLICT(session_id, metric_name) DO UPDATE SET
			value       = excluded.value,
			recorded_at = excluded.recorded_at`,
	);

	if (skipDeltas) {
		for (const metric of metrics) {
			upsertStmt.run(sessionId, metric.metric_name, metric.value, metric.recorded_at);
		}
		return;
	}

	const readStmt = db.prepare(
		"SELECT value FROM measurements WHERE session_id = ? AND metric_name = ?",
	);
	const deltaStmt = db.prepare(
		`INSERT OR IGNORE INTO measurement_deltas (session_id, metric_name, delta, recorded_at)
		 VALUES (?, ?, ?, ?)`,
	);

	for (const metric of metrics) {
		const existing = readStmt.get(sessionId, metric.metric_name) as { value: number } | undefined;
		const previousValue = existing?.value ?? 0;
		const delta = metric.value - previousValue;

		if (delta !== 0) {
			deltaStmt.run(sessionId, metric.metric_name, delta, metric.recorded_at);
		}

		upsertStmt.run(sessionId, metric.metric_name, metric.value, metric.recorded_at);
	}
}

/**
 * Retry wrapper for SQLITE_BUSY errors.
 * Uses exponential backoff: 100ms → 200ms → 400ms.
 * Rethrows after maxRetries attempts are exhausted.
 */
export async function withRetry<T>(fn: () => T, maxRetries = 3): Promise<T> {
	const baseDelayMs = 100;

	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		try {
			return fn();
		} catch (error: unknown) {
			const isBusy =
				error instanceof Error &&
				(error.message.includes("SQLITE_BUSY") || error.message.includes("database is locked"));

			if (!isBusy || attempt >= maxRetries) {
				throw error;
			}

			// Exponential backoff: 100ms, 200ms, 400ms
			const delayMs = baseDelayMs * 2 ** attempt;
			await Bun.sleep(delayMs);
		}
	}

	// Unreachable — the loop always returns or throws.
	throw new Error("withRetry: exhausted retries");
}

/**
 * Insert artifact rows for a session using INSERT OR IGNORE.
 * The PK constraint (session_id, artifact_type, reference) handles
 * deduplication — the same PR referenced multiple times in a session
 * produces one row.
 */
export function upsertArtifacts(
	db: Database,
	sessionId: string,
	artifacts: ReadonlyArray<{ artifact_type: string; reference: string }>,
	recordedAt: number,
): void {
	const stmt = db.prepare(
		`INSERT OR IGNORE INTO session_artifacts (session_id, artifact_type, reference, recorded_at)
		 VALUES (?, ?, ?, ?)`,
	);
	for (const artifact of artifacts) {
		stmt.run(sessionId, artifact.artifact_type, artifact.reference, recordedAt);
	}
}

/** Composite payload for writeSessionData(). */
export interface WriteSessionDataInput {
	project: ProjectRecord;
	session: SessionRecord;
	metrics: MetricRecord[];
	artifacts?: Array<{ artifact_type: string; reference: string }>;
}

/**
 * Write all session data atomically in a single transaction.
 * Wraps upsertProject + upsertSession + writeMetrics + upsertArtifacts
 * inside db.transaction() and uses withRetry() for SQLITE_BUSY handling.
 */
export async function writeSessionData(db: Database, data: WriteSessionDataInput): Promise<void> {
	const transactionFn = db.transaction(() => {
		upsertProject(db, data.project);
		upsertSession(db, data.session);
		writeMetrics(db, data.session.session_id, data.metrics);
		if (data.artifacts && data.artifacts.length > 0) {
			const recordedAt = data.session.ended_at || Date.now();
			upsertArtifacts(db, data.session.session_id, data.artifacts, recordedAt);
		}
	});

	await withRetry(() => transactionFn());
}
