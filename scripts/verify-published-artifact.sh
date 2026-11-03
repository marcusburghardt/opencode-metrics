#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# verify-published-artifact.sh — prove that a published tarball installs and
# registers as an OpenCode V2 plugin.
#
# The check is behavioural, not textual: it installs the published tarball
# into a throw-away project with `npm install --omit=dev`, imports the plugin
# API from that install tree, imports `dist/index.js`, and asserts its default
# export is a `Plugin.define` object with `id === "opencode-metrics"` and a
# callable `setup`. A grep of the bundle cannot satisfy this check.
#
# Usage:
#   ./scripts/verify-published-artifact.sh <version>
#   ./scripts/verify-published-artifact.sh 0.5.0
#
# Exit status:
#   0  artifact installs, resolves, and registers
#   1  verification failed
#   2  usage error
#
# Requires: npm, bun (the bundle imports `bun:sqlite`, so it must be loaded
# by the Bun runtime, not Node).

set -euo pipefail

PACKAGE_NAME="@mburghardt/opencode-metrics"

if [ "$#" -ne 1 ] || [ -z "${1:-}" ]; then
	echo "usage: $0 <version>" >&2
	exit 2
fi

VERSION="${1#v}"
if [ -z "${VERSION}" ]; then
	echo "error: version argument must not be empty" >&2
	exit 2
fi

for tool in npm bun; do
	if ! command -v "${tool}" >/dev/null 2>&1; then
		echo "error: ${tool} is required but not on PATH" >&2
		exit 1
	fi
done

WORK_DIR="$(mktemp -d)"
PROJECT_DIR="${WORK_DIR}/project"
SANDBOX_HOME="${WORK_DIR}/home"

cleanup() {
	rm -rf "${WORK_DIR}"
}
trap cleanup EXIT

mkdir -p "${PROJECT_DIR}" "${SANDBOX_HOME}/data"

# Read-only registry access may be anonymous; when a token is present in the
# environment, scope it to this throw-away directory instead of echoing it.
if [ -n "${NODE_AUTH_TOKEN:-}" ]; then
	printf '//registry.npmjs.org/:_authToken=%s\n' "${NODE_AUTH_TOKEN}" > "${WORK_DIR}/.npmrc"
	export NPM_CONFIG_USERCONFIG="${WORK_DIR}/.npmrc"
fi

echo "==> Packing ${PACKAGE_NAME}@${VERSION}"
TARBALL="$(cd "${WORK_DIR}" && npm pack "${PACKAGE_NAME}@${VERSION}" --silent)"
if [ -z "${TARBALL}" ] || [ ! -f "${WORK_DIR}/${TARBALL}" ]; then
	echo "FAIL [install] tarball for ${PACKAGE_NAME}@${VERSION} was not downloaded" >&2
	exit 1
fi

echo "==> Installing the published tarball in a clean project"
(
	cd "${PROJECT_DIR}"
	npm init -y >/dev/null 2>&1
	npm install --omit=dev --no-audit --no-fund "${WORK_DIR}/${TARBALL}" >/dev/null
)

cat > "${PROJECT_DIR}/verify-artifact.mjs" <<'EOF'
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const PACKAGE = "@mburghardt/opencode-metrics";

function fail(kind, message) {
	console.error(`FAIL [${kind}] ${message}`);
	process.exit(1);
}

function pass(message) {
	console.log(`PASS ${message}`);
}

const projectRoot = process.cwd();

// 1. Declared runtime dependency.
let entry;
try {
	entry = Bun.resolveSync(PACKAGE, projectRoot);
} catch (error) {
	fail("install", `${PACKAGE} does not resolve from the install tree: ${error.message}`);
}

const packageRoot = path.dirname(path.dirname(entry));
const manifestPath = path.join(packageRoot, "package.json");
if (!existsSync(manifestPath)) {
	fail("install", `published package.json not found at ${manifestPath}`);
}

let manifest;
try {
	manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
} catch (error) {
	fail("install", `published package.json is unreadable: ${error.message}`);
}

const dependencyVersion = manifest.dependencies?.["@opencode/plugin"];
if (typeof dependencyVersion !== "string" || dependencyVersion.length === 0) {
	fail("dependency", "@opencode/plugin is not declared in the published dependencies");
}
pass(`published package.json declares @opencode/plugin@${dependencyVersion}`);

// 2. Dependency resolves from the install tree and exposes Plugin.define.
// Resolve relative to the installed package so a nested (non-hoisted)
// dependency still resolves. `Bun.resolveSync` follows the package's ESM
// export conditions, which `require` cannot.
let apiPath;
try {
	apiPath = Bun.resolveSync("@opencode/plugin", packageRoot);
} catch (error) {
	fail("dependency", `@opencode/plugin does not resolve from the install tree: ${error.message}`);
}

let api;
try {
	api = await import(pathToFileURL(apiPath).href);
} catch (error) {
	fail("dependency", `import('@opencode/plugin') failed: ${error.message}`);
}

if (typeof api.Plugin?.define !== "function") {
	fail("dependency", "resolved @opencode/plugin does not export Plugin.define");
}
pass("@opencode/plugin resolves and exports Plugin.define");

// 3. dist/index.js registers through Plugin.define.
const distEntry = path.join(packageRoot, "dist", "index.js");
if (!existsSync(distEntry)) {
	fail("registration", `dist/index.js is missing from the published tarball`);
}

let module;
try {
	module = await import(pathToFileURL(distEntry).href);
} catch (error) {
	fail("registration", `importing dist/index.js failed: ${error.message}`);
}

const plugin = module.default;
if (typeof plugin !== "object" || plugin === null || Array.isArray(plugin)) {
	fail("registration", `default export is ${typeof plugin}, expected a Plugin.define object`);
}
if (plugin.id !== "opencode-metrics") {
	fail("registration", `default export id is ${JSON.stringify(plugin.id)}, expected "opencode-metrics"`);
}
if (typeof plugin.setup !== "function") {
	fail("registration", "default export has no callable setup");
}
pass(`dist/index.js default-exports { id: "opencode-metrics", setup: [function] }`);

// 4. setup runs against a stub context in a sandboxed data directory.
process.env.XDG_DATA_HOME = path.join(process.env.VERIFY_SANDBOX_HOME, "data");
process.env.HOME = process.env.VERIFY_SANDBOX_HOME;

const recordedErrors = [];
const originalError = console.error;
const originalWarn = console.warn;
console.error = (...args) => {
	recordedErrors.push(args.map(String).join(" "));
};
console.warn = () => {};

const noop = () => {};
const ctx = {
	event: {
		subscribe: () => (async function* emptyStream() {})(),
	},
	session: {
		get: async () => null,
		context: async () => [],
	},
	project: {
		current: async () => ({ id: "verify-sandbox", path: process.cwd() }),
	},
	location: {
		directory: process.cwd(),
		project: { id: "verify-sandbox" },
	},
	app: { log: noop },
};

let cleanup;
try {
	cleanup = await plugin.setup(ctx);
} catch (error) {
	console.error = originalError;
	console.warn = originalWarn;
	fail("setup", `setup threw instead of returning a cleanup: ${error.message}`);
}

console.error = originalError;
console.warn = originalWarn;

if (typeof cleanup !== "function") {
	fail("setup", `setup returned ${typeof cleanup}, expected a cleanup function`);
}

const databasePath = path.join(process.env.XDG_DATA_HOME, "opencode-metrics", "metrics.db");
if (!existsSync(databasePath)) {
	fail("setup", `setup did not create ${databasePath}; setup failed before registration`);
}
if (recordedErrors.some((line) => /initialization failed|unsupported @opencode\/plugin/i.test(line))) {
	fail("setup", `setup logged a failure: ${recordedErrors.join(" | ")}`);
}

cleanup();
pass("setup runs against a stub context and creates the metrics database");
EOF

echo "==> Verifying registration from the install tree"
(
	cd "${PROJECT_DIR}"
	VERIFY_SANDBOX_HOME="${SANDBOX_HOME}" bun ./verify-artifact.mjs
)

echo "Verified ${PACKAGE_NAME}@${VERSION}: installs, resolves @opencode/plugin, and registers."
