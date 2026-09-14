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

/**
 * Batch-upsert measurement rows for a session.
 * On conflict (same session_id + metric_name), overwrite value and
 * recorded_at so the latest measurement always wins.
 */
export function writeMetrics(
	db: Database,
	sessionId: string,
	metrics: ReadonlyArray<MetricRecord>,
): void {
	const stmt = db.prepare(
		`INSERT INTO measurements (session_id, metric_name, value, recorded_at)
		 VALUES (?, ?, ?, ?)
		 ON CONFLICT(session_id, metric_name) DO UPDATE SET
			value       = excluded.value,
			recorded_at = excluded.recorded_at`,
	);

	for (const metric of metrics) {
		stmt.run(sessionId, metric.metric_name, metric.value, metric.recorded_at);
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

/** Composite payload for writeSessionData(). */
export interface WriteSessionDataInput {
	project: ProjectRecord;
	session: SessionRecord;
	metrics: MetricRecord[];
}

/**
 * Write all session data atomically in a single transaction.
 * Wraps upsertProject + upsertSession + writeMetrics inside
 * db.transaction() and uses withRetry() for SQLITE_BUSY handling.
 */
export async function writeSessionData(db: Database, data: WriteSessionDataInput): Promise<void> {
	const transactionFn = db.transaction(() => {
		upsertProject(db, data.project);
		upsertSession(db, data.session);
		writeMetrics(db, data.session.session_id, data.metrics);
	});

	await withRetry(() => transactionFn());
}
