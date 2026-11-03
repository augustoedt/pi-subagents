import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { REPORT_TOOL, parseDeclaration } from "../lib/delivery";

/** Loaded only in child processes. Records declarations, never verifies them. */
export default function (pi: ExtensionAPI) {
	const list = () => Type.Array(Type.String({ minLength: 1, maxLength: 2000 }), { maxItems: 20 });
	pi.registerTool({
		name: REPORT_TOOL,
		label: "Delivery declaration",
		description: "Record your delivery before your final answer. This is your declaration, not evidence that acceptance or tests passed. Do not use it to execute checks. Keep the report under 16 KB of JSON.",
		parameters: Type.Object({
			status: Type.String({ enum: ["complete", "partial", "blocked"] }),
			summary: Type.String({ minLength: 1, maxLength: 4000 }),
			claimed_files: list(),
			checks_not_run: list(),
			assumptions: list(),
			blockers: list(),
		}),
		async execute(_id, params) {
			const declaration = parseDeclaration(params);
			if (!declaration) throw new Error("Invalid delivery declaration: use nonblank bounded strings and at most 16 KB of JSON");
			return {
				content: [{ type: "text", text: "Delivery declaration recorded (not independently verified). Give your final answer; judges must keep YES or NO first." }],
				details: { declaration },
			};
		},
	});
}
