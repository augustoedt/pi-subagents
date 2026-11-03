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
const say = (text: string, errorMessage?: string) => ({ type: "message_end", message: { role: "assistant", provider: "test", model: "model", content: [{ type: "text", text }], ...(errorMessage ? { errorMessage } : {}) } });
const call = (id: string, tool: string, args: object, result: object = {}, isError = false) => [
	{ type: "tool_execution_start", toolCallId: id, toolName: tool, args },
	{ type: "tool_execution_end", toolCallId: id, toolName: tool, result, isError },
];
const reportEvents = () => call("report", REPORT_TOOL, {}, { details: { declaration: { status: "complete", summary: "Done", claimed_files: [], checks_not_run: ["device"], assumptions: [], blockers: [] } } });
let scripts: Array<{ events: any[]; code?: number; after?: () => void; hold?: boolean }>;
let releases: Array<() => void>;
let hooks: Map<string, Function>;
let histories: string[];
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
	releases = []; histories = []; hooks = new Map();
	extension({ on: (name: string, fn: Function) => hooks.set(name, fn), registerCommand: vi.fn(), registerTool: (tool: any) => tools.set(tool.name, tool) } as any);
	for (const name of ["test-worker", "test-judge"]) registerAgent({ name, description: "test", tools: ["read", "edit", "write", "bash"], model: "test/model", thinking: "low", systemPrompt: "test instructions", filePath: "test.md" });
	ctx = { sessionManager: { getSessionId: () => "parent-fixture" }, cwd: root, model: { provider: "test", id: "model" }, modelRegistry: { find: () => ({ contextWindow: 100000 }) } };
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
		const sessionFile = args.includes("--session") ? args[args.indexOf("--session") + 1] : undefined;
		if (sessionFile) histories.push(fs.readFileSync(sessionFile, "utf8"));
		const finish = () => {
			if (sessionFile) {
				const append = (message: object) => {
					const rows = fs.readFileSync(sessionFile, "utf8").trim().split("\n").map(line => JSON.parse(line));
					fs.appendFileSync(sessionFile, JSON.stringify({ type: "message", id: `entry-${rows.length}`, parentId: rows.length === 1 ? null : rows.at(-1).id, timestamp: new Date().toISOString(), message }) + "\n");
				};
				append({ role: "user", content: tasks.at(-1) });
				for (const event of script.events) if (event.type === "message_end") append(event.message);
			}
			for (const event of script.events) proc.stdout.write(JSON.stringify(event) + "\n");
			script.after?.(); close(script.code ?? 0);
		};
		if (script.hold) releases.push(finish); else queueMicrotask(finish);
		return proc;
	});
});
afterEach(async () => {
	await hooks.get("session_shutdown")?.({}, ctx);
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
	it("coordinates overlapping scopes while unrelated work starts immediately", async () => {
		scripts.push({ events: [say("one")], hold: true }, { events: [say("independent")], hold: true }, { events: [say("conflicting")] });
		const first = execute("subagent", { agent: "test-worker", task: "one", write_scope: [{ path: "reference.md", kind: "file" }] });
		await vi.waitFor(() => expect(launches).toHaveLength(1));
		const conflict = execute("subagent", { agent: "test-worker", task: "two", write_scope: [{ path: "reference.md", kind: "file" }] });
		const independent = execute("subagent", { agent: "test-worker", task: "three", write_scope: [{ path: "other.md", kind: "file" }] });
		await vi.waitFor(() => expect(launches).toHaveLength(2));
		expect(tasks[1]).toBe("Task: three");
		releases[0](); await first;
		const done = await conflict;
		expect(done.details.results[0].delivery.coordination.waitReason).toBe("resource_conflict");
		releases[1](); await independent;
	});
	it("cancels queued work without spawning and retains the active claim", async () => {
		scripts.push({ events: [say("active")], hold: true });
		const active = execute("subagent", { agent: "test-worker", task: "active", resources: ["build-cache"] });
		await vi.waitFor(() => expect(launches).toHaveLength(1));
		const controller = new AbortController();
		const waiting = execute("subagent", { agent: "test-worker", task: "waiting", resources: ["build-cache"] }, controller.signal);
		controller.abort();
		const result = await waiting;
		expect(result.isError).toBe(true); expect(result.details.results[0].delivery.process).toBe("cancelled");
		expect(launches).toHaveLength(1); releases[0](); await active;
	});
	it("creates and resumes the exact private transcript with pinned model and no retry", async () => {
		scripts.push({ events: [say("remember alpha")] }, { events: [say("alpha")] });
		const first = await execute("subagent", { agent: "test-worker", task: "remember alpha", write_scope: [], continuity: { mode: "create" } });
		const info = first.details.results[0].worker_session;
		expect(info).toMatchObject({ turn: 1, resumable: true });
		const next = await execute("subagent", { agent: "test-worker", task: "recall", continuity: { mode: "resume", worker_id: info.id } });
		expect(next.details.results[0].worker_session).toMatchObject({ id: info.id, turn: 2, previousTurns: [{ turn: 1, status: "completed" }] });
		expect(histories[1]).toContain("remember alpha");
		for (const launch of launches) { expect(launch.args).not.toContain("--no-session"); expect(launch.args).toContain("--model"); expect(JSON.parse(launch.scope!).roots).toEqual([]); }
		expect(launches[0].args[launches[0].args.indexOf("--session") + 1]).toBe(launches[1].args[launches[1].args.indexOf("--session") + 1]);
		scripts.push({ events: [say("partial", "Subagent stuck in a tool-call loop: read")], code: 1 });
		const failed = await execute("subagent", { agent: "test-worker", task: "resume", continuity: { mode: "resume", worker_id: info.id } });
		expect(failed.isError).toBe(true); expect(launches).toHaveLength(3);
		expect(failed.details.results[0].worker_session.status).toBe("failed");
	});
	it("inherits the recorded cwd on resume instead of silently switching to parent cwd", async () => {
		const nested = path.join(root, "nested"); fs.mkdirSync(nested);
		scripts.push({ events: [say("one")] }, { events: [say("two")] });
		const first = await execute("subagent", { agent: "test-worker", task: "one", cwd: nested, write_scope: [], continuity: { mode: "create" } });
		const continuity = { mode: "resume", worker_id: first.details.results[0].worker_session.id };
		const second = await execute("subagent", { agent: "test-worker", task: "two", continuity });
		expect(second.isError).toBeUndefined();
		expect(spawned.mock.calls[1][2]?.cwd).toBe(fs.realpathSync(nested));
		await expect(execute("subagent", { agent: "test-worker", task: "wrong cwd", cwd: root, continuity })).rejects.toThrow(/policy_mismatch/);
	});
	it("rejects continuity without scope, unknown IDs, wrong agent and scope widening", async () => {
		await expect(execute("subagent", { agent: "test-worker", task: "x", continuity: { mode: "create" } })).rejects.toThrow(/write_scope/);
		await expect(execute("subagent", { agent: "test-worker", task: "x", continuity: { mode: "resume", worker_id: "11111111-1111-1111-1111-111111111111" } })).rejects.toThrow(/unknown_worker/);
		scripts.push({ events: [say("one")] }, { events: [say("narrow")] });
		const first = await execute("subagent", { agent: "test-worker", task: "x", write_scope: [{ path: root, kind: "directory" }], continuity: { mode: "create" } });
		const continuity = { mode: "resume", worker_id: first.details.results[0].worker_session.id };
		await expect(execute("subagent", { agent: "test-judge", task: "x", continuity })).rejects.toThrow(/policy_mismatch/);
		await execute("subagent", { agent: "test-worker", task: "narrow", write_scope: [], continuity });
		await expect(execute("subagent", { agent: "test-worker", task: "widen", write_scope: [{ path: root, kind: "directory" }], continuity })).rejects.toThrow(/widen/);
		expect(launches).toHaveLength(2);
	});
	it("rejects a second pending/active turn and releases busy after completion", async () => {
		scripts.push({ events: [say("one")] }, { events: [say("two")], hold: true });
		const first = await execute("subagent", { agent: "test-worker", task: "one", write_scope: [], continuity: { mode: "create" } });
		const continuity = { mode: "resume", worker_id: first.details.results[0].worker_session.id };
		const active = execute("subagent", { agent: "test-worker", task: "two", continuity });
		await vi.waitFor(() => expect(launches).toHaveLength(2));
		await expect(execute("subagent", { agent: "test-worker", task: "concurrent", continuity })).rejects.toThrow(/worker_busy/);
		releases[0](); await active;
	});
	it("fails closed on an unexpected worker model and refuses its transcript", async () => {
		const wrong = say("wrong model"); wrong.message.model = "unexpected";
		scripts.push({ events: [wrong] });
		const first = await execute("subagent", { agent: "test-worker", task: "x", write_scope: [], continuity: { mode: "create" } });
		expect(first.isError).toBe(true);
		expect(first.details.results[0].progress.error).toMatch(/model mismatch/);
		expect(first.details.results[0].worker_session.resumable).toBe(false);
		await expect(execute("subagent", { agent: "test-worker", task: "resume", continuity: { mode: "resume", worker_id: first.details.results[0].worker_session.id } })).rejects.toThrow(/transcript/);
	});
	it("preserves a queued worker on cancellation, and closes active children before cleanup", async () => {
		scripts.push({ events: [say("seed")] }, { events: [say("blocker")], hold: true }, { events: [say("resumed")], hold: true });
		const first = await execute("subagent", { agent: "test-worker", task: "seed", write_scope: [], continuity: { mode: "create" } });
		const continuity = { mode: "resume", worker_id: first.details.results[0].worker_session.id };
		const blocking = execute("subagent", { agent: "test-worker", task: "blocker", write_scope: [], resources: ["gate"] });
		await vi.waitFor(() => expect(launches).toHaveLength(2));
		const controller = new AbortController();
		const queued = execute("subagent", { agent: "test-worker", task: "queued", continuity, resources: ["gate"] }, controller.signal);
		await Promise.resolve(); controller.abort();
		expect((await queued).isError).toBe(true); expect(launches).toHaveLength(2);
		releases[0](); await blocking;
		const active = execute("subagent", { agent: "test-worker", task: "next", continuity });
		await vi.waitFor(() => expect(launches).toHaveLength(3));
		const file = launches[2].args[launches[2].args.indexOf("--session") + 1];
		await hooks.get("session_shutdown")!({}, ctx);
		const stopped = await active;
		expect(stopped.details.results[0].worker_session).toMatchObject({ turn: 2, status: "cancelled", resumable: false });
		expect(fs.existsSync(file)).toBe(false);
	});
	it("preserves per-step and judge resource coordination without enabling continuation", async () => {
		scripts.push({ events: [say("step1")] }, { events: [say("step2")] }, { events: [say("runner")] }, { events: [say("YES")] });
		const pipeline = await execute("pipeline", { steps: [{ agent: "test-worker", task: "first", resources: ["cache"] }, { agent: "test-worker", task: "second", resources: ["cache"] }] });
		expect(pipeline.details.pipelineResult.steps.every((s: any) => s.delivery.coordination.claims.names.includes("cache"))).toBe(true);
		const loop = await execute("loop", { agent: "test-worker", task: "run", resources: ["cache"], judge: { agent: "test-judge", criteria: "done" } });
		expect(loop.details.loopResult.iterations[0].judgeDelivery.coordination.claims.names).toEqual(["cache"]);
		expect(launches.every(l => l.args.includes("--no-session"))).toBe(true);
	});
	it("invalidates IDs on shutdown and removes only private worker history", async () => {
		scripts.push({ events: [say("one")] });
		const first = await execute("subagent", { agent: "test-worker", task: "one", write_scope: [], continuity: { mode: "create" } });
		const file = launches[0].args[launches[0].args.indexOf("--session") + 1];
		expect(fs.statSync(file).mode & 0o777).toBe(0o600);
		await hooks.get("session_shutdown")!({}, ctx);
		expect(fs.existsSync(file)).toBe(false); expect(fs.existsSync(path.join(root, "reference.md"))).toBe(true);
		await expect(execute("subagent", { agent: "test-worker", task: "resume", continuity: { mode: "resume", worker_id: first.details.results[0].worker_session.id } })).rejects.toThrow(/unknown_worker/);
	});
	it("prepares reservations for every pipeline step before spawning, and rejects unsupported continuity", async () => {
		await expect(execute("pipeline", { steps: [{ agent: "test-worker", task: "x" }, { agent: "test-worker", task: "y", resources: [""] }] })).rejects.toThrow(/resource/);
		for (const name of ["pipeline", "loop"]) expect(() => tools.get(name).prepareArguments({ continuity: { mode: "create" } })).toThrow(/subagent only/);
		for (const name of ["subagent", "pipeline", "loop"]) expect(() => tools.get(name).prepareArguments({ resources: null })).toThrow(/resources/);
		expect(() => tools.get("subagent").prepareArguments({ continuity: null })).toThrow();
		expect(launches).toHaveLength(0);
	});
	it("schemas expose optional context and an explicitly restricted write_scope", () => {
		for (const schema of [tools.get("subagent").parameters, tools.get("loop").parameters, tools.get("pipeline").parameters.properties.steps.items]) {
			expect(schema.properties.context_files).toBeDefined(); expect(schema.properties.constraints.description).toContain("NOT an enforced sandbox");
			expect(schema.required).not.toContain("acceptance"); expect(schema.required).not.toContain("write_scope");
			expect(schema.properties.write_scope.description).toContain("Disables shell");
		}
	});
});
