/** Normalize protected mutation tool names to their legacy equivalents. */
export function normalizeMutationTool(name: string): string {
    switch (name) {
        case "scoped_edit": return "edit";
        case "scoped_write": return "write";
        default: return name;
    }
}
