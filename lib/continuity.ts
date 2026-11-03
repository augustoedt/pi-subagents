import { createHash } from "node:crypto";
import type { AgentConfig } from "./types";
import { prepareScopeArguments } from "./restricted-mode";
import { createResourceClaims } from "./resource-coordinator";

export type Continuity = { mode: "create" } | { mode: "resume"; worker_id: string };
export function parseContinuity(value: unknown): Continuity | undefined {
	if (value === undefined) return;
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("continuity must specify create or resume");
	const v = value as Record<string, unknown>;
	if (v.mode === "create" && Object.keys(v).every(k => k === "mode")) return { mode: "create" };
	if (v.mode === "resume" && Object.keys(v).every(k => k === "mode" || k === "worker_id") &&
		typeof v.worker_id === "string" && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v.worker_id)) return { mode: "resume", worker_id: v.worker_id };
	throw new Error("Invalid continuity mode or worker_id; use only an ID returned by this session/instance");
}

/** Validate permission/reservation fields before Pi can coerce null into omission. */
export function prepareOrchestrationArguments<T>(args: T, allowContinuity = false): T {
	prepareScopeArguments(args);
	const check = (node: unknown, allow: boolean) => {
		if (!node || typeof node !== "object") return;
		const obj = node as Record<string, unknown>;
		if (Object.prototype.hasOwnProperty.call(obj, "resources")) createResourceClaims({ agent: { tools: [] } }, obj.resources);
		if (Object.prototype.hasOwnProperty.call(obj, "continuity")) {
			if (!allow || obj.continuity == null) throw new Error("continuity is opt-in on subagent only; omit it for ephemeral execution");
			parseContinuity(obj.continuity);
		}
	};
	check(args, allowContinuity);
	if (args && typeof args === "object" && Array.isArray((args as { steps?: unknown }).steps)) {
		for (const step of (args as { steps: unknown[] }).steps) check(step, false);
	}
	return args;
}

export function agentFingerprint(agent: AgentConfig): string {
	return createHash("sha256").update(JSON.stringify({ name: agent.name, tools: agent.tools,
		model: agent.model, thinking: agent.thinking, systemPrompt: agent.systemPrompt,
		subagentAgents: agent.subagentAgents ?? [] })).digest("hex");
}
