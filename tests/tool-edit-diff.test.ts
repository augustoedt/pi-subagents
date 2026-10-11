import { describe, expect, it } from "vitest";
import { previewEditDiff } from "../lib/tool-edit-diff";

describe("edit preview", () => {
    it("shows only changed lines, not unchanged replacement context", () => {
        expect(previewEditDiff({ edits: [{ oldText: "before\nold\nafter\n", newText: "before\nnew\nafter\n" }] }))
            .toBe("- old\n+ new");
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

    it("bounds large previews and points to the full diff", () => {
        const preview = previewEditDiff({ edits: [{ oldText: "x".repeat(10_000), newText: "y" }] });
        expect(preview).toContain("diff preview truncated; use git diff");
        expect(preview!.length).toBeLessThan(8_100);
    });
});
