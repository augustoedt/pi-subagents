/** Bounded, display-only preview of edit tool replacements (not a repository diff). */
const MAX_DIFF_CHARS = 8_000;
const MAX_DIFF_LINES = 100;

type Replacement = { oldText: string; newText: string };

function replacementDiff({ oldText, newText }: Replacement): string[] {
    if (oldText === newText) return [];
    const before = oldText.split("\n");
    const after = newText.split("\n");
    // Ignore the empty split element caused by a final newline.
    if (oldText.endsWith("\n")) before.pop();
    if (newText.endsWith("\n")) after.pop();
    while (before.length && after.length && before[0] === after[0]) {
        before.shift();
        after.shift();
    }
    while (before.length && after.length && before.at(-1) === after.at(-1)) {
        before.pop();
        after.pop();
    }
    return [...before.map(line => `- ${line}`), ...after.map(line => `+ ${line}`)];
}

export function previewEditDiff(args: Record<string, unknown>): string | undefined {
    const edits = Array.isArray(args.edits)
        ? args.edits
        : [{ oldText: args.oldText ?? args.old_string, newText: args.newText ?? args.new_string }];
    const lines: string[] = [];
    let chars = 0;
    for (let i = 0; i < edits.length; i++) {
        const edit = edits[i] as Partial<Replacement> | null;
        if (!edit || typeof edit.oldText !== "string" || typeof edit.newText !== "string") continue;
        const changed = replacementDiff(edit as Replacement);
        if (!changed.length) continue;
        const chunk = edits.length > 1 ? [`@@ edit ${i + 1} @@`, ...changed] : changed;
        for (const line of chunk) {
            if (lines.length >= MAX_DIFF_LINES || chars + line.length > MAX_DIFF_CHARS) {
                lines.push("… diff preview truncated; use git diff for full changes");
                return lines.join("\n");
            }
            lines.push(line);
            chars += line.length;
        }
    }
    return lines.length ? lines.join("\n") : undefined;
}
