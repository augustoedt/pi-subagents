import { describe, expect, it } from "vitest";
import { fullEditDiff, previewEditDiff } from "../lib/tool-edit-diff";

describe("edit preview", () => {
    it("shows only changed lines, not unchanged replacement context", () => {
        expect(previewEditDiff({ edits: [{ oldText: "before\nold\nafter\n", newText: "before\nnew\nafter\n" }] }))
            .toBe("- old\n+ new");
    });

    it("keeps unchanged lines interleaved among changed lines", () => {
        expect(previewEditDiff({ edits: [{
            oldText: "old cyan\nold magenta\nkeep B2\nold yellow",
            newText: "new cyan\nnew magenta\nkeep B2\nnew yellow",
        }] })).toBe("- old cyan\n- old magenta\n+ new cyan\n+ new magenta\n  keep B2\n- old yellow\n+ new yellow");
    });

    it("aligns unchanged lines after insertions and deletions", () => {
        expect(previewEditDiff({ edits: [{
            oldText: "remove\nkeep\nold",
            newText: "keep\nnew\ninsert",
        }] })).toBe("- remove\n  keep\n- old\n+ new\n+ insert");
    });

    it("labels multiple disjoint replacements", () => {
        expect(previewEditDiff({ edits: [
            { oldText: "a", newText: "b" },
            { oldText: "c", newText: "d" },
        ] })).toBe("@@ edit 1 @@\n- a\n+ b\n@@ edit 2 @@\n- c\n+ d");
    });

    it("supports single edit arguments and ignores unrelated tools", () => {
        expect(previewEditDiff({ oldText: "old", newText: "new" })).toBe("- old\n+ new");
        expect(previewEditDiff({ path: "file.ts" })).toBeUndefined();
        expect(previewEditDiff({ edits: [{ oldText: "same", newText: "same" }] })).toBeUndefined();
    });

    it("marks previews truncated by the line limit", () => {
        const preview = previewEditDiff({ edits: [{
            oldText: Array.from({ length: 120 }, (_, i) => `old ${i}`).join("\n"),
            newText: Array.from({ length: 120 }, (_, i) => `new ${i}`).join("\n"),
        }] });
        expect(preview).toContain("diff preview truncated; remaining lines from this edit were not stored");
        expect(preview!.split("\n").length).toBeLessThanOrEqual(101);
    });

    it("retains all 120 changed lines from one edit for /se, while bounding the inline preview", () => {
        const args = { edits: [{
            oldText: Array.from({ length: 60 }, (_, i) => `old ${i}`).join("\n"),
            newText: Array.from({ length: 60 }, (_, i) => `new ${i}`).join("\n"),
        }] };
        expect(previewEditDiff(args)).toContain("diff preview truncated");
        const full = fullEditDiff(args)!;
        expect(full.split("\n")).toHaveLength(120);
        expect(full).toContain("+ new 59");
        expect(full).not.toContain("safety limit");
    });

    it("keeps multiple replacements grouped in one full per-call diff", () => {
        const full = fullEditDiff({ edits: [
            { oldText: "one", newText: "two" },
            { oldText: "three", newText: "four" },
        ] });
        expect(full).toBe("@@ edit 1 @@\n- one\n+ two\n@@ edit 2 @@\n- three\n+ four");
    });

    it("reports when input exceeds the safe source size without copying it into the result", () => {
        expect(fullEditDiff({ oldText: "x".repeat(130_000), newText: "y" }))
            .toBe("… edit exceeds safe source size; diff was not captured");
    });

    it("marks the per-call safety limit when the full diff exceeds 500 lines", () => {
        const full = fullEditDiff({ edits: [{
            oldText: Array.from({ length: 300 }, (_, i) => `old ${i}`).join("\n"),
            newText: Array.from({ length: 300 }, (_, i) => `new ${i}`).join("\n"),
        }] })!;
        expect(full.split("\n")).toHaveLength(501);
        expect(full).toContain("per-edit safety limit reached");
    });

    it("bounds large previews and explains that omitted lines were not stored", () => {
        const preview = previewEditDiff({ edits: [{ oldText: "x".repeat(10_000), newText: "y" }] });
        expect(preview).toContain("diff preview truncated; remaining lines from this edit were not stored");
        expect(preview!.length).toBeLessThan(8_100);
    });
});
