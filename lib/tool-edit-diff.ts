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
    // Bound the alignment work; large edits are still shown as replacements.
    if (before.length > 200 || after.length > 200) {
        return ["… large edit: replacement preview (use git diff for exact alignment)",
            ...before.map(line => `- ${line}`), ...after.map(line => `+ ${line}`)];
    }
    const lengths = Array.from({ length: before.length + 1 }, () => new Uint16Array(after.length + 1));
    for (let i = before.length - 1; i >= 0; i--) {
        for (let j = after.length - 1; j >= 0; j--) {
            lengths[i]![j] = before[i] === after[j]
                ? 1 + lengths[i + 1]![j + 1]!
                : Math.max(lengths[i + 1]![j]!, lengths[i]![j + 1]!);
        }
    }
    const lines: string[] = [];
    let i = 0, j = 0;
    while (i < before.length || j < after.length) {
        if (i < before.length && j < after.length && before[i] === after[j]) {
            lines.push(`  ${before[i++]}`);
            j++;
        } else if (i < before.length && (j === after.length || lengths[i + 1]![j]! >= lengths[i]![j + 1]!)) {
            lines.push(`- ${before[i++]}`);
        } else {
            lines.push(`+ ${after[j++]}`);
        }
    }
    return lines;
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
