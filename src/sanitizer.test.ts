// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import {
	canonicalizePath,
	canonicalizeResource,
	canonicalizeSavePattern,
	canonicalizeShell,
	classifyPath,
	extractExtension,
	HASH_HEX_LENGTH,
	hashResource,
	isReusableSavePattern,
	redactSecrets,
} from "./sanitizer";

describe("canonicalizeShell", () => {
	it("keeps the command head and one subcommand", () => {
		expect(canonicalizeShell("git push origin feature/secret-name")).toBe("git push");
		expect(canonicalizeShell("gh pr view 123 --repo org/repo")).toBe("gh pr");
	});

	it("removes leading environment assignments", () => {
		expect(canonicalizeShell("FOO=bar make test")).toBe("make test");
		expect(canonicalizeShell("A=1 B=2 cargo build --release")).toBe("cargo build");
	});

	it("removes quoting", () => {
		expect(canonicalizeShell('echo "hello world"')).toBe("echo");
		expect(canonicalizeShell("git 'push' origin main")).toBe("git push");
	});

	it("removes URLs and credentials", () => {
		expect(canonicalizeShell("curl https://api.example.com/v1/thing")).toBe("curl");
		expect(
			canonicalizeShell(
				'curl -H "Authorization: Bearer abcdefghijklmnop" https://api.example.com',
			),
		).toBe("curl");
		expect(canonicalizeShell("git clone git@github.com:org/repo.git")).toBe("git clone");
	});

	it("removes paths, flags, and numeric arguments", () => {
		expect(canonicalizeShell("ls -la /tmp/secret")).toBe("ls");
		expect(canonicalizeShell("cat ../../../etc/passwd")).toBe("cat");
		expect(canonicalizeShell("./scripts/run.sh --verbose")).toBeNull();
	});

	it("returns null when no safe head remains", () => {
		expect(canonicalizeShell("$cmd argument")).toBeNull();
		expect(canonicalizeShell("   ")).toBeNull();
	});
});

describe("redactSecrets", () => {
	it("redacts authorization headers", () => {
		const result = redactSecrets("curl -H 'Authorization: Bearer abcdef123456'");

		expect(result).not.toContain("abcdef123456");
		expect(result).toContain("[redacted]");
	});

	it("redacts token and password assignments", () => {
		const result = redactSecrets("deploy --token=supersecretvalue password=hunter2");

		expect(result).not.toContain("supersecretvalue");
		expect(result).not.toContain("hunter2");
	});

	it("redacts common provider token formats", () => {
		const result = redactSecrets("ghp_abcdefghijklmnopqrstuvwxyz0123456789 AKIAABCDEFGHIJKLMNOP");

		expect(result).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
		expect(result).not.toContain("AKIAABCDEFGHIJKLMNOP");
	});

	it("redacts private key markers and material", () => {
		const result = redactSecrets(
			"-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----",
		);

		expect(result).not.toContain("MIIEowIBAAKCAQEA");
		expect(result).toContain("[redacted-private-key]");
	});

	it("redacts credentials in URLs", () => {
		const result = redactSecrets("https://user:hunter2@example.com/path");

		expect(result).not.toContain("hunter2");
		expect(result).toContain("[redacted]");
	});

	it("redacts long encoded values", () => {
		const encoded = "YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXoxMjM0NTY3ODkw";
		const result = redactSecrets(`value=${encoded}`);

		expect(result).not.toContain(encoded);
	});
});

describe("hashResource", () => {
	it("produces a stable truncated hex hash", () => {
		const first = hashResource("salt", "git push");
		const second = hashResource("salt", "git push");

		expect(first).toBe(second);
		expect(first).toHaveLength(HASH_HEX_LENGTH);
		expect(/^[0-9a-f]+$/.test(first)).toBe(true);
	});

	it("changes when the salt or resource changes", () => {
		expect(hashResource("salt-a", "git push")).not.toBe(hashResource("salt-b", "git push"));
		expect(hashResource("salt", "git push")).not.toBe(hashResource("salt", "git pull"));
	});
});

describe("classifyPath", () => {
	const project = "/home/tester/projects/app";

	it("classifies paths under the project", () => {
		expect(classifyPath("/home/tester/projects/app/src/a.ts", project)).toBe("project");
		expect(classifyPath("src/a.ts", project)).toBe("project");
	});

	it("classifies home, tmp, system, and external paths", () => {
		expect(classifyPath(path.join(homedir(), "notes.md"), project)).toBe("home");
		expect(classifyPath(path.join(tmpdir(), "scratch.txt"), project)).toBe("tmp");
		expect(classifyPath("/etc/passwd", project)).toBe("system");
		expect(classifyPath("/mnt/data/file.bin", project)).toBe("external");
	});

	it("treats relative paths without a project as project paths", () => {
		expect(classifyPath("docs/readme.md")).toBe("project");
	});
});

describe("canonicalizePath", () => {
	const project = "/home/tester/projects/app";

	it("keeps only the path class and extension", () => {
		expect(canonicalizePath("/home/tester/projects/app/src/a.ts", project)).toBe(
			"project:file.ts",
		);
		expect(canonicalizePath(path.join(homedir(), "notes"), project)).toBe("home:file");
	});

	it("omits the extension for directories", () => {
		expect(canonicalizePath(path.join(homedir(), "work"), project, true)).toBe("home:dir");
	});

	it("normalizes glob extensions", () => {
		expect(canonicalizePath("src/**/*.TS", project)).toBe("project:file.ts");
	});
});

describe("extractExtension", () => {
	it("returns only short, safe extensions", () => {
		expect(extractExtension("file.tar.gz")).toBe(".gz");
		expect(extractExtension("Makefile")).toBe("");
		expect(extractExtension("weird.abcdefghijklm")).toBe("");
	});
});

describe("canonicalizeResource", () => {
	const project = "/home/tester/projects/app";

	it("dispatches shell actions to shell canonicalization", () => {
		expect(canonicalizeResource("shell", "git status --short", project)).toBe("git status");
	});

	it("dispatches file actions to path classes", () => {
		expect(canonicalizeResource("read", "/home/tester/projects/app/a.ts", project)).toBe(
			"project:file.ts",
		);
	});

	it("dispatches directory actions to directory classes", () => {
		expect(
			canonicalizeResource("external_directory", path.join(homedir(), "secrets"), project),
		).toBe("home:dir");
	});

	it("does not store URLs", () => {
		expect(canonicalizeResource("webfetch", "https://example.com/a?token=x", project)).toBeNull();
	});

	it("returns null for unrecognized actions", () => {
		expect(canonicalizeResource("mcp_unknown", "some opaque value", project)).toBeNull();
	});
});

describe("saved patterns", () => {
	it("keeps broad but reusable wildcard patterns", () => {
		expect(canonicalizeSavePattern("git push *")).toBe("git push *");
		expect(isReusableSavePattern("git push *")).toBe(true);
	});

	it("flags placeholder patterns as non-reusable", () => {
		expect(canonicalizeSavePattern("$cmd *")).toBe("$cmd *");
		expect(isReusableSavePattern("$cmd *")).toBe(false);
		expect(isReusableSavePattern("*")).toBe(false);
	});

	it("classifies path patterns", () => {
		expect(canonicalizeSavePattern("read /etc/hosts")).toBe("read <system>");
		expect(isReusableSavePattern("read <system>")).toBe(true);
	});
});
