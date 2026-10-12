import type { SavedEdit } from "./types";

export const MAX_ARCHIVED_EDITS = 100;
export const MAX_ARCHIVE_BYTES = 512_000;

/** Oldest-first, bounded edit history separate from the 50-call live tool log. */
export class EditArchive {
    private saved: SavedEdit[] = [];
    private bytes = 0;
    omitted = 0;

    add(edit: SavedEdit): void {
        const size = Buffer.byteLength(edit.file + edit.diff + edit.agent, "utf8");
        if (size > MAX_ARCHIVE_BYTES) { this.omitted++; return; }
        while (this.saved.length >= MAX_ARCHIVED_EDITS || this.bytes + size > MAX_ARCHIVE_BYTES) {
            const oldest = this.saved.shift();
            if (!oldest) break;
            this.bytes -= Buffer.byteLength(oldest.file + oldest.diff + oldest.agent, "utf8");
            this.omitted++;
        }
        this.saved.push(edit);
        this.bytes += size;
    }

    addAll(edits: readonly SavedEdit[]): void {
        for (const edit of edits) this.add(edit);
    }

    recordOmissions(count: number): void {
        this.omitted += count;
    }

    entries(): SavedEdit[] { return [...this.saved]; }
}
