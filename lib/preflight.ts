import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentConfig } from "./types";
import type { ExtensionConfig } from "./config";

export function preflightAgent(
	cwd: string,
	agent: AgentConfig,
	builtinTools: ReadonlySet<string>,
	customToolExtensions: Record<string, string>,
): { cwd: string; tools: string[]; extensionPaths: string[] } {
	const agentName = agent.name || "<unnamed>";
	let canonicalCwd: string;
	try {
		canonicalCwd = fs.realpathSync(cwd);
		if (!fs.statSync(canonicalCwd).isDirectory()) throw new Error("not a directory");
		fs.accessSync(canonicalCwd, fs.constants.R_OK);
	} catch {
		throw new Error(`Agent "${agentName}": cwd "${cwd}" must be an existing readable directory`);
	}

	if (typeof agent.model !== "string" || !agent.model.trim() ||
		agent.model.trim().toLowerCase() === "inherit" || agent.model.trim().startsWith("$")) {
		throw new Error(`Agent "${agentName}": model "${String(agent.model)}" must be a nonempty, resolved concrete model (not inherit or an unresolved $tier)`);
	}

	const tools: string[] = [];
	const extensionPaths: string[] = [];
	const seenTools = new Set<string>();
	const seenPaths = new Set<string>();
	for (const tool of agent.tools) {
		if (seenTools.has(tool)) continue;
		seenTools.add(tool);
		if (builtinTools.has(tool)) {
			tools.push(tool);
			continue;
		}

		const extensionPath = customToolExtensions[tool];
		if (!extensionPath) {
			throw new Error(`Agent "${agentName}": unknown declared tool "${tool}" (no built-in tool or custom extension path is registered)`);
		}
		let canonicalPath: string;
		try {
			canonicalPath = fs.realpathSync(extensionPath);
			if (!fs.statSync(canonicalPath).isFile()) throw new Error("not a regular file");
			fs.accessSync(canonicalPath, fs.constants.R_OK);
		} catch {
			throw new Error(`Agent "${agentName}": tool "${tool}" extension path "${extensionPath}" must be an existing readable regular file`);
		}
		tools.push(tool);
		if (!seenPaths.has(canonicalPath)) {
			seenPaths.add(canonicalPath);
			extensionPaths.push(canonicalPath);
		}
	}
	return { cwd: canonicalCwd, tools, extensionPaths };
}

/** Validate supported runtime config fields without rejecting future fields. */
export function validateRuntimeConfig(config: ExtensionConfig): void {
	if (config.envExtra && Object.prototype.hasOwnProperty.call(config.envExtra, "PI_SUBAGENT_WRITE_SCOPE")) {
		throw new Error("Invalid config field envExtra.PI_SUBAGENT_WRITE_SCOPE: use the explicit write_scope task parameter, not environment overrides");
	}
	const positiveIntegers: (keyof ExtensionConfig)[] = ["maxConcurrency", "maxSubagentDepth"];
	for (const field of positiveIntegers) {
		const value = config[field];
		if (value !== undefined && (!Number.isSafeInteger(value) || (value as number) <= 0)) {
			throw new Error(`Invalid config field ${field}: expected a positive safe integer`);
		}
	}
	const nonnegativeIntegers: (keyof ExtensionConfig)[] = ["subagentTimeoutMs", "subagentIdleTimeoutMs", "queueTimeoutMs", "maxQueueDepth"];
	for (const field of nonnegativeIntegers) {
		const value = config[field];
		if (value !== undefined && (!Number.isSafeInteger(value) || (value as number) < 0)) {
			throw new Error(`Invalid config field ${field}: expected a nonnegative safe integer`);
		}
	}
	if (config.modelTiers !== undefined) {
		if (!isRecord(config.modelTiers) || Object.values(config.modelTiers).some(
			value => typeof value !== "string" || value.trim().length === 0,
		)) throw new Error("Invalid config field modelTiers: expected a record of nonempty strings");
	}
	for (const field of ["envAllowlist", "safeCommands", "extraDangerousPatterns"] as const) {
		const value = config[field];
		if (value !== undefined && (!Array.isArray(value) || value.some(item => typeof item !== "string"))) {
			throw new Error(`Invalid config field ${field}: expected an array of strings`);
		}
	}
	if (config.envExtra !== undefined && (!isRecord(config.envExtra) ||
		Object.values(config.envExtra).some(value => typeof value !== "string"))) {
		throw new Error("Invalid config field envExtra: expected a record of strings");
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
