// SPDX-License-Identifier: Apache-2.0

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BashToolCall } from "./artifacts";
import {
	extractIssuesReferenced,
	extractPRsCreated,
	extractPRsReviewed,
	parseRepoFromRemoteUrl,
} from "./artifacts";
import { initDatabase } from "./db";
import { upsertArtifacts, writeMetrics } from "./writer";

// ---------------------------------------------------------------------------
// 7.1 — Extraction unit tests
// ---------------------------------------------------------------------------

describe("extractPRsCreated", () => {
	it("(a) gh pr create output with URL -> pr-created", () => {
		const parts: BashToolCall[] = [
			{
				command: "gh pr create --title 'fix bug' --body 'description'",
				output: "https://github.com/org/repo/pull/42\n",
			},
		];
		const result = extractPRsCreated(parts);

		expect(result.length).toBe(1);
		expect(result[0].artifact_type).toBe("pr-created");
		expect(result[0].reference).toBe("org/repo#42");
	});

	it("(b) gh pr create without URL output -> no artifact", () => {
		const parts: BashToolCall[] = [
			{ command: "gh pr create --title 'fix bug' --body 'description'" },
		];
		const result = extractPRsCreated(parts);

		expect(result.length).toBe(0);
	});

	it("(l) malformed PR URL (non-numeric) -> skipped", () => {
		const parts: BashToolCall[] = [
			{
				command: "gh pr create --title 'fix'",
				output: "https://github.com/org/repo/pull/abc",
			},
		];
		const result = extractPRsCreated(parts);

		expect(result.length).toBe(0);
	});

	it("(p) partial extraction: 3 commands, 1 malformed -> 2 artifacts", () => {
		const parts: BashToolCall[] = [
			{
				command: "gh pr create --title 'a'",
				output: "https://github.com/org/repo/pull/1",
			},
			{
				command: "gh pr create --title 'b'",
				output: "no url here",
			},
			{
				command: "gh pr create --title 'c'",
				output: "https://github.com/org/repo/pull/3",
			},
		];
		const result = extractPRsCreated(parts);

		expect(result.length).toBe(2);
		expect(result[0].reference).toBe("org/repo#1");
		expect(result[1].reference).toBe("org/repo#3");
	});

	it("(q) count equals detail invariant: prs_created count matches artifact count", () => {
		const parts: BashToolCall[] = [
			{
				command: "gh pr create --title 'a'",
				output: "https://github.com/org/repo/pull/1",
			},
			{
				command: "gh pr create --title 'b'",
				output: "https://github.com/org/repo/pull/2",
			},
			{
				command: "gh pr create --title 'c'",
				output: "https://github.com/org/repo/pull/3",
			},
		];
		const artifacts = extractPRsCreated(parts);

		// The count metric value equals artifacts.length — this is the
		// invariant enforced by the extraction + write pipeline.
		const countMetricValue = artifacts.length;
		const prCreatedCount = artifacts.filter((a) => a.artifact_type === "pr-created").length;

		expect(countMetricValue).toBe(prCreatedCount);
		expect(countMetricValue).toBe(3);
	});
});

describe("extractPRsReviewed", () => {
	it("(c) gh pr view 10 + repo context -> pr-reviewed with org/repo#10", () => {
		const parts: BashToolCall[] = [{ command: "gh pr view 10" }];
		const result = extractPRsReviewed(parts, "org/repo");

		expect(result.length).toBe(1);
		expect(result[0].artifact_type).toBe("pr-reviewed");
		expect(result[0].reference).toBe("org/repo#10");
	});

	it("(d) gh pr diff 10 -> same reference as view", () => {
		const parts: BashToolCall[] = [{ command: "gh pr diff 10" }];
		const result = extractPRsReviewed(parts, "org/repo");

		expect(result.length).toBe(1);
		expect(result[0].artifact_type).toBe("pr-reviewed");
		expect(result[0].reference).toBe("org/repo#10");
	});

	it("(e) git fetch pull/14/head -> pr-reviewed", () => {
		const parts: BashToolCall[] = [{ command: "git fetch origin pull/14/head:pr-14" }];
		const result = extractPRsReviewed(parts, "org/repo");

		expect(result.length).toBe(1);
		expect(result[0].artifact_type).toBe("pr-reviewed");
		expect(result[0].reference).toBe("org/repo#14");
	});

	it("(f) gh pr view 10 --repo org/other -> uses --repo value", () => {
		const parts: BashToolCall[] = [{ command: "gh pr view 10 --repo org/other" }];
		const result = extractPRsReviewed(parts, "default/repo");

		expect(result.length).toBe(1);
		expect(result[0].reference).toBe("org/other#10");
	});

	it("(m) missing repo context -> artifact silently skipped", () => {
		const parts: BashToolCall[] = [{ command: "gh pr view 10" }];
		const result = extractPRsReviewed(parts, null);

		expect(result.length).toBe(0);
	});

	it("(n) deduplication: same PR via view + diff + checks -> one artifact", () => {
		const parts: BashToolCall[] = [
			{ command: "gh pr view 10" },
			{ command: "gh pr diff 10" },
			{ command: "gh pr checks 10" },
		];
		const result = extractPRsReviewed(parts, "org/repo");

		expect(result.length).toBe(1);
		expect(result[0].reference).toBe("org/repo#10");
	});

	it("(o) multiple PRs in one session -> multiple artifacts", () => {
		const parts: BashToolCall[] = [
			{ command: "gh pr view 10" },
			{ command: "gh pr view 20" },
			{ command: "gh pr diff 30" },
		];
		const result = extractPRsReviewed(parts, "org/repo");

		expect(result.length).toBe(3);
		expect(result[0].reference).toBe("org/repo#10");
		expect(result[1].reference).toBe("org/repo#20");
		expect(result[2].reference).toBe("org/repo#30");
	});
});

describe("extractIssuesReferenced", () => {
	it("(g) gh issue view 42 -> issue-referenced", () => {
		const parts: BashToolCall[] = [{ command: "gh issue view 42" }];
		const result = extractIssuesReferenced(parts, "org/repo");

		expect(result.length).toBe(1);
		expect(result[0].artifact_type).toBe("issue-referenced");
		expect(result[0].reference).toBe("org/repo#42");
	});

	it("(h) gh issue list (no specific number) -> no artifact", () => {
		const parts: BashToolCall[] = [{ command: "gh issue list" }];
		const result = extractIssuesReferenced(parts, "org/repo");

		expect(result.length).toBe(0);
	});

	it("(r) gh issue create output with URL -> issue-referenced", () => {
		const parts: BashToolCall[] = [
			{
				command: "gh issue create --title 'bug report'",
				output: "https://github.com/org/repo/issues/42\n",
			},
		];
		const result = extractIssuesReferenced(parts, "org/repo");

		expect(result.length).toBe(1);
		expect(result[0].artifact_type).toBe("issue-referenced");
		expect(result[0].reference).toBe("org/repo#42");
	});
});

describe("parseRepoFromRemoteUrl", () => {
	it("(i) HTTPS URL -> org/repo", () => {
		const result = parseRepoFromRemoteUrl("https://github.com/org/repo.git");
		expect(result).toBe("org/repo");
	});

	it("(i) HTTPS URL without .git suffix -> org/repo", () => {
		const result = parseRepoFromRemoteUrl("https://github.com/org/repo");
		expect(result).toBe("org/repo");
	});

	it("(j) SSH URL -> org/repo", () => {
		const result = parseRepoFromRemoteUrl("git@github.com:org/repo.git");
		expect(result).toBe("org/repo");
	});

	it("(k) non-GitHub URL -> null", () => {
		const result = parseRepoFromRemoteUrl("https://gitlab.com/org/repo.git");
		expect(result).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// 7.2 — Integration test: extraction → write → verify
// ---------------------------------------------------------------------------

describe("integration: extraction to database", () => {
	let tempDir: string;
	let db: Database;

	beforeEach(() => {
		tempDir = mkdtempSync(path.join(tmpdir(), "ocm-artifacts-"));
		const result = initDatabase(tempDir);
		db = result.db;
	});

	afterEach(() => {
		db.close();
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("3 PRs reviewed -> extract -> write -> verify count-equals-detail", () => {
		const parts: BashToolCall[] = [
			{ command: "gh pr view 10" },
			{ command: "gh pr diff 20" },
			{ command: "gh pr checks 30" },
		];

		const repoContext = "org/repo";
		const artifacts = extractPRsReviewed(parts, repoContext);

		expect(artifacts.length).toBe(3);

		const sessionId = "sess-integration";
		const recordedAt = 1700003600000;

		// Write artifacts and count metric to temp DB.
		upsertArtifacts(db, sessionId, artifacts, recordedAt);
		writeMetrics(db, sessionId, [
			{ metric_name: "prs_reviewed", value: artifacts.length, recorded_at: recordedAt },
		]);

		// Verify session_artifacts has 3 rows with artifact_type="pr-reviewed".
		const rows = db
			.prepare(
				"SELECT * FROM session_artifacts WHERE session_id = ? AND artifact_type = ? ORDER BY reference",
			)
			.all(sessionId, "pr-reviewed") as Array<{
			session_id: string;
			artifact_type: string;
			reference: string;
			recorded_at: number;
		}>;

		expect(rows.length).toBe(3);
		expect(rows[0].reference).toBe("org/repo#10");
		expect(rows[1].reference).toBe("org/repo#20");
		expect(rows[2].reference).toBe("org/repo#30");

		// Verify measurements has metric_name="prs_reviewed" with value=3.
		const metric = db
			.prepare("SELECT value FROM measurements WHERE session_id = ? AND metric_name = ?")
			.get(sessionId, "prs_reviewed") as { value: number };

		expect(metric.value).toBe(3);

		// End-to-end count-equals-detail invariant.
		expect(metric.value).toBe(rows.length);
	});
});
