import { describe, expect, it } from "vitest";
import { editPreviewNotice, latestSubagentEdits, moveEditPreview } from "../lib/subagent-edits";

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
            { file: "first.txt", diff: "- old\n+ new" },
            { file: "second.txt", diff: "- red\n+ blue" },
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
            { file: "new.txt", diff: "- old\n+ new\n+ last" },
            { file: "legacy.txt", diff: "- old\n… diff preview truncated; use git diff for full changes" },
        ]);
    });

    it("uses the latest subagent, even when it has no edits", () => {
        const earlier = result([{ tool: "edit", args: "earlier.txt", editSucceeded: true, editDiff: "- a\n+ b" }]);
        expect(latestSubagentEdits([earlier, result([])])).toEqual([]);
        expect(latestSubagentEdits([earlier, result([], "pipeline")])).toEqual([
            { file: "earlier.txt", diff: "- a\n+ b" },
        ]);
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
