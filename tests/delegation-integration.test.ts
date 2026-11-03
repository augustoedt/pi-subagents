import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import extension, { registerAgent } from "../index";
import { REPORT_TOOL } from "../lib/delivery";
import { WRITE_SCOPE_ENV, resolveWriteScope } from "../lib/write-scope";

vi.mock("node:child_process", async importOriginal => ({ ...await importOriginal<typeof import("node:child_process")>(), spawn: vi.fn() }));
const spawned = vi.mocked(spawn);
const say = (text: string, errorMessage?: string) => ({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], ...(errorMessage ? { errorMessage } : {}) } });
const call = (id: string, tool: string, args: object, result: object = {}, isError = false) => [
	{ type: "tool_execution_start", toolCallId: id, toolName: tool, args },
	{ type: "tool_execution_end", toolCallId: id, toolName: tool, result, isError },
];
const reportEvents = () => call("report", REPORT_TOOL, {}, { details: { declaration: { status: "complete", summary: "Done", claimed_files: [], checks_not_run: ["device"], assumptions: [], blockers: [] } } });
let scripts: Array<{ events: any[]; code?: number; after?: () => void }>;
let tools: Map<string, any>;
let root: string;
let ctx: any;
let tasks: string[];
let prompts: string[];
let promptPaths: string[];
let originalHome: string | undefined;
let launches: Array<{ args: string[]; scope?: string }>;

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-delegation-integration-"));
	originalHome = process.env.HOME; process.env.HOME = root;
	fs.writeFileSync(path.join(root, "reference.md"), "not auto injected");
	tools = new Map(); scripts = []; tasks = []; prompts = []; promptPaths = []; launches = [];
	extension({ registerCommand: vi.fn(), registerTool: (tool: any) => tools.set(tool.name, tool) } as any);
	for (const name of ["test-worker", "test-judge"]) registerAgent({ name, description: "test", tools: ["read", "edit", "write", "bash"], model: "test/model", thinking: "low", systemPrompt: "test instructions", filePath: "test.md" });
	ctx = { cwd: root, model: { provider: "test", id: "model" }, modelRegistry: { find: () => ({ contextWindow: 100000 }) } };
	spawned.mockReset();
	spawned.mockImplementation((_cmd, args: any, options: any) => {
		launches.push({ args, scope: options?.env?.[WRITE_SCOPE_ENV] });
		const file = args[args.indexOf("--append-system-prompt") + 1];
		promptPaths.push(file); prompts.push(fs.readFileSync(file, "utf8"));
		const last = args.at(-1); tasks.push(last.startsWith("@") ? fs.readFileSync(last.slice(1), "utf8") : last);
		expect(args[args.indexOf("--tools") + 1]).toContain(REPORT_TOOL);
		const script = scripts.shift(); if (!script) throw new Error("Unexpected extra spawn");
		const proc: any = new EventEmitter(); proc.stdout = new PassThrough(); proc.stderr = new PassThrough();
		let closed = false;
		const close = (code: number | null) => { if (!closed) { closed = true; proc.emit("close", code); } };
		proc.kill = vi.fn(() => { queueMicrotask(() => close(null)); return true; });
		queueMicrotask(() => {
			for (const event of script.events) proc.stdout.write(JSON.stringify(event) + "\n");
			script.after?.(); close(script.code ?? 0);
		});
		return proc;
	});
});
afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
	if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
});
const execute = (name: string, args: object, signal?: AbortSignal) => tools.get(name).execute("parent", args, signal, undefined, ctx);

describe("actual registered orchestration tools with child event streams", () => {
	it("preserves legacy calls and distinguishes prose from a structured report", async () => {
		scripts.push({ events: [say("All tests passed")] });
		const result = await execute("subagent", { agent: "test-worker", task: "do work" });
		expect(result.details.results[0].output).toBe("All tests passed");
		expect(result.details.results[0].delivery.declaration).toBeUndefined();
		expect(result.content[0].text).toContain("NOT VERIFIED");
		expect(tasks[0]).toBe("Task: do work"); expect(prompts[0]).toContain(REPORT_TOOL);
		expect(fs.existsSync(promptPaths[0])).toBe(false);
		expect(launches[0].args).not.toContain("--exclude-tools"); expect(launches[0].scope).toBeUndefined();
	});
	it("delivers bounded context and records real tool outcomes, not prose success", async () => {
		scripts.push({ events: [...call("w", "write", { path: "test.ts" }), ...call("b", "bash", { command: "npm test" }, { content: [{ type: "text", text: "failed: test A" }] }, true), ...reportEvents(), say("Implemented")] });
		const r = await execute("subagent", { agent: "test-worker", task: "implement", context_files: ["reference.md"], acceptance: ["test passes"], constraints: ["no commit"] });
		expect(tasks[0]).toContain("no commit"); expect(tasks[0]).toContain(fs.realpathSync(path.join(root, "reference.md")));
		expect(tasks[0]).not.toContain("not auto injected");
		const d = r.details.results[0].delivery;
		expect(d.declaration.status).toBe("complete"); expect(d.observed.fileWrites).toEqual(["test.ts"]);
		expect(d.observed.commands[0].outcome).toBe("failed"); expect(d.acceptance).toBe("not_verified");
	});
	it("rejects missing cwd and reference files before spawning", async () => {
		await expect(execute("subagent", { agent: "test-worker", task: "x", cwd: path.join(root, "missing") })).rejects.toThrow("cwd");
		await expect(execute("subagent", { agent: "test-worker", task: "x", context_files: ["missing.md"] })).rejects.toThrow("context_files");
		expect(spawned).not.toHaveBeenCalled();
	});
	it("preflights every pipeline agent before any mutation can start", async () => {
		registerAgent({ name: "missing-tool", description: "x", tools: ["absent_tool"], model: "test/model", thinking: "low", systemPrompt: "", filePath: "" });
		await expect(execute("pipeline", { steps: [{ agent: "test-worker", task: "mutate" }, { agent: "missing-tool", task: "verify" }] })).rejects.toThrow("absent_tool");
		expect(spawned).not.toHaveBeenCalled();
	});
	it("preserves reports per pipeline step and passes evidence to the next agent", async () => {
		scripts.push({ events: [...reportEvents(), say("first result")] }, { events: [...reportEvents(), say("second result")] });
		const r = await execute("pipeline", { steps: [{ agent: "test-worker", task: "first", acceptance: ["one"] }, { agent: "test-worker", task: "Use {previous}", constraints: ["two"] }] });
		expect(r.details.pipelineResult.steps.map((s: any) => s.delivery.declaration.status)).toEqual(["complete", "complete"]);
		expect(tasks[1]).toContain("first result"); expect(tasks[1]).toContain("NOT VERIFIED"); expect(tasks[1]).toContain("two");
	});
	it("retains preceding pipeline evidence if a later reference is missing", async () => {
		scripts.push({ events: [...reportEvents(), say("first")] });
		const r = await execute("pipeline", { steps: [{ agent: "test-worker", task: "first" }, { agent: "test-worker", task: "second", context_files: ["missing.md"] }] });
		expect(r.isError).toBe(true); expect(r.details.pipelineResult.steps).toHaveLength(2);
		expect(r.details.pipelineResult.steps[0].delivery.declaration.status).toBe("complete");
		expect(r.content[0].text).toContain("context_files"); expect(spawned).toHaveBeenCalledTimes(1);
	});
	it("passes context to loop iterations and judge without changing YES parsing", async () => {
		scripts.push({ events: [...reportEvents(), say("implementation")] }, { events: [...reportEvents(), say("YES\nReviewed")] });
		const r = await execute("loop", { agent: "test-worker", task: "implement", constraints: ["no commit"], judge: { agent: "test-judge", criteria: "correctness" } });
		expect(r.details.loopResult.stoppedBecause).toBe("judge_satisfied");
		expect(r.details.loopResult.iterations[0].judgeDelivery.declaration.status).toBe("complete");
		expect(tasks.every(t => t.includes("no commit"))).toBe(true);
		expect(r.content[0].text).toContain("NOT VERIFIED");
	});
	it("does not accept a failed judge's YES", async () => {
		scripts.push({ events: [say("implementation")] }, { events: [say("YES")], code: 1 });
		const r = await execute("loop", { agent: "test-worker", task: "implement", judge: { agent: "test-judge", criteria: "correctness" } });
		expect(r.isError).toBe(true); expect(r.details.loopResult.stoppedBecause).toBe("error");
	});
	it("keeps evidence on retry and rebuilds the removed prompt and retry task", async () => {
		scripts.push({ events: [...call("w", "write", { path: "before.ts" }), say("partial", "Subagent stuck in a tool-call loop: read")], code: 1 }, { events: [...reportEvents(), say("done")] });
		const r = await execute("subagent", { agent: "test-worker", task: "x" });
		expect(spawned).toHaveBeenCalledTimes(2); expect(promptPaths[0]).not.toBe(promptPaths[1]);
		expect(tasks[1]).toContain("partial"); expect(r.details.results[0].delivery.observed.fileWrites).toEqual(["before.ts"]);
		expect(r.details.results[0].delivery.declaration.status).toBe("complete");
	});
	it("reuses the same restricted policy and guard extension after retry", async () => {
		scripts.push({ events: [say("partial", "Subagent stuck in a tool-call loop: read")], code: 1 }, { events: [say("done")] });
		await execute("subagent", { agent: "test-worker", task: "x", write_scope: [{ path: "reference.md", kind: "file" }] });
		expect(launches).toHaveLength(2); expect(launches[1].scope).toBe(launches[0].scope);
		for (const launch of launches) {
			expect(launch.args).toContain("--no-mcp");
			expect(launch.args.some(a => a.endsWith("/scoped-mutations.ts"))).toBe(true);
			expect(launch.args[launch.args.indexOf("--tools") + 1]).not.toMatch(/(?:^|,)write(?:,|$)/);
		}
	});
	it("does not treat a cancellation with exit zero as completion", async () => {
		const controller = new AbortController();
		scripts.push({ events: [say("partial")], after: () => controller.abort() });
		const r = await execute("subagent", { agent: "test-worker", task: "x" }, controller.signal);
		expect(r.isError).toBe(true); expect(r.details.results[0].delivery.process).toBe("cancelled");
	});
	it("cancellation between loop iterations remains an error", async () => {
		const controller = new AbortController();
		controller.abort();
		const r = await execute("loop", { agent: "test-worker", task: "x" }, controller.signal);
		expect(r.isError).toBe(true); expect(spawned).not.toHaveBeenCalled();
	});
	it("launches scoped workers without original mutators, shell or subdelegation", async () => {
		registerAgent({ name: "full-worker", description: "", tools: ["read", "edit", "write", "bash", "safe_bash", "subagent", "unknown_custom"], model: "test/model", thinking: "low", systemPrompt: "Use bash", filePath: "" });
		scripts.push({ events: [...call("e", "scoped_edit", { path: "reference.md", edits: [{ oldText: "a", newText: "b" }] }), ...reportEvents(), say("done")] });
		const r = await execute("subagent", { agent: "full-worker", task: "edit", write_scope: [{ path: "reference.md", kind: "file" }] });
		const args = launches[0].args;
		expect(args[args.indexOf("--tools") + 1].split(",")).toEqual(["read", "scoped_edit", "scoped_write", REPORT_TOOL]);
		expect(args[args.indexOf("--exclude-tools") + 1]).toContain("mcp__*"); expect(args).toContain("--no-mcp");
		expect(args.some(a => a.endsWith("/scoped-mutations.ts"))).toBe(true);
		expect(args.some(a => a.endsWith("/safe-bash.ts"))).toBe(false);
		expect(JSON.parse(launches[0].scope!).roots[0].path).toBe(fs.realpathSync(path.join(root, "reference.md")));
		expect(prompts[0]).toContain("coordinator must run builds/tests");
		const d = r.details.results[0].delivery;
		expect(d.restriction.disabledTools).toContain("unknown_custom"); expect(d.observed.fileWrites).toEqual(["reference.md"]);
		expect(r.details.results[0].progress.recentTools[0].editSucceeded).toBe(true);
		expect(r.content[0].text).toContain("Restricted write scope");
	});
	it("an empty scope removes even protected mutators", async () => {
		scripts.push({ events: [say("read only")] });
		await execute("subagent", { agent: "test-worker", task: "x", write_scope: [] });
		const a = launches[0].args;
		expect(a[a.indexOf("--tools") + 1]).toBe(`read,${REPORT_TOOL}`);
		expect(JSON.parse(launches[0].scope!).roots).toEqual([]);
	});
	it("rejects invalid later pipeline scopes before any spawn", async () => {
		await expect(execute("pipeline", { steps: [{ agent: "test-worker", task: "x" }, { agent: "test-worker", task: "y", write_scope: [{ path: "missing", kind: "directory" }] }] })).rejects.toThrow();
		expect(spawned).not.toHaveBeenCalled();
	});
	it("keeps per-step scopes separate and never grants writes to a readonly judge", async () => {
		registerAgent({ name: "readonly-judge", description: "", tools: ["read"], model: "test/model", thinking: "low", systemPrompt: "", filePath: "" });
		scripts.push({ events: [say("one")] }, { events: [say("two")] });
		await execute("pipeline", { steps: [{ agent: "test-worker", task: "x", write_scope: [] }, { agent: "test-worker", task: "y", write_scope: [{ path: "reference.md", kind: "file" }] }] });
		expect(JSON.parse(launches[0].scope!).roots).toEqual([]); expect(JSON.parse(launches[1].scope!).roots).toHaveLength(1);
		scripts.push({ events: [say("implementation")] }, { events: [say("YES")] });
		await execute("loop", { agent: "test-worker", task: "x", write_scope: [{ path: "reference.md", kind: "file" }], judge: { agent: "readonly-judge", criteria: "correct" } });
		const a = launches[3].args;
		expect(a[a.indexOf("--tools") + 1]).toBe(`read,${REPORT_TOOL}`);
		expect(launches[2].scope).toBe(launches[3].scope);
	});
	it("pins a later step's canonical root against symlink substitution by an earlier step", async () => {
		const allowed = path.join(root, "allowed"), other = path.join(root, "other");
		fs.mkdirSync(allowed); fs.mkdirSync(other);
		scripts.push({ events: [say("first")], after: () => { fs.renameSync(allowed, path.join(root, "moved")); fs.symlinkSync(other, allowed); } });
		const r = await execute("pipeline", { steps: [{ agent: "test-worker", task: "first" }, { agent: "test-worker", task: "second", write_scope: [{ path: allowed, kind: "directory" }] }] });
		expect(r.isError).toBe(true); expect(spawned).toHaveBeenCalledTimes(1);
		expect(r.details.pipelineResult.steps).toHaveLength(2);
	});
	it("inherits ambient scope even when a nested request omits the field", async () => {
		const previous = process.env[WRITE_SCOPE_ENV];
		try {
			process.env[WRITE_SCOPE_ENV] = JSON.stringify(resolveWriteScope([], root));
			scripts.push({ events: [say("done")] });
			await execute("subagent", { agent: "test-worker", task: "x" });
			expect(JSON.parse(launches[0].scope!).roots).toEqual([]);
			await expect(execute("subagent", { agent: "test-worker", task: "x", write_scope: [{ path: root, kind: "directory" }] })).rejects.toThrow(/widen/);
			expect(spawned).toHaveBeenCalledTimes(1);
		} finally { if (previous === undefined) delete process.env[WRITE_SCOPE_ENV]; else process.env[WRITE_SCOPE_ENV] = previous; }
	});
	it("rejects null scope before Pi optional-field coercion could erase it", () => {
		for (const name of ["subagent", "loop"]) expect(() => tools.get(name).prepareArguments({ write_scope: null })).toThrow(/write_scope/);
		expect(() => tools.get("pipeline").prepareArguments({ steps: [{ write_scope: null }] })).toThrow(/write_scope/);
		expect(tools.get("subagent").prepareArguments({ write_scope: [] })).toEqual({ write_scope: [] });
	});
	it("schemas expose optional context and an explicitly restricted write_scope", () => {
		for (const schema of [tools.get("subagent").parameters, tools.get("loop").parameters, tools.get("pipeline").parameters.properties.steps.items]) {
			expect(schema.properties.context_files).toBeDefined(); expect(schema.properties.constraints.description).toContain("NOT an enforced sandbox");
			expect(schema.required).not.toContain("acceptance"); expect(schema.required).not.toContain("write_scope");
			expect(schema.properties.write_scope.description).toContain("Disables shell");
		}
	});
});
