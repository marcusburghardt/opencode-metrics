// SPDX-License-Identifier: Apache-2.0

import type { Database } from "bun:sqlite";
import { PERMISSION_CONTRACT_VERSION } from "./db";
import {
	canonicalizeResource,
	canonicalizeSavePattern,
	hashResource,
	isReusableSavePattern,
	redactSecrets,
} from "./sanitizer";

/** Milliseconds in one day, used by retention. */
export const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Cleanup runs at most once per day while the plugin is active. */
export const PERMISSION_RETENTION_INTERVAL_MS = MS_PER_DAY;

/** Upper bound for a stored canonical value. */
const MAX_CANONICAL_LENGTH = 128;

/** Upper bound for an opted-in raw resource. */
const MAX_RAW_RESOURCE_LENGTH = 4096;

/** Upper bound on persisted save patterns per event. */
const MAX_SAVE_PATTERNS = 20;

/** Input payload of a `permission.asked` event. */
export interface PermissionAskedInput {
	sessionID: string;
	permissionID: string;
	action: string;
	resources: readonly string[];
	save?: readonly string[];
	source?: { type?: string; messageID?: string; id?: string };
	timestamp: number;
}

/** Input payload of a `permission.replied` event. */
export interface PermissionRepliedInput {
	sessionID: string;
	permissionID: string;
	reply: string;
	timestamp: number;
}

/** Construction options for a permission store. */
export interface PermissionStoreOptions {
	db: Database;
	/** Project directory used to classify file resources. */
	projectDirectory?: string;
	/** Persist redacted raw resources. Defaults to false. */
	storeRaw?: boolean;
}

/** Session metadata copied onto each event for grouping. */
export interface PermissionSessionMetadata {
	project_id: string | null;
	agent: string | null;
	model: string | null;
}

type SessionMetadata = PermissionSessionMetadata;

/**
 * Fill null project, agent, and model fields for one session's events.
 *
 * Permission asks can arrive before the metrics `sessions` row is written.
 * This runs after session persistence and from the reply path so grouping
 * metadata is repaired without changing the event, reply, or wait values.
 */
export function backfillPermissionMetadata(
	db: Database,
	sessionID: string,
	metadata: PermissionSessionMetadata,
): number {
	if (sessionID.length === 0) return 0;
	try {
		const marker = db
			.prepare(
				"SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'permission_events'",
			)
			.get() as { present: number } | null;
		if (marker === null) return 0;

		const result = db
			.prepare(
				`UPDATE permission_events
				 SET project_id = COALESCE(project_id, ?),
					agent = COALESCE(agent, ?),
					model = COALESCE(model, ?)
				 WHERE session_id = ?`,
			)
			.run(metadata.project_id, metadata.agent, metadata.model, sessionID);
		return result.changes;
	} catch (_error: unknown) {
		// Capture is fail-open; a metadata repair must never block anything.
		return 0;
	}
}

/**
 * Repair null grouping metadata for every stored permission event.
 *
 * Runs at startup so events captured before their session row was written, or
 * while the plugin was stopped, are grouped correctly once the row exists.
 * Event content, replies, and waits are never modified.
 */
export function backfillAllPermissionMetadata(db: Database): number {
	try {
		const marker = db
			.prepare(
				"SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'permission_events'",
			)
			.get() as { present: number } | null;
		if (marker === null) return 0;

		const result = db
			.prepare(
				`UPDATE permission_events
				 SET project_id = COALESCE(project_id,
						(SELECT project_id FROM sessions
						 WHERE sessions.session_id = permission_events.session_id)),
					agent = COALESCE(agent,
						(SELECT agent FROM sessions
						 WHERE sessions.session_id = permission_events.session_id)),
					model = COALESCE(model,
						(SELECT model FROM sessions
						 WHERE sessions.session_id = permission_events.session_id))
				 WHERE project_id IS NULL OR agent IS NULL OR model IS NULL`,
			)
			.run();
		return result.changes;
	} catch (_error: unknown) {
		return 0;
	}
}

function truncate(value: string, limit: number): string {
	return value.length > limit ? value.slice(0, limit) : value;
}

/**
 * Persist sanitized permission events for contract version 1.
 *
 * The store is observer-only: it never approves or rejects a permission. It
 * fails open by throwing to the caller, which logs and continues; no session
 * or prompt path is blocked by a capture error.
 */
export class PermissionStore {
	private readonly db: Database;
	private readonly projectDirectory?: string;
	private readonly storeRaw: boolean;
	private available: boolean | null = null;
	private salt: string | null = null;
	/** Canonical save patterns waiting for an `always` reply. */
	private readonly pendingSave = new Map<string, string[]>();

	constructor(options: PermissionStoreOptions) {
		this.db = options.db;
		this.projectDirectory = options.projectDirectory;
		this.storeRaw = options.storeRaw ?? false;
	}

	/** Whether the permission tables exist in this database. */
	isAvailable(): boolean {
		if (this.available === null) {
			try {
				const row = this.db
					.prepare(
						"SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'permission_events'",
					)
					.get() as { present: number } | null;
				this.available = row !== null;
			} catch (_error: unknown) {
				this.available = false;
			}
		}
		return this.available;
	}

	private readSalt(): string | null {
		if (this.salt !== null) return this.salt;
		// Deliberately not caught: once the event table is known to exist, a
		// read failure is a real capture error that the caller logs and
		// swallows. A missing contract row still yields null and skips capture.
		const row = this.db.prepare("SELECT salt FROM permission_contract WHERE id = 1").get() as {
			salt: string;
		} | null;
		this.salt = row?.salt ?? null;
		return this.salt;
	}

	private sessionMetadata(sessionID: string): SessionMetadata {
		try {
			const row = this.db
				.prepare("SELECT project_id, agent, model FROM sessions WHERE session_id = ?")
				.get(sessionID) as SessionMetadata | null;
			return row ?? { project_id: null, agent: null, model: null };
		} catch (_error: unknown) {
			return { project_id: null, agent: null, model: null };
		}
	}

	/**
	 * Upsert a `permission.asked` event.
	 *
	 * A duplicate delivery keeps the first asked timestamp and any reply that
	 * was already recorded; it never creates a second row.
	 */
	recordAsked(input: PermissionAskedInput): boolean {
		if (!this.isAvailable()) return false;
		const salt = this.readSalt();
		if (salt === null) return false;

		const metadata = this.sessionMetadata(input.sessionID);
		const rawResources = input.resources.filter((resource) => resource.length > 0);
		const canonical =
			rawResources
				.map((resource) => canonicalizeResource(input.action, resource, this.projectDirectory))
				.find((value): value is string => value !== null) ?? null;
		const resource = canonical === null ? null : truncate(canonical, MAX_CANONICAL_LENGTH);
		const joinedRaw = rawResources.join("\u0000");
		const resourceHash = joinedRaw.length > 0 ? hashResource(salt, joinedRaw) : null;
		const rawResource = this.storeRaw
			? truncate(redactSecrets(rawResources.join("\n")), MAX_RAW_RESOURCE_LENGTH)
			: null;

		const savePatterns = (input.save ?? [])
			.map((pattern) => canonicalizeSavePattern(pattern))
			.filter((pattern) => pattern.length > 0)
			.slice(0, MAX_SAVE_PATTERNS);
		if (savePatterns.length > 0) {
			this.pendingSave.set(input.permissionID, savePatterns);
		}

		this.db
			.prepare(
				`INSERT INTO permission_events (
					permission_id, session_id, project_id, agent, model, action,
					resource, resource_hash, raw_resource, reply, asked_at, replied_at,
					wait_ms, source_tool, source_message_id, save_patterns, save_reusable,
					contract_version
				 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL, ?, ?, NULL, NULL, ?)
				 ON CONFLICT(permission_id) DO UPDATE SET
					session_id = COALESCE(permission_events.session_id, excluded.session_id),
					project_id = COALESCE(permission_events.project_id, excluded.project_id),
					agent = COALESCE(permission_events.agent, excluded.agent),
					model = COALESCE(permission_events.model, excluded.model),
					action = COALESCE(permission_events.action, excluded.action),
					resource = COALESCE(permission_events.resource, excluded.resource),
					resource_hash = COALESCE(permission_events.resource_hash, excluded.resource_hash),
					raw_resource = COALESCE(permission_events.raw_resource, excluded.raw_resource),
					asked_at = COALESCE(permission_events.asked_at, excluded.asked_at),
					source_tool = COALESCE(permission_events.source_tool, excluded.source_tool),
					source_message_id = COALESCE(
						permission_events.source_message_id, excluded.source_message_id
					)`,
			)
			.run(
				input.permissionID,
				input.sessionID,
				metadata.project_id,
				metadata.agent,
				metadata.model,
				input.action,
				resource,
				resourceHash,
				rawResource,
				input.timestamp,
				input.source?.type ?? null,
				input.source?.messageID ?? null,
				PERMISSION_CONTRACT_VERSION,
			);

		return true;
	}

	/**
	 * Apply a `permission.replied` event to an existing row.
	 *
	 * Replies with no matching ask are ignored. On an `always` reply, the saved
	 * patterns collected from the ask are canonicalized and written separately
	 * from the presented resource. A `save_reusable` flag lets consumers flag
	 * patterns that will never match a real command.
	 */
	recordReplied(input: PermissionRepliedInput): boolean {
		if (!this.isAvailable()) return false;

		// A session row may exist by reply time even when it did not at ask
		// time. Fill any null grouping metadata without overwriting values.
		const metadata = this.sessionMetadata(input.sessionID);
		const result = this.db
			.prepare(
				`UPDATE permission_events
				 SET reply = ?,
					replied_at = ?,
					wait_ms = CASE
						WHEN asked_at IS NOT NULL AND ? >= asked_at THEN ? - asked_at
						ELSE NULL
					END,
					project_id = COALESCE(project_id, ?),
					agent = COALESCE(agent, ?),
					model = COALESCE(model, ?)
				 WHERE permission_id = ? AND session_id = ?`,
			)
			.run(
				input.reply,
				input.timestamp,
				input.timestamp,
				input.timestamp,
				metadata.project_id,
				metadata.agent,
				metadata.model,
				input.permissionID,
				input.sessionID,
			);

		if (result.changes === 0) return false;

		const patterns = this.pendingSave.get(input.permissionID);
		this.pendingSave.delete(input.permissionID);

		if (input.reply === "always" && patterns && patterns.length > 0) {
			const reusable = patterns.every(isReusableSavePattern) ? 1 : 0;
			this.db
				.prepare(
					`UPDATE permission_events
					 SET save_patterns = ?, save_reusable = ?
					 WHERE permission_id = ?`,
				)
				.run(JSON.stringify(patterns), reusable, input.permissionID);
		}

		return true;
	}

	/** Number of pending save-pattern entries; exposed for bounded-growth tests. */
	get pendingCount(): number {
		return this.pendingSave.size;
	}
}

/**
 * Delete permission events older than the retention window.
 *
 * Only `permission_events` is touched. Session measurements and every other
 * table remain intact, so disabling or expiring capture never changes the
 * existing metric history.
 */
export function cleanupExpiredPermissionEvents(
	db: Database,
	retentionDays: number,
	now: number,
): number {
	if (!Number.isFinite(retentionDays) || retentionDays <= 0) return 0;

	try {
		const marker = db
			.prepare(
				"SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'permission_events'",
			)
			.get() as { present: number } | null;
		if (marker === null) return 0;

		const cutoff = now - retentionDays * MS_PER_DAY;
		const result = db
			.prepare("DELETE FROM permission_events WHERE asked_at IS NOT NULL AND asked_at < ?")
			.run(cutoff);
		return result.changes;
	} catch (_error: unknown) {
		return 0;
	}
}

/**
 * Run retention cleanup on startup and at most once per day thereafter.
 *
 * Cleanup errors are swallowed because capture is fail-open; a retention
 * failure must never block the plugin or a permission prompt.
 */
export class PermissionRetention {
	private lastRunAt: number | null = null;

	constructor(
		private readonly db: Database,
		private readonly retentionDays: number,
		private readonly now: () => number = Date.now,
	) {}

	/**
	 * Run cleanup when the daily window has elapsed.
	 *
	 * @returns the number of removed events, or 0 when the run was skipped.
	 */
	maybeRun(): number {
		const at = this.now();
		if (this.lastRunAt !== null && at - this.lastRunAt < PERMISSION_RETENTION_INTERVAL_MS) {
			return 0;
		}
		this.lastRunAt = at;
		return cleanupExpiredPermissionEvents(this.db, this.retentionDays, at);
	}
}
