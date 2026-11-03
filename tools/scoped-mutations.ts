import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createEditToolDefinition,
	createWriteToolDefinition,
	type EditOperations,
	type WriteOperations,
} from "@earendil-works/pi-coding-agent";
import {
	assertCanMkdir,
	assertCanWrite,
	parseWriteScopeEnv,
	WRITE_SCOPE_ENV,
	type WriteScope,
} from "../lib/write-scope";

function sameInode(a: fs.Stats, b: fs.Stats): boolean {
	return a.dev === b.dev && a.ino === b.ino;
}

function lstatIfPresent(file: string): fs.Stats | undefined {
	try {
		return fs.lstatSync(file);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

async function guardedWriteFile(scope: WriteScope, absolutePath: string, content: string): Promise<void> {
	const firstGuard = assertCanWrite(scope, absolutePath);
	const requestedStat = lstatIfPresent(absolutePath);
	if (requestedStat && (requestedStat.isSymbolicLink() || !requestedStat.isFile() || requestedStat.nlink !== 1)) {
		throw new Error(`Write target must be a regular, non-symlink file with one link: ${absolutePath}`);
	}

	if (!requestedStat) {
		// Exclusive creation never follows a link and never clobbers a file created in a race.
		const createdGuard = assertCanWrite(scope, absolutePath);
		if (createdGuard !== firstGuard) throw new Error("Write target changed during validation");
		const handle = await fs.promises.open(createdGuard, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o666);
		try {
			const opened = await handle.stat();
			if (!opened.isFile() || opened.nlink !== 1) throw new Error(`Write target must be a regular file with one link: ${absolutePath}`);
			const currentGuard = assertCanWrite(scope, absolutePath);
			const current = lstatIfPresent(currentGuard);
			if (currentGuard !== createdGuard || !current || !sameInode(opened, current)) throw new Error("Write target changed during creation");
			await handle.writeFile(content, "utf-8");
		} finally {
			await handle.close();
		}
		return;
	}

	const canonical = firstGuard;
	const beforeOpen = lstatIfPresent(canonical);
	if (!beforeOpen || beforeOpen.isSymbolicLink() || !beforeOpen.isFile() || beforeOpen.nlink !== 1 || !sameInode(requestedStat, beforeOpen)) {
		throw new Error(`Write target changed or is not a regular single-link file: ${absolutePath}`);
	}
	const handle = await fs.promises.open(canonical, fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW);
	try {
		const opened = await handle.stat();
		if (!opened.isFile() || opened.nlink !== 1 || !sameInode(beforeOpen, opened)) throw new Error(`Write target changed during open: ${absolutePath}`);
		const currentGuard = assertCanWrite(scope, absolutePath);
		const current = lstatIfPresent(canonical);
		if (currentGuard !== canonical || !current || current.isSymbolicLink() || !current.isFile() || current.nlink !== 1 || !sameInode(opened, current)) {
			throw new Error(`Write target changed during validation: ${absolutePath}`);
		}
		await handle.truncate(0);
		await handle.writeFile(content, "utf-8");
	} finally {
		await handle.close();
	}
}

/**
 * Create mutation tools that enforce host-resolved paths inside Pi's mutation queue.
 * This is not an OS sandbox and provides no cross-process lock or complete TOCTOU proof;
 * in particular, parent-directory swaps remain outside this protection boundary.
 */
export function createScopedMutationTools(cwd: string, scope: WriteScope): [ReturnType<typeof createEditToolDefinition>, ReturnType<typeof createWriteToolDefinition>] {
	const editOperations: EditOperations = {
		access: async absolutePath => {
			const guardedPath = assertCanWrite(scope, absolutePath);
			const stat = lstatIfPresent(absolutePath);
			if (!stat || stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
				throw new Error(`Edit target must be an existing regular, non-symlink file with one link: ${absolutePath}`);
			}
			await fs.promises.access(guardedPath, fs.constants.R_OK | fs.constants.W_OK);
		},
		readFile: async absolutePath => {
			const guardedPath = assertCanWrite(scope, absolutePath);
			const stat = lstatIfPresent(absolutePath);
			if (!stat || stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
				throw new Error(`Edit target must be an existing regular, non-symlink file with one link: ${absolutePath}`);
			}
			return fs.promises.readFile(guardedPath);
		},
		writeFile: (absolutePath, content) => guardedWriteFile(scope, absolutePath, content),
	};
	const writeOperations: WriteOperations = {
		mkdir: async absoluteDir => {
			const guardedDir = assertCanMkdir(scope, absoluteDir);
			await fs.promises.mkdir(guardedDir, { recursive: true });
		},
		writeFile: (absolutePath, content) => guardedWriteFile(scope, absolutePath, content),
	};

	const [edit, write] = [
		createEditToolDefinition(cwd, { operations: editOperations }),
		createWriteToolDefinition(cwd, { operations: writeOperations }),
	];
	edit.name = "scoped_edit";
	edit.label = "scoped_edit";
	edit.description = "Apply precise replacements to a file within the authorized write scope.";
	edit.promptSnippet = "Make precise file replacements within the authorized write scope";
	edit.promptGuidelines = [
		"Use scoped_edit for targeted changes. Batch changes to one file in a single call.",
		"Each edits[].oldText must exactly and uniquely match the original file. Keep matches short and non-overlapping; merge nearby changes without including large unchanged regions.",
	];
	write.name = "scoped_write";
	write.label = "scoped_write";
	write.description = "Create or replace a file within the authorized write scope.";
	write.promptSnippet = "Create or replace files within the authorized write scope";
	write.promptGuidelines = ["Use scoped_write only for new files or complete rewrites."];
	return [edit, write];
}

/** Fail closed: malformed or absent scope throws before either mutation tool is registered. */
export default function (pi: ExtensionAPI): void {
	const raw = process.env[WRITE_SCOPE_ENV];
	if (!raw) throw new Error(`Missing required ${WRITE_SCOPE_ENV}`);
	const scope = parseWriteScopeEnv(raw);
	const tools = createScopedMutationTools(process.cwd(), scope);
	for (const tool of tools) pi.registerTool(tool);
}
