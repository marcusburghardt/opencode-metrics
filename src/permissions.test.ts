// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { PermissionTracker } from "./permissions";

describe("PermissionTracker", () => {
	it("records one approved prompt", () => {
		const tracker = new PermissionTracker();

		tracker.handleAsked("s1", "p1", 1000);
		tracker.handleReplied("s1", "p1", 4000);

		expect(tracker.drain("s1")).toEqual({
			permission_prompts: 1,
			permission_wait_seconds: 3,
		});
	});

	it("accumulates multiple prompts", () => {
		const tracker = new PermissionTracker();

		tracker.handleAsked("s1", "p1", 0);
		tracker.handleReplied("s1", "p1", 2000);
		tracker.handleAsked("s1", "p2", 2000);
		tracker.handleReplied("s1", "p2", 7000);
		tracker.handleAsked("s1", "p3", 7000);
		tracker.handleReplied("s1", "p3", 8000);

		expect(tracker.drain("s1")).toEqual({
			permission_prompts: 3,
			permission_wait_seconds: 8,
		});
	});

	it("keeps a pending prompt open across captures", () => {
		const tracker = new PermissionTracker();

		tracker.handleAsked("s1", "p1", 1000);

		expect(tracker.drain("s1")).toEqual({
			permission_prompts: 1,
			permission_wait_seconds: 0,
		});

		tracker.handleReplied("s1", "p1", 4000);

		// The prompt count stays cumulative; the interval closes later.
		expect(tracker.drain("s1")).toEqual({
			permission_prompts: 1,
			permission_wait_seconds: 3,
		});
	});

	it("counts a rejected prompt and its wait", () => {
		const tracker = new PermissionTracker();

		// The tracker does not inspect the reply value: allow and reject are
		// the same closed interval.
		tracker.handleAsked("s1", "p1", 0);
		tracker.handleReplied("s1", "p1", 1500);

		expect(tracker.drain("s1")).toEqual({
			permission_prompts: 1,
			permission_wait_seconds: 1.5,
		});
	});

	it("counts a prompt without a permission id but records no wait", () => {
		const tracker = new PermissionTracker();

		tracker.handleAsked("s1", undefined, 1000);
		tracker.handleReplied("s1", undefined, 4000);

		expect(tracker.drain("s1")).toEqual({
			permission_prompts: 1,
			permission_wait_seconds: 0,
		});
	});

	it("ignores a reply without a matching open prompt", () => {
		const tracker = new PermissionTracker();

		tracker.handleReplied("s1", "missing", 4000);

		expect(tracker.drain("s1")).toEqual({
			permission_prompts: 0,
			permission_wait_seconds: 0,
		});
	});

	it("falls back to the injected clock when no timestamp is given", () => {
		let now = 1000;
		const tracker = new PermissionTracker(() => now);

		tracker.handleAsked("s1", "p1");
		now = 2500;
		tracker.handleReplied("s1", "p1");

		expect(tracker.drain("s1").permission_wait_seconds).toBe(1.5);
	});

	it("returns zero metrics for an unknown session", () => {
		const tracker = new PermissionTracker();

		expect(tracker.drain("unknown")).toEqual({
			permission_prompts: 0,
			permission_wait_seconds: 0,
		});
	});
});
