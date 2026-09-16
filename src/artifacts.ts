// SPDX-License-Identifier: Apache-2.0

/**
 * Artifact extraction — parse PR/issue references from bash tool calls.
 *
 * All extraction functions are pure: they accept BashToolCall arrays and
 * return ExtractedArtifact arrays. No database writes or side effects.
 * The one exception is resolveRepoContext(), which reads the filesystem
 * to resolve git remote URLs.
 */

/**
 * A bash tool call with its command string and optional output.
 * Bridges both live (SDK adapter) and backfill (source DB query) paths.
 */
export interface BashToolCall {
	command: string;
	output?: string;
}

/**
 * An extracted artifact reference ready for deduplication and writing.
 * Does not include session_id or recorded_at — those are added by the
 * writer layer to maintain extraction/write separation.
 */
export interface ExtractedArtifact {
	artifact_type: "pr-created" | "pr-reviewed" | "issue-referenced";
	reference: string;
}

// ---------------------------------------------------------------------------
// Regex patterns for command and URL parsing
// ---------------------------------------------------------------------------

/** Matches: gh pr create ... */
const GH_PR_CREATE_RE = /^gh\s+pr\s+create\b/;

/** Matches: gh pr view|diff|checks|review <number> */
const GH_PR_REVIEW_RE = /^gh\s+pr\s+(?:view|diff|checks|review)\s+(\d+)/;

/** Matches: git fetch ... pull/<number>/head */
const GIT_FETCH_PR_RE = /pull\/(\d+)\/head/;

/** Matches: gh issue view <number> */
const GH_ISSUE_VIEW_RE = /^gh\s+issue\s+view\s+(\d+)/;

/** Matches: gh issue create ... */
const GH_ISSUE_CREATE_RE = /^gh\s+issue\s+create\b/;

/** Matches: --repo org/repo or --repo=org/repo in gh commands. */
const REPO_FLAG_RE = /--repo[= ](\S+)/;

/** Matches: github.com/org/repo/pull/<number> in URLs. */
const PR_URL_RE = /github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/g;

/** Matches: github.com/org/repo/issues/<number> in URLs. */
const ISSUE_URL_RE = /github\.com\/([^/\s]+)\/([^/\s]+)\/issues\/(\d+)/g;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract the --repo flag value from a gh command, if present.
 * Returns the org/repo string or null if no --repo flag.
 */
function extractRepoFlag(command: string): string | null {
	const match = command.match(REPO_FLAG_RE);
	return match ? match[1] : null;
}

// ---------------------------------------------------------------------------
// Extraction functions
// ---------------------------------------------------------------------------

/**
 * Extract PRs created from bash tool calls.
 *
 * Parses `gh pr create` commands and extracts PR URLs from tool output
 * (e.g., https://github.com/org/repo/pull/123 → org/repo#123).
 * Commands without output or with malformed/non-numeric PR URLs are
 * silently skipped (best-effort per command).
 */
export function extractPRsCreated(parts: BashToolCall[]): ExtractedArtifact[] {
	const seen = new Set<string>();
	const artifacts: ExtractedArtifact[] = [];

	for (const part of parts) {
		if (!GH_PR_CREATE_RE.test(part.command)) continue;
		if (!part.output) continue;

		for (const match of part.output.matchAll(PR_URL_RE)) {
			const reference = `${match[1]}/${match[2]}#${match[3]}`;
			if (!seen.has(reference)) {
				seen.add(reference);
				artifacts.push({ artifact_type: "pr-created", reference });
			}
		}
	}

	return artifacts;
}

/**
 * Extract PRs reviewed from bash tool calls.
 *
 * Parses `gh pr view|diff|checks|review <number>` commands and
 * `git fetch ... pull/<number>/head` patterns. PR numbers are combined
 * with the repo context to form org/repo#number references.
 *
 * The --repo flag, if present on a gh command, overrides the session's
 * repo context for that specific command. Commands without a resolvable
 * repo context are silently skipped.
 */
export function extractPRsReviewed(
	parts: BashToolCall[],
	repoContext: string | null,
): ExtractedArtifact[] {
	const seen = new Set<string>();
	const artifacts: ExtractedArtifact[] = [];

	for (const part of parts) {
		// gh pr view/diff/checks/review <number>
		const ghMatch = part.command.match(GH_PR_REVIEW_RE);
		if (ghMatch) {
			const prNumber = ghMatch[1];
			const repo = extractRepoFlag(part.command) ?? repoContext;
			if (repo) {
				const reference = `${repo}#${prNumber}`;
				if (!seen.has(reference)) {
					seen.add(reference);
					artifacts.push({ artifact_type: "pr-reviewed", reference });
				}
			}
			continue;
		}

		// git fetch ... pull/<number>/head
		const fetchMatch = part.command.match(GIT_FETCH_PR_RE);
		if (fetchMatch) {
			const prNumber = fetchMatch[1];
			if (repoContext) {
				const reference = `${repoContext}#${prNumber}`;
				if (!seen.has(reference)) {
					seen.add(reference);
					artifacts.push({ artifact_type: "pr-reviewed", reference });
				}
			}
		}
	}

	return artifacts;
}

/**
 * Extract issues referenced from bash tool calls.
 *
 * Parses `gh issue view <number>` commands and `gh issue create` output
 * URLs. `gh issue list` without a specific number produces no artifact.
 * Issue create output URLs (github.com/org/repo/issues/42) are classified
 * as issue-referenced since no separate issue-created type exists.
 */
export function extractIssuesReferenced(
	parts: BashToolCall[],
	repoContext: string | null,
): ExtractedArtifact[] {
	const seen = new Set<string>();
	const artifacts: ExtractedArtifact[] = [];

	for (const part of parts) {
		// gh issue view <number>
		const viewMatch = part.command.match(GH_ISSUE_VIEW_RE);
		if (viewMatch) {
			const issueNumber = viewMatch[1];
			const repo = extractRepoFlag(part.command) ?? repoContext;
			if (repo) {
				const reference = `${repo}#${issueNumber}`;
				if (!seen.has(reference)) {
					seen.add(reference);
					artifacts.push({ artifact_type: "issue-referenced", reference });
				}
			}
			continue;
		}

		// gh issue create + output URLs
		if (GH_ISSUE_CREATE_RE.test(part.command) && part.output) {
			for (const match of part.output.matchAll(ISSUE_URL_RE)) {
				const reference = `${match[1]}/${match[2]}#${match[3]}`;
				if (!seen.has(reference)) {
					seen.add(reference);
					artifacts.push({ artifact_type: "issue-referenced", reference });
				}
			}
		}
	}

	return artifacts;
}

// ---------------------------------------------------------------------------
// Repo context resolution
// ---------------------------------------------------------------------------

/**
 * Parse org/repo from a GitHub remote URL.
 *
 * Handles HTTPS (https://github.com/org/repo[.git]), SSH
 * (git@github.com:org/repo[.git]), and SSH-over-HTTPS
 * (ssh://git@github.com/org/repo[.git]) formats.
 * Returns null for non-GitHub URLs.
 */
export function parseRepoFromRemoteUrl(url: string): string | null {
	const trimmed = url.trim();

	// HTTPS / SSH-over-HTTPS: contains github.com/ followed by org/repo
	const httpsMatch = trimmed.match(/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?$/);
	if (httpsMatch) return `${httpsMatch[1]}/${httpsMatch[2]}`;

	// SSH: git@github.com:org/repo[.git]
	const sshMatch = trimmed.match(/github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/);
	if (sshMatch) return `${sshMatch[1]}/${sshMatch[2]}`;

	return null;
}

/**
 * Resolve repo context from a worktree path by reading the git remote.
 *
 * Filesystem operation — reads `git remote get-url origin` from the
 * worktree. Returns null if the worktree is inaccessible, has no
 * origin remote, or the remote is not a GitHub URL. Failures are
 * silent — artifacts are simply skipped when context is unavailable.
 */
export function resolveRepoContext(worktree: string): string | null {
	if (!worktree || worktree === "unknown") return null;
	try {
		const proc = Bun.spawnSync(["git", "-C", worktree, "remote", "get-url", "origin"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		if (proc.exitCode !== 0) return null;
		const url = proc.stdout.toString().trim();
		if (!url) return null;
		return parseRepoFromRemoteUrl(url);
	} catch {
		return null;
	}
}
