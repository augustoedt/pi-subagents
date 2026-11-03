import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { assertCanMkdir, assertCanWrite, parseWriteScopeEnv, resolveWriteScope } from "../lib/write-scope";

describe("write scope filesystem policy", () => {
	let temp: string;
	let cwd: string;
	beforeEach(() => {
		temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-write-scope-")));
		cwd = path.join(temp, "work");
		fs.mkdirSync(cwd);
	});
	afterEach(() => fs.rmSync(temp, { recursive: true, force: true }));

	it("enforces path segment boundaries and blocks traversal", () => {
		const src = path.join(cwd, "src");
		const sibling = path.join(cwd, "src-other");
		fs.mkdirSync(src); fs.mkdirSync(sibling);
		const scope = resolveWriteScope([{ path: "src", kind: "directory" }], cwd);
		expect(assertCanWrite(scope, path.join(src, "ok.ts"))).toBe(path.join(src, "ok.ts"));
		expect(() => assertCanWrite(scope, path.join(sibling, "no.ts"))).toThrow(/outside/);
		expect(() => assertCanWrite(scope, path.join(src, "..", "escape.ts"))).toThrow(/outside/);
	});

	it("canonicalizes directory symlink declarations but pins serialized roots", () => {
		const real = path.join(cwd, "real"); const alias = path.join(cwd, "alias");
		fs.mkdirSync(real); fs.symlinkSync(real, alias);
		const scope = resolveWriteScope([{ path: alias, kind: "directory" }], cwd);
		expect(scope.roots[0].path).toBe(fs.realpathSync(real));
		const payload = JSON.stringify(scope);
		expect(parseWriteScopeEnv(payload)).toEqual(scope);
		fs.renameSync(alias, path.join(cwd, "old-alias")); fs.mkdirSync(path.join(cwd, "replacement"));
		fs.symlinkSync(path.join(cwd, "replacement"), alias);
		expect(assertCanWrite(scope, path.join(real, "file"))).toBe(path.join(real, "file"));
		fs.renameSync(real, path.join(cwd, "moved-real"));
		fs.symlinkSync(path.join(cwd, "replacement"), real);
		expect(() => assertCanWrite(scope, path.join(real, "file"))).toThrow(/changed/);
	});

	it("authorizes canonical pathnames, not original directory inode identities", () => {
		const dir = path.join(cwd, "allowed"), moved = path.join(cwd, "moved");
		fs.mkdirSync(dir);
		const scope = resolveWriteScope([{ path: dir, kind: "directory" }], cwd);
		fs.renameSync(dir, moved); fs.mkdirSync(dir);
		expect(parseWriteScopeEnv(JSON.stringify(scope))).toEqual(scope);
		expect(assertCanWrite(scope, path.join(dir, "new"))).toBe(path.join(dir, "new"));
		expect(() => assertCanWrite(scope, path.join(moved, "new"))).toThrow(/outside/);
	});

	it("rejects symlink escapes, dangling targets, and hardlinks", () => {
		const inside = path.join(cwd, "inside"); const outside = path.join(temp, "outside");
		fs.mkdirSync(inside); fs.mkdirSync(outside);
		fs.symlinkSync(outside, path.join(inside, "escape"));
		fs.symlinkSync(path.join(temp, "missing"), path.join(inside, "dangling"));
		const scope = resolveWriteScope([{ path: inside, kind: "directory" }], cwd);
		expect(() => assertCanWrite(scope, path.join(inside, "escape", "x"))).toThrow();
		expect(() => assertCanWrite(scope, path.join(inside, "dangling"))).toThrow();
		const file = path.join(inside, "linked"); fs.writeFileSync(file, "x"); fs.linkSync(file, path.join(inside, "alias"));
		expect(() => assertCanWrite(scope, file)).toThrow(/link/);
	});

	it("allows nested missing files in directory scopes and exact new files only", () => {
		const dir = path.join(cwd, "tree"); fs.mkdirSync(dir);
		const scope = resolveWriteScope([{ path: dir, kind: "directory" }], cwd);
		expect(assertCanWrite(scope, path.join(dir, "new", "deep", "file.ts"))).toBe(path.join(dir, "new", "deep", "file.ts"));
		expect(assertCanMkdir(scope, path.join(dir, "new"))).toBe(path.join(dir, "new"));
		const exact = path.join(dir, "newfile");
		const exactScope = resolveWriteScope([{ path: exact, kind: "file" }], cwd);
		expect(assertCanWrite(exactScope, exact)).toBe(exact);
		expect(() => assertCanWrite(exactScope, path.join(dir, "other"))).toThrow(/outside/);
		expect(assertCanMkdir(exactScope, dir)).toBe(fs.realpathSync(dir));
	});

	it("rejects .git paths case-insensitively, filesystem root, and missing roots", () => {
		const tree = path.join(cwd, "tree"); fs.mkdirSync(tree);
		for (const name of [".git", ".GIT", ".GiT"]) {
			const p = path.join(tree, name, "worktreefile");
			expect(() => resolveWriteScope([{ path: p, kind: "file" }], cwd)).toThrow(/\.git/);
		}
		expect(() => resolveWriteScope([{ path: path.parse(cwd).root, kind: "directory" }], cwd)).toThrow();
		expect(() => resolveWriteScope([{ path: path.join(tree, "missing", "file"), kind: "file" }], cwd)).toThrow(/parent/);
	});

	it("rejects glob declarations, hardlink roots, and directory/file kind mismatches", () => {
		const tree = path.join(cwd, "tree"); fs.mkdirSync(tree);
		const file = path.join(tree, "file"); fs.writeFileSync(file, "x");
		const hardlink = path.join(tree, "hardlink"); fs.linkSync(file, hardlink);
		expect(() => resolveWriteScope([{ path: hardlink, kind: "file" }], cwd)).toThrow(/link/);
		expect(() => resolveWriteScope([{ path: tree, kind: "file" }], cwd)).toThrow();
		expect(() => resolveWriteScope([{ path: file, kind: "directory" }], cwd)).toThrow();
		for (const glob of ["*", "?", "[x]", "{a,b}"]) {
			expect(() => resolveWriteScope([{ path: `tree/${glob}`, kind: "file" }], cwd)).toThrow(/glob/);
		}
	});

	it("rejects malformed payloads and declaration shapes", () => {
		for (const raw of ["{", "[]", "{}", JSON.stringify({ version: 2, roots: [] }), JSON.stringify({ version: 1, roots: {} }), JSON.stringify({ version: 1, roots: [{ path: "relative", kind: "file" }] }), JSON.stringify({ version: 1, roots: [{ path: cwd, kind: "glob" }] })]) {
			expect(() => parseWriteScopeEnv(raw)).toThrow();
		}
		expect(() => resolveWriteScope({}, cwd)).toThrow();
		expect(() => resolveWriteScope([null], cwd)).toThrow();
		expect(() => resolveWriteScope([{ path: " ", kind: "file" }], cwd)).toThrow();
		expect(() => resolveWriteScope([{ path: "@alias", kind: "file" }], cwd)).toThrow(/Unsupported/);
		expect(() => resolveWriteScope([{ path: "~/file", kind: "file" }], cwd)).toThrow(/Unsupported/);
		expect(() => resolveWriteScope([{ path: "file:///tmp/file", kind: "file" }], cwd)).toThrow(/Unsupported/);
		expect(() => resolveWriteScope(Array.from({ length: 21 }, () => ({ path: "file", kind: "file" })), cwd)).toThrow(/20/);
	});

	it("rejects parent replacement and dangling intermediate symlink targets", () => {
		const parent = path.join(cwd, "parent"); const outside = path.join(temp, "outside");
		fs.mkdirSync(parent); fs.mkdirSync(outside);
		const exact = path.join(parent, "newfile");
		const exactScope = resolveWriteScope([{ path: exact, kind: "file" }], cwd);
		fs.renameSync(parent, path.join(cwd, "original-parent")); fs.symlinkSync(outside, parent);
		expect(() => assertCanWrite(exactScope, exact)).toThrow(/outside/);

		const tree = path.join(cwd, "tree"); fs.mkdirSync(tree);
		fs.symlinkSync(path.join(temp, "missing"), path.join(tree, "dangling"));
		const directoryScope = resolveWriteScope([{ path: tree, kind: "directory" }], cwd);
		expect(() => assertCanWrite(directoryScope, path.join(tree, "dangling", "missing-tail"))).toThrow();
	});

	it("rejects .git symlink aliases", () => {
		const git = path.join(cwd, ".git"); fs.mkdirSync(git);
		const alias = path.join(cwd, "git-alias"); fs.symlinkSync(git, alias);
		expect(() => resolveWriteScope([{ path: alias, kind: "directory" }], cwd)).toThrow(/\.git/);
	});

	it("treats an empty scope as deny-all and rejects directories as file targets", () => {
		const scope = resolveWriteScope([], cwd);
		expect(() => assertCanWrite(scope, path.join(cwd, "anything"))).toThrow(/outside/);
		expect(() => assertCanMkdir(scope, cwd)).toThrow(/outside/);
		const allowed = resolveWriteScope([{ path: cwd, kind: "directory" }], cwd);
		expect(() => assertCanWrite(allowed, cwd)).toThrow(/directories/);
	});
});
