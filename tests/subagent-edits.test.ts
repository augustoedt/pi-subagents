import { describe, expect, it } from "vitest";
import { latestSubagentEdits } from "../lib/subagent-edits";

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
});
