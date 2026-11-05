// SPDX-License-Identifier: Apache-2.0

/**
 * Permission event families the plugin subscribes to. They are handled
 * separately from session lifecycle events: receiving one only updates
 * per-session state and never triggers a capture on its own.
 */
export const PERMISSION_EVENT_TYPES = ["permission.asked", "permission.replied"] as const;

/** Flow metrics produced by the permission tracker. */
export interface PermissionMetrics {
	permission_prompts: number;
	permission_wait_seconds: number;
}

/** Cumulative permission state for one session. */
interface SessionPermissionState {
	/** Number of `permission.asked` events seen for the session. */
	prompts: number;
	/** Sum of closed asked → replied intervals, in milliseconds. */
	waitMs: number;
	/** Open intervals keyed by permission id, valued by the asked-at time. */
	open: Map<string, number>;
}

/**
 * Accumulate permission prompts and approval wait per session.
 *
 * Counters are cumulative for the lifetime of the plugin process so the
 * values written to `measurements` follow the same cumulative semantics as
 * every other metric (the writer derives deltas from them). Open intervals
 * stay pending across captures, so a reply that arrives after a capture is
 * counted on the next one. State is bounded by the number of sessions and is
 * dropped when the process exits; partial accounting across a restart is
 * acceptable.
 */
export class PermissionTracker {
	private readonly sessions = new Map<string, SessionPermissionState>();

	/** @param now clock used when an event does not carry a timestamp. */
	constructor(private readonly now: () => number = Date.now) {}

	private stateFor(sessionID: string): SessionPermissionState {
		let state = this.sessions.get(sessionID);
		if (!state) {
			state = { prompts: 0, waitMs: 0, open: new Map() };
			this.sessions.set(sessionID, state);
		}
		return state;
	}

	/**
	 * Record a `permission.asked` event. The prompt is always counted; the
	 * interval is only trackable when the payload carries a permission id.
	 */
	handleAsked(sessionID: string, permissionID: string | undefined, at?: number): void {
		const state = this.stateFor(sessionID);
		state.prompts += 1;
		if (permissionID) {
			state.open.set(permissionID, at ?? this.now());
		}
	}

	/**
	 * Record a `permission.replied` event. Replies without a matching open
	 * prompt are ignored, as are replies without a request id.
	 */
	handleReplied(sessionID: string, permissionID: string | undefined, at?: number): void {
		if (!permissionID) return;
		const state = this.sessions.get(sessionID);
		if (!state) return;

		const askedAt = state.open.get(permissionID);
		if (askedAt === undefined) return;

		state.open.delete(permissionID);
		const repliedAt = at ?? this.now();
		if (repliedAt > askedAt) {
			state.waitMs += repliedAt - askedAt;
		}
	}

	/**
	 * Return the cumulative metrics for a session. Closed intervals are
	 * never re-counted because they are removed when the reply arrives;
	 * counters are not reset, otherwise a later capture would write a lower
	 * cumulative value than the previous one.
	 */
	drain(sessionID: string): PermissionMetrics {
		const state = this.sessions.get(sessionID);
		if (!state) {
			return { permission_prompts: 0, permission_wait_seconds: 0 };
		}
		return {
			permission_prompts: state.prompts,
			permission_wait_seconds: state.waitMs / 1000,
		};
	}
}
