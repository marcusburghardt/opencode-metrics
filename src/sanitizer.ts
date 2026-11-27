// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

/**
 * Permission resource sanitization for contract version 1.
 *
 * Canonicalization is intentionally lossy. The contract only needs recurrence
 * and risk class, never the original command. The rules below are stable for
 * minor versions:
 *
 * - Shell resources: leading environment assignments and quoting are removed,
 *   then the command head and at most one subcommand token are kept. URLs,
 *   paths, flags, numeric arguments, and shell operators are dropped.
 *   Examples: `git push origin feature/x` -> `git push`;
 *   `FOO=bar make test` -> `make test`; `curl https://x` -> `curl`.
 * - File and directory resources: the full path is never returned. The value
 *   is `<path-class>:file<extension>` or `<path-class>:dir`, where the class is
 *   one of `project`, `home`, `tmp`, `system`, or `external`.
 * - Reusable save patterns: canonicalized separately so a pattern such as
 *   `git push *` stays usable for policy analysis, while `$cmd *` is marked
 *   non-reusable.
 * - Secrets: authorization headers, bearer/basic tokens, token/password/API-key
 *   assignments, private-key markers, credentials in URLs, and long encoded
 *   blobs are redacted before a canonical value or raw value is stored.
 * - Hashing: `sha256(salt + "\0" + raw)` truncated to `HASH_HEX_LENGTH`. The
 *   salted hash supports recurrence detection without storing the raw value.
 * - Unrecognized resources: canonicalization returns `null`, so only the
 *   action and hash are stored.
 */

/** Truncated hex length of a resource hash (16 bytes). */
export const HASH_HEX_LENGTH = 32;

/** Path classes exposed by the contract. */
export type PathClass = "project" | "home" | "tmp" | "system" | "external";

/** Actions whose resources are shell command strings. */
const SHELL_ACTIONS = new Set(["shell", "bash", "exec", "command", "run", "terminal"]);

/** Actions whose resources are files, globs, or patch targets. */
const FILE_ACTIONS = new Set([
	"read",
	"write",
	"edit",
	"patch",
	"create",
	"delete",
	"remove",
	"move",
	"rename",
	"glob",
]);

/** Actions whose resources are directories or directory trees. */
const DIRECTORY_ACTIONS = new Set([
	"external_directory",
	"directory",
	"list",
	"ls",
	"grep",
	"search",
	"find",
]);

/** Absolute prefixes that identify operating-system locations. */
const SYSTEM_PREFIXES = [
	"/etc",
	"/usr",
	"/bin",
	"/sbin",
	"/var",
	"/opt",
	"/proc",
	"/sys",
	"/dev",
	"/lib",
	"/lib64",
	"/boot",
	"/snap",
	"/nix",
];

/** Matches a leading environment assignment such as `FOO=bar`. */
const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Matches an absolute or explicit relative path token. */
const PATH_TOKEN_RE = /^(?:~?\/|\.{1,2}\/|[A-Za-z]:[\\/]|\/)/;

/** Matches a URL with a scheme. URLs may carry credentials and are dropped. */
const URL_RE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

/** Matches tokens that are safe to keep as a command head or subcommand. */
const COMMAND_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9_.+-]*$/;

/** A token produced by the shell tokenizer. */
interface ShellToken {
	value: string;
	quoted: boolean;
}

/** Tokenize a shell-like string, preserving whether each token was quoted. */
function tokenize(command: string): ShellToken[] {
	const tokens: ShellToken[] = [];
	const matcher = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s]+/g;
	for (const match of command.matchAll(matcher)) {
		const raw = match[0];
		const quoted = raw.startsWith('"') || raw.startsWith("'");
		const value = quoted ? raw.slice(1, -1) : raw;
		tokens.push({ value, quoted });
	}
	return tokens;
}

/**
 * Remove credentials and secret material from a string.
 *
 * Redaction is best-effort and deliberately aggressive: a false positive only
 * loses detail the contract does not need, while a false negative would leak a
 * secret into the local database.
 */
export function redactSecrets(value: string): string {
	let result = value;

	// Private key blocks and stray markers.
	result = result.replace(
		/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gi,
		"[redacted-private-key]",
	);
	result = result.replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/gi, "[redacted-private-key]");
	result = result.replace(/-----END [A-Z0-9 ]*PRIVATE KEY-----/gi, "[redacted-private-key]");

	// Authorization headers, with or without a scheme.
	result = result.replace(
		/(authorization\s*[:=]\s*)(?:(?:bearer|basic|token)\s+)?[^\s"',;]+/gi,
		"$1[redacted]",
	);

	// Bare bearer/basic credentials and common API token prefixes.
	result = result.replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [redacted]");
	result = result.replace(/\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, "[redacted]");
	result = result.replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "[redacted]");
	result = result.replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[redacted]");
	result = result.replace(
		/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
		"[redacted]",
	);

	// Assignments that commonly carry secrets, including --token=value.
	result = result.replace(
		/((?:^|[\s-])(?:token|password|passwd|secret|api[_-]?key|access[_-]?key|client[_-]?secret|private[_-]?key)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s"',;]+)/gi,
		"$1[redacted]",
	);

	// Credentials embedded in URLs (`user:password@host`).
	result = result.replace(/\b[^\s:@/]+:[^\s@/]+@/g, "[redacted]@");

	// Long encoded or opaque blobs (base64, hex, signed URLs, hashes).
	result = result.replace(/\b[A-Za-z0-9+/=_-]{40,}\b/g, "[redacted]");

	return result;
}

/**
 * Compute the salted recurrence hash for a raw resource.
 *
 * The separator prevents ambiguous concatenations such as salt `ab` + value
 * `c` colliding with salt `a` + value `bc`.
 */
export function hashResource(salt: string, raw: string): string {
	return createHash("sha256")
		.update(`${salt}\u0000${raw}`)
		.digest("hex")
		.slice(0, HASH_HEX_LENGTH);
}

/** Whether a resource string is an absolute or explicit relative path token. */
function isPathToken(value: string): boolean {
	return PATH_TOKEN_RE.test(value);
}

/** Whether a resource string is a URL. */
function isUrl(value: string): boolean {
	return URL_RE.test(value);
}

/**
 * Map a path to its contract class.
 *
 * The project directory wins over the home directory because projects commonly
 * live under the user's home. Relative paths without a project directory are
 * treated as project paths.
 */
export function classifyPath(resource: string, projectDirectory?: string): PathClass {
	const trimmed = resource.trim();
	const expanded = trimmed.startsWith("~/") ? path.join(homedir(), trimmed.slice(2)) : trimmed;
	const isAbsolute = path.isAbsolute(expanded);

	if (!isAbsolute && projectDirectory === undefined) return "project";

	const absolute = path.resolve(projectDirectory ?? process.cwd(), expanded);

	if (projectDirectory !== undefined) {
		const project = path.resolve(projectDirectory);
		if (absolute === project || absolute.startsWith(`${project}${path.sep}`)) {
			return "project";
		}
	}

	const home = path.resolve(homedir());
	if (absolute === home || absolute.startsWith(`${home}${path.sep}`)) return "home";

	const temporary = path.resolve(tmpdir());
	if (absolute === temporary || absolute.startsWith(`${temporary}${path.sep}`)) return "tmp";
	if (absolute === path.sep + "tmp" || absolute.startsWith(`${path.sep}tmp${path.sep}`)) {
		return "tmp";
	}

	for (const prefix of SYSTEM_PREFIXES) {
		if (absolute === prefix || absolute.startsWith(`${prefix}${path.sep}`)) return "system";
	}

	return "external";
}

/** Extract a short, safe extension from a path or glob. */
export function extractExtension(resource: string): string {
	const extension = path.extname(resource.trim()).toLowerCase();
	return /^\.[a-z0-9]{1,10}$/.test(extension) ? extension : "";
}

/**
 * Canonicalize a shell resource to at most a command head and one subcommand.
 *
 * Returns `null` when no safe command head can be identified.
 */
export function canonicalizeShell(resource: string): string | null {
	const redacted = redactSecrets(resource);
	const tokens = tokenize(redacted);
	const kept: string[] = [];

	for (const token of tokens) {
		if (kept.length >= 2) break;

		const value = token.value.trim();
		if (value.length === 0) continue;
		// A leading URL, path, or assignment cannot serve as a command head.
		if (isUrl(value) || isPathToken(value)) {
			if (kept.length === 0) return null;
			continue;
		}
		if (ASSIGNMENT_RE.test(value)) continue;
		if (value.startsWith("-")) continue;
		if (/^[0-9]+$/.test(value)) continue;

		if (kept.length === 0) {
			if (!COMMAND_TOKEN_RE.test(value)) return null;
			kept.push(value);
			continue;
		}

		// Quoted arguments (spaces or punctuation) are data, not subcommands.
		if (token.quoted && /[\s:=]/.test(value)) continue;
		if (value.includes("=") || value.includes("[") || value.includes(":")) continue;
		if (!COMMAND_TOKEN_RE.test(value)) continue;

		kept.push(value);
	}

	return kept.length === 0 ? null : kept.join(" ");
}

/**
 * Canonicalize a file or directory resource to a path class and extension.
 *
 * The full path is never returned. Directory actions omit the extension.
 */
export function canonicalizePath(
	resource: string,
	projectDirectory?: string,
	isDirectory = false,
): string {
	const pathClass = classifyPath(resource, projectDirectory);
	if (isDirectory) return `${pathClass}:dir`;
	const extension = extractExtension(resource);
	return extension.length > 0 ? `${pathClass}:file${extension}` : `${pathClass}:file`;
}

/**
 * Canonicalize a resource for an action.
 *
 * Returns `null` when the action or the resource cannot be classified
 * confidently, in which case the caller stores only the action and hash.
 */
export function canonicalizeResource(
	action: string,
	resource: string,
	projectDirectory?: string,
): string | null {
	const trimmed = resource.trim();
	if (trimmed.length === 0) return null;
	if (isUrl(trimmed)) return null;

	const normalizedAction = action.trim().toLowerCase();
	if (SHELL_ACTIONS.has(normalizedAction) || normalizedAction.includes("shell")) {
		return canonicalizeShell(trimmed);
	}

	if (DIRECTORY_ACTIONS.has(normalizedAction)) {
		return canonicalizePath(trimmed, projectDirectory, true);
	}

	if (FILE_ACTIONS.has(normalizedAction)) {
		return canonicalizePath(trimmed, projectDirectory, false);
	}

	// Unknown actions: only treat path-shaped resources as safe to classify.
	if (isPathToken(trimmed)) {
		return canonicalizePath(trimmed, projectDirectory, false);
	}

	return null;
}

/**
 * Canonicalize a saved permission pattern (`save` on an `always` reply).
 *
 * Patterns keep their wildcard tokens so a consumer can tell a broad but
 * reusable pattern (`git push *`) from a placeholder pattern that will never
 * match (`$cmd *`). Secrets, URLs, flags, and assignments are removed.
 */
export function canonicalizeSavePattern(pattern: string): string {
	const redacted = redactSecrets(pattern).trim();
	if (redacted.length === 0) return "";

	const kept: string[] = [];
	for (const token of tokenize(redacted)) {
		if (kept.length >= 3) break;
		const value = token.value.trim();
		if (value.length === 0) continue;
		if (isUrl(value)) continue;
		if (ASSIGNMENT_RE.test(value)) continue;
		if (value.startsWith("-")) continue;
		if (isPathToken(value)) {
			kept.push(`<${classifyPath(value)}>`);
			continue;
		}
		kept.push(value);
	}

	return kept.join(" ");
}

/**
 * Classify a saved pattern as reusable.
 *
 * A pattern is reusable when its command head is a literal command name. Heads
 * containing placeholders (`$`, `<`, `>`, `*`, `?`, `{`, `}`, `%`) cannot match
 * a real command and are reported as non-reusable.
 */
export function isReusableSavePattern(pattern: string): boolean {
	const head = pattern.trim().split(/\s+/)[0] ?? "";
	if (head.length === 0) return false;
	if (/[<>$*?{}%]/.test(head)) return false;
	return /^[A-Za-z0-9][A-Za-z0-9_.+-]*$/.test(head);
}
