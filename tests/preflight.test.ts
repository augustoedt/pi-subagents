import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentConfig } from "../lib/types";
import { preflightAgent, validateRuntimeConfig } from "../lib/preflight";
import type { ExtensionConfig } from "../lib/config";

describe("preflightAgent", () => {
	let root: string;
	let cwd: string;
	let extension: string;
	const builtins = new Set(["read"]);
	let agent: AgentConfig;

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-preflight-"));
		cwd = path.join(root, "work");
		fs.mkdirSync(cwd);
		extension = path.join(root, "tool.ts");
		fs.writeFileSync(extension, "export {};\n");
		agent = {
			name: "worker", description: "worker", tools: ["read", "custom"], model: "provider/model",
			thinking: "", systemPrompt: "", filePath: "worker.md",
		};
	});

	afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

	it("returns canonical cwd, unique declared tools, and unique extension paths", () => {
		const alias = path.join(root, "tool-alias.ts");
		fs.symlinkSync(extension, alias);
		agent.tools = ["read", "custom", "custom2", "read"];
		expect(preflightAgent(cwd, agent, builtins, { custom: extension, custom2: alias })).toEqual({
			cwd: fs.realpathSync(cwd), tools: ["read", "custom", "custom2"], extensionPaths: [fs.realpathSync(extension)],
		});
	});

	it("allows an agent with no tools", () => {
		agent.tools = [];
		expect(preflightAgent(cwd, agent, builtins, {})).toEqual({ cwd: fs.realpathSync(cwd), tools: [], extensionPaths: [] });
	});

	it.each([
		["missing cwd", path.join("/definitely", "missing", "directory")],
		["non-directory cwd", process.execPath],
	])("rejects %s", (_label, invalidCwd) => {
		expect(() => preflightAgent(invalidCwd, agent, builtins, { custom: extension })).toThrow(/cwd.*readable directory/);
	});

	it("rejects unknown tools with the agent and tool named", () => {
		agent.tools = ["mystery"];
		expect(() => preflightAgent(cwd, agent, builtins, {})).toThrow(/worker.*mystery/);
	});

	it("rejects missing extension paths with agent, tool, and path named", () => {
		const missing = path.join(root, "missing.ts");
		expect(() => preflightAgent(cwd, agent, builtins, { custom: missing })).toThrow(/worker.*custom.*missing\.ts/);
	});

	it("rejects extension paths that are directories", () => {
		const directory = path.join(root, "extension-dir");
		fs.mkdirSync(directory);
		expect(() => preflightAgent(cwd, agent, builtins, { custom: directory })).toThrow(/worker.*custom.*extension-dir/);
	});

	it.each(["", "   ", "inherit", "$fast", "$tier"])("rejects unresolved model %j", model => {
		agent.model = model;
		expect(() => preflightAgent(cwd, agent, builtins, { custom: extension })).toThrow(/model.*concrete/);
	});
});

describe("validateRuntimeConfig", () => {
	it("accepts valid values and unknown future fields", () => {
		expect(() => validateRuntimeConfig({
			maxConcurrency: 1, maxSubagentDepth: 2, subagentTimeoutMs: 0, subagentIdleTimeoutMs: 10,
			modelTiers: { fast: "provider/model" }, envAllowlist: ["HOME"], safeCommands: ["git"],
			extraDangerousPatterns: ["danger"], envExtra: { MODE: "test" }, futureOption: false,
		} as ExtensionConfig & { futureOption: boolean })).not.toThrow();
	});

	it.each([
		["maxConcurrency", { maxConcurrency: 0 }],
		["maxConcurrency", { maxConcurrency: Number.MAX_SAFE_INTEGER + 1 }],
		["maxSubagentDepth", { maxSubagentDepth: -1 }],
		["subagentTimeoutMs", { subagentTimeoutMs: -1 }],
		["subagentTimeoutMs", { subagentTimeoutMs: 1.5 }],
		["subagentIdleTimeoutMs", { subagentIdleTimeoutMs: -1 }],
		["modelTiers", { modelTiers: { fast: " " } }],
		["modelTiers", { modelTiers: [] }],
		["envAllowlist", { envAllowlist: [1] }],
		["safeCommands", { safeCommands: "git" }],
		["extraDangerousPatterns", { extraDangerousPatterns: [null] }],
		["envExtra", { envExtra: { MODE: 2 } }],
	])("rejects invalid %s", (field, values) => {
		expect(() => validateRuntimeConfig(values as ExtensionConfig)).toThrow(new RegExp(field));
	});
});
