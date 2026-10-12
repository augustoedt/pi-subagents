export interface SubagentEdit {
    file: string;
    diff: string;
}

/** Read the latest direct subagent result on the active session branch; never scan other branches. */
export function latestSubagentEdits(branch: readonly unknown[]): SubagentEdit[] {
    for (let i = branch.length - 1; i >= 0; i--) {
        const entry = branch[i] as { type?: string; message?: unknown } | null;
        if (entry?.type !== "message") continue;
        const message = entry.message as { role?: string; toolName?: string; details?: unknown } | null;
        if (message?.role !== "toolResult" || message.toolName !== "subagent") continue;
        const details = message.details as { results?: unknown } | undefined;
        if (!Array.isArray(details?.results)) return [];
        const edits: SubagentEdit[] = [];
        for (const result of details.results) {
            const progress = (result as { progress?: { recentTools?: unknown } } | null)?.progress;
            if (!Array.isArray(progress?.recentTools)) continue;
            for (const tool of progress.recentTools) {
                const call = tool as { tool?: string; args?: unknown; editSucceeded?: boolean; editDiff?: unknown } | null;
                if (call?.tool === "edit" && call.editSucceeded && typeof call.editDiff === "string" && call.editDiff) {
                    edits.push({ file: typeof call.args === "string" ? call.args : "(unknown file)", diff: call.editDiff });
                }
            }
        }
        return edits;
    }
    return [];
}
