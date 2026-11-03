import { describe, it, expect } from "vitest";
import { DeliveryCollector, REPORT_TOOL, parseDeclaration, deliveryText } from "../lib/delivery";

const declaration = () => ({ status: "complete" as const, summary: "Implemented", claimed_files: ["a.ts"], checks_not_run: ["API 26"], assumptions: [], blockers: [] });
const report = (c: DeliveryCollector) => {
	c.start("r", REPORT_TOOL, {});
	c.end("r", REPORT_TOOL, { details: { declaration: declaration() } }, false);
};
const shell = (c: DeliveryCollector, id: string, error: unknown, text = "PASS") => {
	c.start(id, "safe_bash", { command: "npm test" });
	c.end(id, "safe_bash", { content: [{ type: "text", text }] }, error);
};

describe("delivery declaration", () => {
	it("accepts only bounded structured declarations, not prose claims", () => {
		expect(parseDeclaration(declaration())?.status).toBe("complete");
		for (const bad of [null, "tests passed", {}, { ...declaration(), status: "verified" }, { ...declaration(), summary: " " }, { ...declaration(), blockers: ["x".repeat(2001)] }]) expect(parseDeclaration(bad)).toBeUndefined();
	});
	it("enforces total UTF-8 size, not just item counts", () => {
		expect(parseDeclaration({ ...declaration(), assumptions: Array(20).fill("é".repeat(1000)) })).toBeUndefined();
	});
});

describe("observed evidence", () => {
	it("never equates process success or agent claims with verified acceptance", () => {
		const c = new DeliveryCollector(); report(c);
		const d = c.finish("completed");
		expect(d.process).toBe("completed"); expect(d.declaration?.status).toBe("complete");
		expect(d.acceptance).toBe("not_verified"); expect(d.observed.commands).toEqual([]);
		expect(deliveryText(d)).toContain("NOT VERIFIED");
	});
	it("does not invent a report for legacy output", () => {
		const d = new DeliveryCollector().finish("completed");
		expect(d.declaration).toBeUndefined(); expect(deliveryText(d)).toContain("not_reported");
	});
	it("keeps failed commands despite reassuring stdout or a complete declaration", () => {
		const c = new DeliveryCollector(); shell(c, "b", true, "ALL TESTS PASSED"); report(c);
		expect(c.finish("completed").observed.commands[0].outcome).toBe("failed");
	});
	it("requires an explicit non-error event for tool success", () => {
		const c = new DeliveryCollector(); shell(c, "a", false); shell(c, "b", undefined); shell(c, "c", null);
		expect(c.finish("completed").observed.commands.map(x => x.outcome)).toEqual(["succeeded", "unknown", "unknown"]);
		expect(c.finish("completed").observed.incomplete).toBe(true);
	});
	it("records only successful direct edit/write paths, independently from claimed files", () => {
		const c = new DeliveryCollector();
		for (const [id, tool, fail] of [["e", "edit", false], ["w", "write", false], ["bad", "write", true]] as const) {
			c.start(id, tool, { path: `${id}.ts` }); c.end(id, tool, {}, fail);
		}
		report(c);
		expect(c.finish("completed").observed.fileWrites).toEqual(["e.ts", "w.ts"]);
		expect(c.finish("completed").declaration?.claimed_files).toEqual(["a.ts"]);
	});
	it("ignores unsolicited or mismatched completion events", () => {
		const c = new DeliveryCollector(); c.end("x", "write", {}, false);
		c.start("a", "read", { path: "a.ts" }); c.end("a", "write", {}, false);
		expect(c.finish("completed").observed.fileWrites).toEqual([]);
	});
	it("marks unfinished work on cancellation rather than inventing a success", () => {
		const c = new DeliveryCollector(); c.start("b", "bash", { command: "sleep 10" });
		const d = c.finish("cancelled");
		expect(d.process).toBe("cancelled"); expect(d.observed.incomplete).toBe(true);
		expect(d.observed.commands).toEqual([]);
	});
	it("invalidates a report when more work starts or a parallel command ends", () => {
		const c = new DeliveryCollector(); report(c);
		c.start("b", "bash", { command: "npm test" });
		expect(c.finish("completed").declaration).toBeUndefined();
		report(c); c.end("b", "bash", {}, false);
		expect(c.finish("completed").declaration).toBeUndefined();
	});
	it("retains earlier attempt evidence while invalidating its declaration", () => {
		const c = new DeliveryCollector(); shell(c, "b", true); report(c); c.retry();
		expect(c.finish("failed").declaration).toBeUndefined();
		expect(c.finish("failed").observed.commands).toHaveLength(1);
	});
	it("bounds memory and discloses omission/truncation", () => {
		const c = new DeliveryCollector();
		for (let i = 0; i < 70; i++) shell(c, String(i), false, "x".repeat(9000));
		const d = c.finish("completed");
		expect(d.observed.commands).toHaveLength(20); expect(d.observed.omitted).toBe(50);
		expect(d.observed.commands[0].truncated).toBe(true);
		expect(d.observed.incomplete).toBe(true); expect(JSON.stringify(d).length).toBeLessThan(50_000);
	});
	it("preserves tool-provided log paths and upstream truncation without inventing logs", () => {
		const c = new DeliveryCollector();
		c.start("a", "bash", { command: "npm test" });
		c.end("a", "bash", { content: [{ type: "text", text: "tail" }], details: { fullOutputPath: "/tmp/real-tool-log", truncation: { truncated: true } } }, false);
		shell(c, "b", false);
		const commands = c.finish("completed").observed.commands;
		expect(commands[0].fullOutputPath).toBe("/tmp/real-tool-log"); expect(commands[0].truncated).toBe(true);
		expect(commands[1].fullOutputPath).toBeUndefined();
	});
	it("rejects failed or malformed report tool results", () => {
		const c = new DeliveryCollector(); c.start("r", REPORT_TOOL, {});
		c.end("r", REPORT_TOOL, { details: { declaration: "all passed" } }, false);
		expect(c.finish("completed").declaration).toBeUndefined(); expect(c.finish("completed").observed.incomplete).toBe(true);
	});
});
