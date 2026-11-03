// SPDX-License-Identifier: Apache-2.0

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Supported `@opencode/plugin` range.
 *
 * The package is pinned at 2.2.5 at build time but resolved at runtime,
 * so a mismatch is possible when a host upgrades OpenCode. This guard
 * turns that mismatch into an actionable log line instead of an opaque
 * import failure.
 */
export const SUPPORTED_PLUGIN_RANGE = ">=2.2.5 <3.0.0";

/** Lowest supported `@opencode/plugin` version (inclusive). */
const MIN_VERSION: readonly [number, number, number] = [2, 2, 5];
/** First unsupported `@opencode/plugin` version (exclusive). */
const MAX_VERSION: readonly [number, number, number] = [3, 0, 0];

/** Result of resolving the runtime `@opencode/plugin` version. */
export interface ResolvedPluginVersion {
	/** Parsed version string, or null when the package could not be read. */
	version: string | null;
	/** Whether the version falls inside SUPPORTED_PLUGIN_RANGE. */
	compatible: boolean;
	/** Why resolution failed, when it did. Never includes file contents. */
	error?: string;
}

interface ParsedVersion {
	major: number;
	minor: number;
	patch: number;
	prerelease: boolean;
}

/** Parse a strict `MAJOR.MINOR.PATCH[-prerelease][+build]` version. */
export function parseVersion(value: string): ParsedVersion | null {
	const match = /^v?(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/.exec(value.trim());
	if (!match) return null;
	return {
		major: Number(match[1]),
		minor: Number(match[2]),
		patch: Number(match[3]),
		prerelease: match[4] !== undefined,
	};
}

function compareVersions(
	a: readonly [number, number, number],
	b: readonly [number, number, number],
): number {
	for (let i = 0; i < 3; i += 1) {
		if (a[i] !== b[i]) return a[i] - b[i];
	}
	return 0;
}

/**
 * Check whether a version string is inside SUPPORTED_PLUGIN_RANGE.
 *
 * Prereleases are treated as out of range. The supported range has no
 * prerelease component on either bound, so a prerelease such as
 * `3.0.0-rc.1` must not be accepted by a stable host.
 */
export function isVersionSupported(version: string | null | undefined): boolean {
	if (!version) return false;
	const parsed = parseVersion(version);
	if (!parsed) return false;
	if (parsed.prerelease) return false;
	const tuple: readonly [number, number, number] = [parsed.major, parsed.minor, parsed.patch];
	return compareVersions(tuple, MIN_VERSION) >= 0 && compareVersions(tuple, MAX_VERSION) < 0;
}

/**
 * Locate `@opencode/plugin/package.json` by walking up from `root` through
 * `node_modules` directories. Walking the filesystem instead of calling
 * `require.resolve` keeps this working for fixture trees that only contain
 * a package.json (used by tests and `scripts/check.sh`).
 */
function findPluginPackageJson(root: string): string | null {
	let directory = path.resolve(root);
	for (let depth = 0; depth < 16; depth += 1) {
		const candidate = path.join(directory, "node_modules", "@opencode", "plugin", "package.json");
		if (existsSync(candidate)) return candidate;
		const parent = path.dirname(directory);
		if (parent === directory) break;
		directory = parent;
	}
	return null;
}

/**
 * Resolve the runtime `@opencode/plugin` version.
 *
 * @param root — directory to start resolution from. Defaults to this
 *   module's own directory (the plugin's install location at runtime).
 */
export function resolvePluginVersion(root: string = import.meta.dir): ResolvedPluginVersion {
	const packageJsonPath = findPluginPackageJson(root);
	if (!packageJsonPath) {
		return {
			version: null,
			compatible: false,
			error: "@opencode/plugin/package.json not found",
		};
	}

	try {
		const raw = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as Record<string, unknown>;
		const version = typeof raw.version === "string" ? raw.version : null;
		return { version, compatible: isVersionSupported(version) };
	} catch (error) {
		return {
			version: null,
			compatible: false,
			error: error instanceof Error ? error.name : "unreadable",
		};
	}
}

// Allow `bun src/version.ts --root <dir>` so scripts/check.sh can reuse the
// exact same resolver instead of reimplementing version matching in bash.
if (import.meta.main) {
	const rootFlag = process.argv.indexOf("--root");
	const root = rootFlag >= 0 ? process.argv[rootFlag + 1] : undefined;
	const resolved = resolvePluginVersion(root);
	console.log(resolved.version ?? "unknown");
	process.exit(resolved.compatible ? 0 : 1);
}
