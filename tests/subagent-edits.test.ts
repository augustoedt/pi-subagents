import { describe, expect, it } from "vitest";
import { MAX_SUBAGENT_RUNS, collectAgentEdits, editPreviewNotice, latestSubagentEdits, listSubagentRuns, moveEditPreview } from "../lib/subagent-edits";

const result = (recentTools: unknown[], toolName = "subagent") => ({
    type: "message",
    message: { role: "toolResult", toolName, details: { results: [{ progress: { recentTools } }] } },
});

describe("/se latest subagent edits", () => {
    it("lists successful edits across files in call order", () => {
        const branch = [result([
            { tool: "read", args: "first.txt" },
            { tool: "edit", args: "first.txt", editSucceeded: true, editDiff: "- old\n+ new" },
            { tool: "edit", args: "second.txt", editSucceeded: true, editDiff: "- red\n+ blue" },
            { tool: "edit", args: "broken.txt", editSucceeded: false, editDiff: "- a\n+ b" },
        ])];
        expect(latestSubagentEdits(branch)).toEqual([
            { file: "first.txt", diff: "- old\n+ new", agent: "subagent" },
            { file: "second.txt", diff: "- red\n+ blue", agent: "subagent" },
        ]);
    });

    it("prefers the longer per-call diff in /se and falls back for older sessions", () => {
        const branch = [result([
            { tool: "edit", args: "new.txt", editSucceeded: true,
              editDiff: "- old\n… inline preview truncated; open /se for this edit",
              editFullDiff: "- old\n+ new\n+ last" },
            { tool: "edit", args: "legacy.txt", editSucceeded: true,
              editDiff: "- old\n… diff preview truncated; use git diff for full changes" },
        ])];
        expect(latestSubagentEdits(branch)).toEqual([
            { file: "new.txt", diff: "- old\n+ new\n+ last", agent: "subagent" },
            { file: "legacy.txt", diff: "- old\n… diff preview truncated; use git diff for full changes", agent: "subagent" },
        ]);
    });

    it("lists prior direct runs newest first, including runs without edits", () => {
        const first = result([{ tool: "edit", args: "before.txt", editSucceeded: true, editDiff: "- a\n+ b" }]);
        const second = result([]);
        expect(listSubagentRuns([{ ...first, id: "first", timestamp: "2026-10-11T10:00:00Z" },
                                 { ...second, id: "second", timestamp: "2026-10-11T11:00:00Z" }]))
            .toMatchObject([
                { id: "second", kind: "subagent", agent: "subagent", timestamp: "2026-10-11T11:00:00Z", edits: [] },
                { id: "first", kind: "subagent", agent: "subagent", timestamp: "2026-10-11T10:00:00Z",
                  edits: [{ file: "before.txt", diff: "- a\n+ b", agent: "subagent" }] },
            ]);
    });

    it("keeps only the latest ten executions, including scout/researcher without edits", () => {
        const entries = Array.from({ length: 12 }, (_, i) => ({ type: "message", id: `run-${i}`,
            message: { role: "toolResult", toolName: "subagent", details: { results: [{
                agent: i % 2 ? "researcher" : "scout", output: `Finding ${i}`, progress: { recentTools: [] },
            }] } } }));
        const runs = listSubagentRuns(entries);
        expect(runs).toHaveLength(MAX_SUBAGENT_RUNS);
        expect(runs.map(run => run.id)).toEqual(Array.from({ length: 10 }, (_, i) => `run-${11 - i}`));
        expect(runs[0]).toMatchObject({ agent: "researcher", output: "Finding 11", edits: [] });
        expect(runs[1]).toMatchObject({ agent: "scout", output: "Finding 10", edits: [] });
    });

    it("caps parallel results from one tool call at ten executions", () => {
        const branch = [{ type: "message", message: { role: "toolResult", toolName: "subagent",
            details: { results: Array.from({ length: 12 }, (_, i) => ({ agent: `agent-${i}`, output: `Result ${i}` })) } } }];
        expect(listSubagentRuns(branch).map(run => run.agent)).toEqual(Array.from({ length: 10 }, (_, i) => `agent-${i}`));
    });

    it("uses the latest subagent, even when it has no edits", () => {
        const earlier = result([{ tool: "edit", args: "earlier.txt", editSucceeded: true, editDiff: "- a\n+ b" }]);
        expect(latestSubagentEdits([earlier, result([])])).toEqual([]);
        expect(latestSubagentEdits([earlier, result([], "pipeline")])).toEqual([
            { file: "earlier.txt", diff: "- a\n+ b", agent: "subagent" },
        ]);
    });

    it("attributes nested edits to the actual child and preserves call order", () => {
        const child = { agent: "worker", progress: { recentTools: [
            { tool: "edit", args: "child.txt", editSucceeded: true, editDiff: "- a\n+ b" },
        ] } };
        const parent = { agent: "manager", progress: { recentTools: [
            { tool: "subagent", children: [child] },
            { tool: "edit", args: "parent.txt", editSucceeded: true, editDiff: "- c\n+ d" },
        ] } };
        expect(collectAgentEdits(parent)).toEqual([
            { file: "child.txt", diff: "- a\n+ b", agent: "manager › worker" },
            { file: "parent.txt", diff: "- c\n+ d", agent: "manager" },
        ]);
    });

    it("lists saved pipeline and loop edits with agent attribution", () => {
        const pipeline = { type: "message", id: "p", message: { role: "toolResult", toolName: "pipeline",
            details: { pipelineResult: { steps: [
                { agent: "scout", output: "Relevant file found", edits: [] },
                { agent: "worker", output: "Updated file", edits: [{ file: "pipeline.txt", diff: "+ p", agent: "worker" }] },
            ] } } } };
        const loop = { type: "message", id: "l", message: { role: "toolResult", toolName: "loop",
            details: { loopResult: { iterations: [
                { iteration: 1, output: "First pass", edits: [{ file: "loop.txt", diff: "+ l", agent: "worker" }] },
            ] } } } };
        expect(listSubagentRuns([pipeline, loop])).toMatchObject([
            { id: "l", kind: "loop", agent: "loop (1 iter.)", timestamp: undefined,
              output: "Iteração 1\nFirst pass", edits: [{ file: "loop.txt", diff: "+ l", agent: "worker" }] },
            { id: "p", kind: "pipeline", agent: "pipeline: scout → worker", timestamp: undefined,
              output: "1. scout\nRelevant file found\n\n2. worker\nUpdated file",
              edits: [{ file: "pipeline.txt", diff: "+ p", agent: "worker" }] },
        ]);
    });

    it("restores archived edits before the recent log and flags failures and omissions", () => {
        const entry = { type: "message", id: "failed", message: { role: "toolResult", toolName: "subagent",
            details: { results: [{ agent: "worker", exitCode: 1, progress: {
                status: "failed", toolCount: 60, archivedEdits: [
                    { file: "old.txt", diff: "- old\n+ middle", agent: "worker" },
                ], recentTools: [
                    { tool: "edit", args: "new.txt", editSucceeded: true, editFullDiff: "- middle\n+ final" },
                    { tool: "edit", args: "failed.txt", editSucceeded: false, editDiff: "- a\n+ b" },
                ], omittedEdits: 3, failedEdits: 1,
            } }] } } };
        expect(listSubagentRuns([entry])).toMatchObject([{ status: "failed", omittedEdits: 3,
            failedEdits: 1, historyIncomplete: false, edits: [
                { file: "old.txt", diff: "- old\n+ middle", agent: "worker" },
                { file: "new.txt", diff: "- middle\n+ final", agent: "worker" },
            ] }]);
    });

    it("shows a failed agent's saved error when it has no textual output", () => {
        const entry = { type: "message", message: { role: "toolResult", toolName: "subagent",
            details: { results: [{ agent: "researcher", exitCode: 1, progress: {
                status: "failed", error: "Research failed", recentTools: [],
            } }] } } };
        expect(listSubagentRuns([entry])).toMatchObject([{ agent: "researcher", status: "failed",
            edits: [], output: "Research failed" }]);
    });

    it("warns that older sessions may lack evicted edit history", () => {
        const entry = { type: "message", message: { role: "toolResult", toolName: "subagent",
            details: { results: [{ agent: "worker", progress: { toolCount: 55, recentTools: [] } }] } } };
        expect(listSubagentRuns([entry])).toMatchObject([{ historyIncomplete: true, edits: [] }]);
    });

    it("flags old pipeline/loop results that lack saved edits", () => {
        const pipeline = { type: "message", message: { role: "toolResult", toolName: "pipeline",
            details: { pipelineResult: { steps: [{ agent: "worker" }] } } } };
        const loop = { type: "message", message: { role: "toolResult", toolName: "loop",
            details: { loopResult: { iterations: [{ iteration: 1 }] } } } };
        expect(listSubagentRuns([pipeline, loop]).map(run => run.historyIncomplete)).toEqual([true, true]);
    });

    it("ignores malformed or absent results", () => {
        expect(latestSubagentEdits([])).toEqual([]);
        expect(latestSubagentEdits([{ type: "message", message: { role: "toolResult", toolName: "subagent" } }])).toEqual([]);
        expect(latestSubagentEdits([result([{ tool: "edit", args: "missing.txt", editSucceeded: true }])])).toEqual([]);
    });

    it("warns for current and previously saved truncated previews", () => {
        expect(editPreviewNotice("- old\n… diff preview truncated; remaining lines from this edit were not stored"))
            .toContain("Prévia antiga incompleta");
        expect(editPreviewNotice("… diff preview truncated; use git diff for full changes"))
            .toContain("Prévia antiga incompleta");
        expect(editPreviewNotice("… per-edit safety limit reached; remaining lines were not stored"))
            .toContain("Limite de segurança");
        expect(editPreviewNotice("… edit exceeds safe source size; diff was not captured"))
            .toContain("diff não capturado");
        expect(editPreviewNotice("… large edit: replacement preview without line alignment"))
            .toContain("Alinhamento");
        expect(editPreviewNotice("- old\n+ new")).toBeUndefined();
    });

    it("clamps line and page navigation at both ends, including short previews", () => {
        expect(moveEditPreview(0, -12, 80, 12)).toBe(0);
        expect(moveEditPreview(0, 12, 80, 12)).toBe(12);
        expect(moveEditPreview(60, 12, 80, 12)).toBe(68);
        expect(moveEditPreview(68, 1, 80, 12)).toBe(68);
        expect(moveEditPreview(0, 12, 4, 12)).toBe(0);
    });
});
