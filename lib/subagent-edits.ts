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

export interface SubagentEdit {
    file: string;
    diff: string;
}

export interface SubagentRun {
    id: string;
    agent: string;
    timestamp?: string;
    edits: SubagentEdit[];
}

function editsFromResult(result: unknown): SubagentEdit[] {
    const progress = (result as { progress?: { recentTools?: unknown } } | null)?.progress;
    if (!Array.isArray(progress?.recentTools)) return [];
    const edits: SubagentEdit[] = [];
    for (const tool of progress.recentTools) {
        const call = tool as { tool?: string; args?: unknown; editSucceeded?: boolean; editDiff?: unknown; editFullDiff?: unknown } | null;
        if (call?.tool !== "edit" || !call.editSucceeded) continue;
        const diff = typeof call.editFullDiff === "string" && call.editFullDiff
            ? call.editFullDiff : call.editDiff;
        if (typeof diff === "string" && diff) {
            edits.push({ file: typeof call.args === "string" ? call.args : "(unknown file)", diff });
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
        if (message?.role !== "toolResult" || message.toolName !== "subagent") continue;
        const details = message.details as { results?: unknown } | undefined;
        if (!Array.isArray(details?.results)) continue;
        for (const result of details.results) {
            const item = result as { agent?: string } | null;
            runs.push({
                id: entry.id ?? String(i), agent: item?.agent ?? "subagent",
                timestamp: entry.timestamp, edits: editsFromResult(result),
            });
        }
    }
    return runs;
}

export function latestSubagentEdits(branch: readonly unknown[]): SubagentEdit[] {
    return listSubagentRuns(branch)[0]?.edits ?? [];
}
