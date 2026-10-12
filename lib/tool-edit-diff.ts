/** Bounded, per-call diffs of edit replacements (not repository-wide diffs). */
const MAX_DIFF_CHARS = 8_000;
const MAX_DIFF_LINES = 100;
const MAX_FULL_DIFF_CHARS = 32_000;
const MAX_FULL_DIFF_LINES = 500;
const MAX_SOURCE_CHARS = 128_000;
export const DIFF_TRUNCATED_MARKER = "… diff preview truncated; remaining lines from this edit were not stored";
export const INLINE_TRUNCATED_MARKER = "… inline preview truncated; open /se for this edit";
export const FULL_DIFF_LIMIT_MARKER = "… per-edit safety limit reached; remaining lines were not stored";
export const LARGE_EDIT_MARKER = "… large edit: replacement preview without line alignment";
export const SOURCE_LIMIT_MARKER = "… edit exceeds safe source size; diff was not captured";

type Replacement = { oldText: string; newText: string };

function replacementDiff({ oldText, newText }: Replacement): string[] {
    if (oldText === newText) return [];
    if (oldText.length + newText.length > MAX_SOURCE_CHARS) return [SOURCE_LIMIT_MARKER];
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
    if (before.length > MAX_FULL_DIFF_LINES || after.length > MAX_FULL_DIFF_LINES) {
        return [LARGE_EDIT_MARKER,
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

function formatEditDiff(args: Record<string, unknown>, maxLines: number, maxChars: number, limitMarker: string): string | undefined {
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
            if (lines.length >= maxLines || chars + line.length > maxChars) {
                lines.push(limitMarker);
                return lines.join("\n");
            }
            lines.push(line);
            chars += line.length;
        }
    }
    return lines.length ? lines.join("\n") : undefined;
}

export function previewEditDiff(args: Record<string, unknown>): string | undefined {
    return formatEditDiff(args, MAX_DIFF_LINES, MAX_DIFF_CHARS, DIFF_TRUNCATED_MARKER);
}

/** A larger per-call diff, stored only in the final tool result for /se. */
export function fullEditDiff(args: Record<string, unknown>): string | undefined {
    return formatEditDiff(args, MAX_FULL_DIFF_LINES, MAX_FULL_DIFF_CHARS, FULL_DIFF_LIMIT_MARKER);
}
