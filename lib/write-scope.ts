import * as fs from "node:fs";
import * as path from "node:path";

export interface WriteScopeEntry { path: string; kind: "file" | "directory" }
export interface WriteScope { version: 1; roots: WriteScopeEntry[] }
export const WRITE_SCOPE_ENV = "PI_SUBAGENT_WRITE_SCOPE";

const MAX_ENTRIES = 20;
const MAX_PATH_LENGTH = 2000;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasGitSegment(value: string): boolean {
	return value.split(/[\\/]+/).some(part => part.toLowerCase() === ".git");
}

function validateSyntax(value: unknown): string {
	if (typeof value !== "string" || !value.trim() || value.length > MAX_PATH_LENGTH) {
		throw new Error(`Write scope path must be a nonblank string of at most ${MAX_PATH_LENGTH} characters`);
	}
	if (value.startsWith("file://") || value.startsWith("@") || value.startsWith("~/")) {
		throw new Error(`Unsupported write scope path syntax: ${value}`);
	}
	if (hasGitSegment(value)) throw new Error("Write scope paths may not contain a .git segment");
	if (/[*?\[\]{}]/.test(value)) throw new Error("Write scope paths may not contain glob characters");
	return value;
}

function ensureNotFilesystemRoot(value: string): void {
	if (path.parse(value).root === value) throw new Error("Filesystem root cannot be a write scope root");
}

function regularSingleLink(file: string): void {
	const stat = fs.lstatSync(file);
	if (!stat.isFile() || stat.nlink !== 1) throw new Error(`Write scope file must be a regular file with one link: ${file}`);
}

function canonicalRoot(input: string, kind: "file" | "directory"): string {
	const normalized = path.resolve(input);
	ensureNotFilesystemRoot(normalized);
	if (hasGitSegment(normalized)) throw new Error("Write scope paths may not contain a .git segment");
	let canonical: string;
	let entryExists = false;
	try {
		fs.lstatSync(normalized);
		entryExists = true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`Invalid ${kind} write scope root: ${normalized}`);
	}
	try {
		canonical = fs.realpathSync(normalized);
	} catch (error) {
		if (entryExists || kind !== "file" || (error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`Invalid ${kind} write scope root: ${normalized}`);
		const parent = path.dirname(normalized);
		try {
			if (!fs.statSync(parent).isDirectory()) throw new Error("parent is not a directory");
			canonical = path.join(fs.realpathSync(parent), path.basename(normalized));
		} catch {
			throw new Error(`New file scope must have an existing directory parent: ${normalized}`);
		}
	}
	ensureNotFilesystemRoot(canonical);
	if (hasGitSegment(canonical)) throw new Error("Write scope paths may not contain a .git segment");
	if (kind === "directory") {
		try { if (!fs.statSync(normalized).isDirectory()) throw new Error("not a directory"); }
		catch { throw new Error(`Directory write scope root must exist: ${normalized}`); }
	} else {
		try { regularSingleLink(normalized); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	return canonical;
}

function canonicalEntries(entries: unknown, cwd: string): WriteScope {
	if (!Array.isArray(entries)) throw new Error("Write scope entries must be an array");
	if (entries.length > MAX_ENTRIES) throw new Error(`Write scope supports at most ${MAX_ENTRIES} entries`);
	let canonicalCwd: string;
	try {
		canonicalCwd = fs.realpathSync(cwd);
		if (!fs.statSync(canonicalCwd).isDirectory()) throw new Error("not a directory");
	} catch { throw new Error(`Write scope cwd must be an existing directory: ${cwd}`); }
	const roots: WriteScopeEntry[] = entries.map((value, index) => {
		if (!isRecord(value) || (value.kind !== "file" && value.kind !== "directory")) {
			throw new Error(`Invalid write scope entry at index ${index}: expected path and kind file|directory`);
		}
		const entryPath = validateSyntax(value.path);
		const resolved = path.isAbsolute(entryPath) ? entryPath : path.resolve(canonicalCwd, entryPath);
		return { path: canonicalRoot(resolved, value.kind), kind: value.kind };
	});
	return { version: 1, roots };
}

/** Resolve declarations against cwd. This policy is not an OS sandbox or race-proof. */
export function resolveWriteScope(entries: unknown, cwd: string): WriteScope {
	return canonicalEntries(entries, cwd);
}

/** Parse the serialized canonical version-1 scope payload. */
export function parseWriteScopeEnv(raw: string): WriteScope {
	let value: unknown;
	try { value = JSON.parse(raw); } catch { throw new Error("Invalid write scope JSON payload"); }
	if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.roots) ||
		Object.keys(value).some(key => key !== "version" && key !== "roots")) {
		throw new Error("Invalid write scope payload: expected exact version 1 and roots shape");
	}
	if (value.roots.length > MAX_ENTRIES) throw new Error(`Write scope supports at most ${MAX_ENTRIES} entries`);
	const roots = value.roots.map((item, index) => {
		if (!isRecord(item) || Object.keys(item).some(key => key !== "path" && key !== "kind") ||
			typeof item.path !== "string" || !path.isAbsolute(item.path) ||
			(item.kind !== "file" && item.kind !== "directory")) {
			throw new Error(`Invalid canonical write scope root at index ${index}`);
		}
		const p = validateSyntax(item.path);
		if (path.resolve(p) !== p) throw new Error(`Write scope root must be canonical: ${p}`);
		const canonical = canonicalRoot(p, item.kind);
		if (canonical !== p) throw new Error(`Write scope root must remain pinned and canonical: ${p}`);
		return { path: p, kind: item.kind } as WriteScopeEntry;
	});
	return { version: 1, roots };
}

/** Resolve a target through its deepest existing ancestor, retaining a missing tail. */
function canonicalTarget(target: string): { path: string; exists: boolean; stat?: fs.Stats } {
	if (typeof target !== "string" || !path.isAbsolute(target)) throw new Error("Write target must be an absolute path");
	const normalized = path.resolve(target);
	if (hasGitSegment(normalized)) throw new Error("Writes to .git paths are forbidden");
	let probe = normalized;
	const tail: string[] = [];
	while (true) {
		let lst: fs.Stats;
		try {
			lst = fs.lstatSync(probe);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			if (probe === path.dirname(probe)) throw new Error(`Cannot resolve write target: ${target}`);
			tail.unshift(path.basename(probe));
			probe = path.dirname(probe);
			continue;
		}
		// lstat succeeded, so an ENOENT from realpath indicates a dangling symlink.
		const real = fs.realpathSync(probe);
		const canonical = path.join(real, ...tail);
		if (hasGitSegment(canonical)) throw new Error("Writes to .git paths are forbidden");
		return { path: canonical, exists: tail.length === 0, stat: tail.length === 0 ? lst : undefined };
	}
}

function validateScope(scope: WriteScope): WriteScopeEntry[] {
	if (!isRecord(scope) || scope.version !== 1 || !Array.isArray(scope.roots) || scope.roots.length > MAX_ENTRIES) {
		throw new Error("Invalid write scope");
	}
	return scope.roots.map(root => {
		if (!isRecord(root) || typeof root.path !== "string" || !path.isAbsolute(root.path) ||
			(root.kind !== "file" && root.kind !== "directory")) throw new Error("Invalid write scope root");
		if (root.kind === "directory") {
			let now: string;
			try { now = fs.realpathSync(root.path); if (!fs.statSync(now).isDirectory()) throw new Error("not directory"); }
			catch { throw new Error(`Directory write scope root no longer exists: ${root.path}`); }
			if (now !== root.path) throw new Error(`Directory write scope root changed: ${root.path}`);
		}
		return root as WriteScopeEntry;
	});
}

function within(target: string, root: string): boolean {
	return target === root || target.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

function assertTarget(scope: WriteScope, absolutePath: string): string {
	const roots = validateScope(scope);
	const target = canonicalTarget(absolutePath);
	if (target.exists) {
		if (target.stat!.isDirectory()) throw new Error(`Writes to directories are forbidden: ${absolutePath}`);
		if (!target.stat!.isFile() || target.stat!.nlink !== 1) throw new Error(`Write target must be a regular file with one link: ${absolutePath}`);
	}
	if (roots.some(root => root.kind === "directory" && within(target.path, root.path))) return target.path;
	if (roots.some(root => root.kind === "file" && target.path === root.path)) return target.path;
	throw new Error(`Write target is outside write scope: ${absolutePath}`);
}

export function assertCanWrite(scope: WriteScope, absolutePath: string): string {
	return assertTarget(scope, absolutePath);
}

export function assertCanMkdir(scope: WriteScope, absoluteDir: string): string {
	const roots = validateScope(scope);
	const target = canonicalTarget(absoluteDir);
	if (target.exists && !target.stat!.isDirectory()) throw new Error(`mkdir target is not a directory: ${absoluteDir}`);
	if (roots.some(root => root.kind === "directory" && within(target.path, root.path))) return target.path;
	if (target.exists && roots.some(root => root.kind === "file" && within(root.path, target.path))) return target.path;
	throw new Error(`Directory creation is outside write scope: ${absoluteDir}`);
}
