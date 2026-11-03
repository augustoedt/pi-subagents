import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { planRestrictedAgent, restrictedNotice } from "../lib/restricted-mode";
import { resolveWriteScope } from "../lib/write-scope";
import { validateRuntimeConfig } from "../lib/preflight";
import type { AgentConfig } from "../lib/types";

let cwd: string;
const worker: AgentConfig = { name: "worker", description: "", tools: ["read", "edit", "write", "bash", "safe_bash", "subagent", "web_fetch", "custom"], model: "test/model", thinking: "low", systemPrompt: "", filePath: "" };
beforeEach(() => { cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "restricted-plan-"))); fs.mkdirSync(path.join(cwd, "src")); });
afterEach(() => fs.rmSync(cwd, { recursive: true, force: true }));
const roots = () => [{ path: "src", kind: "directory" }];

describe("restricted launch policy", () => {
	it("preserves the original agent unchanged when no scope is requested", () => {
		const p = planRestrictedAgent(worker, undefined, cwd);
		expect(p.agent).toBe(worker); expect(p.scope).toBeUndefined(); expect(p.excludedTools).toEqual([]);
		expect(restrictedNotice(p)).toBe("");
	});
	it("only keeps declared local reads and replaces declared mutators", () => {
		const p = planRestrictedAgent(worker, roots(), cwd);
		expect(p.agent.tools).toEqual(["read", "scoped_edit", "scoped_write"]);
		expect(p.disabledTools).toEqual(["bash", "safe_bash", "subagent", "web_fetch", "custom"]);
		expect(p.agent.subagentAgents).toEqual([]);
		expect(p.excludedTools).toContain("mcp__*"); expect(p.excludedTools).toContain("write");
		expect(restrictedNotice(p)).toContain("coordinator must run builds/tests");
	});
	it("does not grant mutators to a read-only agent", () => {
		const p = planRestrictedAgent({ ...worker, tools: ["read", "ls"] }, roots(), cwd);
		expect(p.agent.tools).toEqual(["read", "ls"]);
	});
	it("an explicit empty scope is deny-all, not unrestricted", () => {
		const p = planRestrictedAgent(worker, [], cwd);
		expect(p.scope?.roots).toEqual([]); expect(p.agent.tools).toEqual(["read"]);
	});
	it("invalid scope is rejected, not silently dropped", () => {
		for (const bad of [null, false, {}, "src", [{ path: "src", kind: "glob" }]]) expect(() => planRestrictedAgent(worker, bad, cwd)).toThrow();
	});
	it("inherits ambient scope; allows narrowing, never widening", () => {
		const ambient = JSON.stringify(resolveWriteScope(roots(), cwd));
		expect(planRestrictedAgent(worker, undefined, cwd, ambient).agent.tools).toEqual(["read", "scoped_edit", "scoped_write"]);
		expect(planRestrictedAgent(worker, [{ path: "src/new.ts", kind: "file" }], cwd, ambient).scope?.roots).toHaveLength(1);
		expect(planRestrictedAgent(worker, [], cwd, ambient).scope?.roots).toEqual([]);
		expect(() => planRestrictedAgent(worker, [{ path: cwd, kind: "directory" }], cwd, ambient)).toThrow(/widen/);
		expect(() => planRestrictedAgent(worker, roots(), cwd, JSON.stringify({ version: 1, roots: [] }))).toThrow(/widen/);
		expect(() => planRestrictedAgent(worker, undefined, cwd, "broken")).toThrow();
	});
	it("an exact ambient file cannot become a directory or sibling", () => {
		const ambient = JSON.stringify(resolveWriteScope([{ path: "src/only.ts", kind: "file" }], cwd));
		expect(() => planRestrictedAgent(worker, roots(), cwd, ambient)).toThrow(/widen/);
		expect(() => planRestrictedAgent(worker, [{ path: "src/other.ts", kind: "file" }], cwd, ambient)).toThrow(/widen/);
	});
	it("rejects configured scope injection rather than overwriting task policy", () => {
		expect(() => validateRuntimeConfig({ envExtra: { PI_SUBAGENT_WRITE_SCOPE: "{}" } })).toThrow(/write_scope/);
	});
});
