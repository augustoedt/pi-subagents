import { describe, it, expect } from "vitest";
import { parseContinuity, prepareOrchestrationArguments, agentFingerprint } from "../lib/continuity";
import { validateRuntimeConfig } from "../lib/preflight";
import type { AgentConfig } from "../lib/types";

describe("continuity and admission input contract", () => {
	it("requires explicit create or an issued UUID, never caller-selected file paths", () => {
		expect(parseContinuity(undefined)).toBeUndefined();
		expect(parseContinuity({ mode: "create" })).toEqual({ mode: "create" });
		expect(parseContinuity({ mode: "resume", worker_id: "11111111-1111-1111-1111-111111111111" })?.mode).toBe("resume");
		for (const value of [null, [], {}, "create", { mode: "create", worker_id: "chosen" }, { mode: "resume", worker_id: "/tmp/a.jsonl" }, { mode: "resume", worker_id: "../x" }]) expect(() => parseContinuity(value)).toThrow();
	});
	it("rejects null reservations and nested continuity before optional-field coercion", () => {
		for (const node of [{ resources: null }, { continuity: null }, { steps: [{ resources: null }] }, { steps: [{ continuity: { mode: "create" } }] }]) expect(() => prepareOrchestrationArguments(node, true)).toThrow();
		expect(() => prepareOrchestrationArguments({ continuity: { mode: "create" } })).toThrow(/subagent only/);
		expect(prepareOrchestrationArguments({ continuity: { mode: "create" }, resources: [] }, true)).toEqual({ continuity: { mode: "create" }, resources: [] });
	});
	it("fingerprints the resolved policy, not only agent name or description", () => {
		const agent: AgentConfig = { name: "worker", description: "test", tools: ["read", "write"], systemPrompt: "stable", thinking: "low", model: "test/model", filePath: "unused" };
		const fingerprint = agentFingerprint(agent);
		expect(agentFingerprint({ ...agent })).toBe(fingerprint);
		expect(agentFingerprint({ ...agent, description: "cosmetic" })).toBe(fingerprint);
		for (const override of [{ model: "test/other" }, { thinking: "high" }, { tools: ["read"] }, { systemPrompt: "changed" }, { subagentAgents: ["scout"] }]) expect(agentFingerprint({ ...agent, ...override })).not.toBe(fingerprint);
	});
	it("validates queue config independently of child timeouts", () => {
		expect(() => validateRuntimeConfig({ queueTimeoutMs: 0, maxQueueDepth: 0 })).not.toThrow();
		expect(() => validateRuntimeConfig({ queueTimeoutMs: 100, maxQueueDepth: 64 })).not.toThrow();
		for (const value of [-1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
			expect(() => validateRuntimeConfig({ queueTimeoutMs: value })).toThrow(/queueTimeoutMs/);
			expect(() => validateRuntimeConfig({ maxQueueDepth: value })).toThrow(/maxQueueDepth/);
		}
	});
});
