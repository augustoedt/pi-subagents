import type { SavedEdit } from "./types";

export function editPreviewNotice(diff: string): string | undefined {
    if (diff.includes("… per-edit safety limit reached")) return "Limite de segurança: parte do diff desta edição não foi guardada.";
    if (diff.includes("… edit exceeds safe source size")) return "Edição grande demais: diff não capturado.";
    if (diff.includes("… diff preview truncated")) return "Prévia antiga incompleta: o restante desta edição não foi guardado.";
    if (diff.includes("… inline preview truncated")) return "Prévia curta: o restante desta edição não está disponível neste resultado.";
    if (diff.includes("… large edit:")) return "Alinhamento de linhas indisponível para esta edição grande.";
    return undefined;
}

export function moveEditPreview(offset: number, delta: number, totalLines: number, visibleLines: number): number {
    return Math.max(0, Math.min(Math.max(0, totalLines - visibleLines), offset + delta));
}

export type SubagentEdit = SavedEdit;

export interface SubagentRun {
    id: string;
    agent: string;
    kind: "subagent" | "pipeline" | "loop";
    timestamp?: string;
    edits: SubagentEdit[];
}

type ToolCall = { tool?: string; args?: unknown; editSucceeded?: boolean; editDiff?: unknown; editFullDiff?: unknown; children?: unknown };

/** Traverse a child's chronological tool calls and nested children, attributing each edit to its actual agent. */
export function collectAgentEdits(result: unknown, parents: string[] = []): SubagentEdit[] {
    const item = result as { agent?: string; progress?: { recentTools?: unknown } } | null;
    const agent = [...parents, item?.agent ?? "subagent"].join(" › ");
    const tools = item?.progress?.recentTools;
    if (!Array.isArray(tools)) return [];
    const edits: SubagentEdit[] = [];
    for (const tool of tools) {
        const call = tool as ToolCall | null;
        if (!call) continue;
        if (call.tool === "edit" && call.editSucceeded) {
            const diff = typeof call.editFullDiff === "string" && call.editFullDiff
                ? call.editFullDiff : call.editDiff;
            if (typeof diff === "string" && diff) {
                edits.push({ file: typeof call.args === "string" ? call.args : "(unknown file)", diff, agent });
            }
        }
        if (Array.isArray(call.children)) {
            for (const child of call.children) edits.push(...collectAgentEdits(child, [...parents, item?.agent ?? "subagent"]));
        }
    }
    return edits;
}

/** Latest first, on the active session branch only; never read other branches or sessions. */
export function listSubagentRuns(branch: readonly unknown[]): SubagentRun[] {
    const runs: SubagentRun[] = [];
    for (let i = branch.length - 1; i >= 0; i--) {
        const entry = branch[i] as { type?: string; id?: string; timestamp?: string; message?: unknown } | null;
        if (entry?.type !== "message") continue;
        const message = entry.message as { role?: string; toolName?: string; details?: unknown } | null;
        if (message?.role !== "toolResult" || !["subagent", "pipeline", "loop"].includes(message.toolName ?? "")) continue;
        const details = message.details as { results?: unknown; pipelineResult?: unknown; loopResult?: unknown } | undefined;
        const base = { id: entry.id ?? String(i), timestamp: entry.timestamp };
        if (message.toolName === "subagent" && Array.isArray(details?.results)) {
            for (const result of details.results) {
                const item = result as { agent?: string } | null;
                runs.push({ ...base, kind: "subagent", agent: item?.agent ?? "subagent", edits: collectAgentEdits(result) });
            }
        } else if (message.toolName === "pipeline") {
            const steps = (details?.pipelineResult as { steps?: unknown } | undefined)?.steps;
            if (Array.isArray(steps)) {
                const edits = steps.flatMap(step => Array.isArray((step as { edits?: unknown })?.edits) ? (step as { edits: SavedEdit[] }).edits : []);
                runs.push({ ...base, kind: "pipeline", agent: `pipeline: ${steps.map(step => (step as { agent?: string })?.agent ?? "?").join(" → ")}`, edits });
            }
        } else if (message.toolName === "loop") {
            const iterations = (details?.loopResult as { iterations?: unknown } | undefined)?.iterations;
            if (Array.isArray(iterations)) {
                const edits = iterations.flatMap(iter => Array.isArray((iter as { edits?: unknown })?.edits) ? (iter as { edits: SavedEdit[] }).edits : []);
                runs.push({ ...base, kind: "loop", agent: `loop (${iterations.length} iter.)`, edits });
            }
        }
    }
    return runs;
}

export function latestSubagentEdits(branch: readonly unknown[]): SubagentEdit[] {
    return listSubagentRuns(branch)[0]?.edits ?? [];
}
