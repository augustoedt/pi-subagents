import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import scopedMutations, { createScopedMutationTools } from "../tools/scoped-mutations";
import { resolveWriteScope, WRITE_SCOPE_ENV, type WriteScope } from "../lib/write-scope";

let root: string;
let cwd: string;
const tempDirs: string[] = [];

function fixture(): string {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "scoped-mutations-"));
	tempDirs.push(directory);
	return directory;
}

function scope(entries: Array<{ path: string; kind: "file" | "directory" }>): WriteScope {
	return resolveWriteScope(entries, cwd);
}

async function execute(tool: any, input: unknown): Promise<any> {
	return tool.execute("test-call", input, undefined, undefined, { cwd });
}

beforeEach(() => {
	root = fixture();
	cwd = root;
});

afterEach(() => {
	for (const directory of tempDirs.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("scoped mutation tools", () => {
	it("edits and writes allowed files, including a nested new file", async () => {
		const existing = path.join(root, "existing.txt");
		fs.writeFileSync(existing, "before\r\n");
		const tools = createScopedMutationTools(cwd, scope([{ path: root, kind: "directory" }]));
		await execute(tools[0], { path: existing, edits: [{ oldText: "before", newText: "after" }] });
		expect(fs.readFileSync(existing, "utf8")).toBe("after\r\n");
		const nested = path.join(root, "new", "sub", "file.txt");
		await execute(tools[1], { path: nested, content: "created" });
		expect(fs.readFileSync(nested, "utf8")).toBe("created");
	});

	it("denies outside writes without changing the sentinel and constrains exact-file roots", async () => {
		const allowed = path.join(root, "allowed.txt");
		const outside = path.join(fixture(), "outside-sentinel.txt");
		fs.writeFileSync(allowed, "allowed");
		fs.writeFileSync(outside, "sentinel");
		const tools = createScopedMutationTools(cwd, scope([{ path: allowed, kind: "file" }]));
		await expect(execute(tools[1], { path: outside, content: "changed" })).rejects.toThrow();
		await expect(execute(tools[1], { path: path.join(root, "sibling.txt"), content: "changed" })).rejects.toThrow();
		expect(fs.readFileSync(outside, "utf8")).toBe("sentinel");
		expect(fs.existsSync(path.join(root, "sibling.txt"))).toBe(false);
	});

	it("denies .git paths, symlink escapes, and hardlinks without mutation", async () => {
		const gitDir = path.join(root, ".git");
		fs.mkdirSync(gitDir);
		const gitFile = path.join(gitDir, "config");
		fs.writeFileSync(gitFile, "git-sentinel");
		const external = path.join(root, "external.txt");
		fs.writeFileSync(external, "external-sentinel");
		const link = path.join(root, "escape.txt");
		fs.symlinkSync(external, link);
		const original = path.join(root, "linked.txt");
		const hardlink = path.join(root, "hardlink.txt");
		fs.writeFileSync(original, "hardlink-sentinel");
		fs.linkSync(original, hardlink);
		const tools = createScopedMutationTools(cwd, scope([{ path: root, kind: "directory" }]));
		await expect(execute(tools[1], { path: gitFile, content: "changed" })).rejects.toThrow();
		await expect(execute(tools[1], { path: link, content: "changed" })).rejects.toThrow();
		await expect(execute(tools[1], { path: hardlink, content: "changed" })).rejects.toThrow();
		expect(fs.readFileSync(gitFile, "utf8")).toBe("git-sentinel");
		expect(fs.readFileSync(external, "utf8")).toBe("external-sentinel");
		expect(fs.readFileSync(original, "utf8")).toBe("hardlink-sentinel");
	});

	it("empty scope blocks all mutations", async () => {
		const target = path.join(root, "empty.txt");
		const tools = createScopedMutationTools(cwd, scope([]));
		await expect(execute(tools[1], { path: target, content: "no" })).rejects.toThrow();
		expect(fs.existsSync(target)).toBe(false);
	});

	it("fails closed when the environment is missing or invalid and registers unique scoped names only", () => {
		const previous = process.env[WRITE_SCOPE_ENV];
		const registered: string[] = [];
		const pi = { registerTool: (tool: { name: string }) => registered.push(tool.name) } as unknown as ExtensionAPI;
		try {
			delete process.env[WRITE_SCOPE_ENV];
			expect(() => scopedMutations(pi)).toThrow();
			expect(registered).toEqual([]);
			process.env[WRITE_SCOPE_ENV] = "not-json";
			expect(() => scopedMutations(pi)).toThrow();
			expect(registered).toEqual([]);
			process.env[WRITE_SCOPE_ENV] = JSON.stringify({ version: 1, roots: [] });
			scopedMutations(pi);
			expect(registered).toEqual(["scoped_edit", "scoped_write"]);
			expect(registered).not.toContain("edit");
			expect(registered).not.toContain("write");
		} finally {
			if (previous === undefined) delete process.env[WRITE_SCOPE_ENV];
			else process.env[WRITE_SCOPE_ENV] = previous;
		}
	});
});
