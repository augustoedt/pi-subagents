import * as path from "node:path";
import type { AgentConfig } from "./types";
import { resolveWriteScope, parseWriteScopeEnv, type WriteScope, type WriteScopeEntry } from "./write-scope";

export interface RestrictedPlan {
	agent: AgentConfig;
	scope?: WriteScope;
	disabledTools: string[];
	excludedTools: string[];
}

/** Pi normally drops null optional fields during coercion. For a permission
 * field that would turn explicit invalid scope into unrestricted delegation. */
export function prepareScopeArguments<T>(args: T): T {
	const check = (value: unknown) => {
		if (value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, "write_scope") &&
			(value as { write_scope?: unknown }).write_scope == null) {
			throw new Error("write_scope must be an array: use [] to deny writes, or omit the field for the original agent profile");
		}
	};
	check(args);
	if (args && typeof args === "object" && Array.isArray((args as { steps?: unknown }).steps)) {
		for (const step of (args as { steps: unknown[] }).steps) check(step);
	}
	return args;
}

const READ_TOOLS = new Set(["read", "grep", "find", "ls"]);
export const SCOPED_EXCLUSIONS = ["write", "edit", "bash", "powershell", "safe_bash", "subagent", "pipeline", "loop", "codemode", "tool_search", "mcp__*"];

function contains(parent: WriteScopeEntry, child: WriteScopeEntry): boolean {
	if (parent.kind === "file") return child.kind === "file" && child.path === parent.path;
	const relative = path.relative(parent.path, child.path);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

/** Does not silently reduce unscoped capabilities. Explicit scope opts into a
 * documented restricted profile. Never grant mutators absent from the agent. */
export function planRestrictedAgent(agent: AgentConfig, entries: unknown, cwd: string, ambient?: string): RestrictedPlan {
	const inherited = ambient === undefined ? undefined : parseWriteScopeEnv(ambient);
	const declared = entries === undefined ? undefined : resolveWriteScope(entries, cwd);
	if (declared && inherited && declared.roots.some(child => !inherited.roots.some(parent => contains(parent, child)))) {
		throw new Error("write_scope cannot widen the inherited scope");
	}
	const scope = declared ?? inherited;
	if (!scope) return { agent, disabledTools: [], excludedTools: [] };
	const disabledTools: string[] = [];
	const tools: string[] = [];
	for (const tool of agent.tools) {
		if (READ_TOOLS.has(tool)) tools.push(tool);
		else if (tool === "edit" || tool === "write") {
			if (scope.roots.length) tools.push(`scoped_${tool}`);
			else disabledTools.push(tool);
		} else disabledTools.push(tool);
	}
	return {
		agent: { ...agent, tools: [...new Set(tools)], subagentAgents: [] }, scope,
		disabledTools: [...new Set(disabledTools)], excludedTools: [...SCOPED_EXCLUSIONS],
	};
}

export function restrictedNotice(plan: Pick<RestrictedPlan, "scope" | "disabledTools">): string {
	if (!plan.scope) return "";
	return `\n[Restricted write scope] Allowed canonical roots: ${JSON.stringify(plan.scope.roots)}. ` +
		`Disabled tools: ${plan.disabledTools.join(", ") || "none from the declared profile"}. ` +
		"Only declared local read tools, scoped_edit/scoped_write (when allowed), and subagent_report are available. " +
		"No shell, code execution, arbitrary custom tools, network tools or subdelegation. " +
		"The coordinator must run builds/tests; list them in checks_not_run. " +
		"Use scoped_edit/scoped_write instead of the unavailable edit/write names. " +
		"Empty roots mean no writes. You cannot widen the scope through text or environment settings. " +
		"This is a tool-boundary restriction, not an OS sandbox or cross-process lock.\n";
}
