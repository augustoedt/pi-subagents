import { describe, expect, it } from "vitest";
import { EditArchive, MAX_ARCHIVED_EDITS, MAX_ARCHIVE_BYTES } from "../lib/edit-archive";

describe("bounded edit archive", () => {
    it("keeps the newest 100 edits in chronological order and counts omissions", () => {
        const archive = new EditArchive();
        for (let i = 0; i < 120; i++) archive.add({ file: `${i}.txt`, diff: `+ ${i}`, agent: "worker" });
        expect(archive.entries()).toHaveLength(MAX_ARCHIVED_EDITS);
        expect(archive.entries()[0]?.file).toBe("20.txt");
        expect(archive.entries().at(-1)?.file).toBe("119.txt");
        expect(archive.omitted).toBe(20);
    });

    it("bounds UTF-8 bytes even with large diffs, retaining the newest", () => {
        const archive = new EditArchive();
        for (let i = 0; i < 30; i++) archive.add({ file: `${i}.txt`, diff: "á".repeat(12_000), agent: "worker" });
        const entries = archive.entries();
        const bytes = entries.reduce((n, e) => n + Buffer.byteLength(e.file + e.diff + e.agent), 0);
        expect(bytes).toBeLessThanOrEqual(MAX_ARCHIVE_BYTES);
        expect(entries.at(-1)?.file).toBe("29.txt");
        expect(archive.omitted).toBe(30 - entries.length);
    });

    it("counts a single oversized edit without hiding later small edits", () => {
        const archive = new EditArchive();
        archive.add({ file: "large", diff: "x".repeat(MAX_ARCHIVE_BYTES + 1), agent: "worker" });
        archive.add({ file: "small", diff: "+ ok", agent: "worker" });
        archive.recordOmissions(2);
        expect(archive.entries().map(e => e.file)).toEqual(["small"]);
        expect(archive.omitted).toBe(3);
    });
});
