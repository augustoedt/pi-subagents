import { afterEach, describe, expect, it, vi } from "vitest";
import { createResourceClaims, ResourceAdmissionError, ResourceCoordinator, type ResourceClaims } from "../lib/resource-coordinator";
import type { WriteScopeEntry } from "../lib/write-scope";

const claims = (patch: Partial<ResourceClaims> = {}): ResourceClaims => ({ paths: [], names: [], writer: false, globalWriter: false, ...patch });
const pathClaim = (path: string, kind: WriteScopeEntry["kind"] = "file") => claims({ paths: [{ path, kind }], writer: true });
function deferred<T = void>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
	return { promise, resolve, reject };
}
const admission = (code: string) => expect.objectContaining({ name: "ResourceAdmissionError", code });

afterEach(() => vi.useRealTimers());

describe("resource coordinator", () => {
	it("infers scoped, global, and read-only claims and validates explicit names", () => {
		const scope = { version: 1 as const, roots: [{ path: "/Work/src", kind: "directory" as const }] };
		expect(createResourceClaims({ scope, agent: { tools: ["scoped_edit", "read"] } }).paths).toEqual(scope.roots);
		expect(createResourceClaims({ agent: { tools: ["edit"] } }).globalWriter).toBe(true);
		expect(createResourceClaims({ agent: { tools: ["read", "subagent_report"] } })).toMatchObject({ writer: false, paths: [] });
		expect(createResourceClaims({ agent: { tools: ["custom"] } }).globalWriter).toBe(true);
		expect(createResourceClaims({ agent: { tools: ["read"] } }, ["X", "x", "e\u0301"] as unknown)).toMatchObject({ names: ["x", "é"] });
		for (const invalid of [null, "a", Array(21).fill("x"), ["  "], ["x".repeat(129)], ["__private"]]) expect(() => createResourceClaims({ agent: { tools: [] } }, invalid)).toThrow();
	});
	it("runs independent work concurrently and serializes path, directory, name, and global conflicts", async () => {
		const coordinator = new ResourceCoordinator({ maxConcurrency: 4 });
		const gates = [deferred(), deferred(), deferred(), deferred()]; const started: number[] = [];
		const tasks = [
			coordinator.run(pathClaim("/a/file"), undefined, async () => { started.push(0); await gates[0].promise; }),
			coordinator.run(pathClaim("/b/file"), undefined, async () => { started.push(1); await gates[1].promise; }),
			coordinator.run(pathClaim("/a/tree", "directory"), undefined, async () => { started.push(2); await gates[2].promise; }),
			coordinator.run(claims({ names: ["shared"] }), undefined, async () => { started.push(3); await gates[3].promise; }),
		];
		await Promise.resolve(); expect(started).toEqual([0, 1, 2, 3]); gates.forEach(g => g.resolve()); await Promise.all(tasks);
		const gate = deferred(); let second = false;
		const first = coordinator.run(pathClaim("/x/tree", "directory"), undefined, () => gate.promise);
		const queued = coordinator.run(pathClaim("/x/tree/child"), undefined, async () => { second = true; });
		await Promise.resolve(); expect(second).toBe(false); gate.resolve(); await Promise.all([first, queued]); expect(second).toBe(true);
		const globalGate = deferred(); const global = coordinator.run(claims({ writer: true, globalWriter: true }), undefined, () => globalGate.promise);
		const read = coordinator.run(claims(), undefined, async () => "read"); const writer = coordinator.run(pathClaim("/z"), undefined, async () => "write");
		await expect(read).resolves.toBe("read"); await Promise.resolve(); expect(globalGate.promise).toBeDefined(); globalGate.resolve(); await Promise.all([global, writer]); coordinator.close();
	});
	it("allows unrelated work around earlier blocked waiters without conflicting overtakes", async () => {
		const c = new ResourceCoordinator({ maxConcurrency: 3 }); const hold = deferred();
		const running = c.run(pathClaim("/a"), undefined, () => hold.promise);
		const order: string[] = []; const blocked = c.run(pathClaim("/a"), undefined, async () => { order.push("blocked"); });
		const unrelated = c.run(pathClaim("/b"), undefined, async () => { order.push("unrelated"); });
		const conflicting = c.run(pathClaim("/a"), undefined, async () => { order.push("later"); });
		await Promise.resolve(); expect(order).toEqual(["unrelated"]); hold.resolve(); await Promise.all([running, blocked, unrelated, conflicting]); expect(order).toEqual(["unrelated", "blocked", "later"]);
		c.close();
	});
	it("enforces capacity, queued cancellation, pre-abort, deadlines, and bounded queue", async () => {
		for (const options of [
			{ maxConcurrency: Number.MAX_SAFE_INTEGER + 1 },
			{ maxConcurrency: 1, maxQueueDepth: Number.MAX_SAFE_INTEGER + 1 },
			{ maxConcurrency: 1, queueTimeoutMs: Number.MAX_SAFE_INTEGER + 1 },
		]) expect(() => new ResourceCoordinator(options)).toThrow();
		vi.useFakeTimers(); const c = new ResourceCoordinator({ maxConcurrency: 1, maxQueueDepth: 1, queueTimeoutMs: 50 }); const gate = deferred();
		const running = c.run(claims(), undefined, () => gate.promise); const controller = new AbortController();
		const cancelled = c.run(claims({ names: ["x"] }), controller.signal, async () => { throw new Error("spawned"); });
		const full = c.run(claims({ names: ["y"] }), undefined, async () => {});
		await expect(full).rejects.toMatchObject(admission("queue_full")); controller.abort(); await expect(cancelled).rejects.toMatchObject(admission("queue_cancelled"));
		const pre = new AbortController(); pre.abort(); await expect(c.run(claims(), pre.signal, async () => {})).rejects.toMatchObject(admission("queue_cancelled"));
		const timeout = c.run(claims({ names: ["t"] }), undefined, async () => {}); const timedOut = expect(timeout).rejects.toMatchObject(admission("queue_timeout")); await vi.advanceTimersByTimeAsync(50); await timedOut;
		gate.resolve(); await running; c.close();
	});
	it("close rejects queued and future work but leaves running work held; errors release", async () => {
		const c = new ResourceCoordinator({ maxConcurrency: 1 }); const gate = deferred();
		const running = c.run(claims(), undefined, () => gate.promise); const queued = c.run(claims({ names: ["q"] }), undefined, async () => {});
		c.close("done"); await expect(queued).rejects.toMatchObject(admission("coordinator_closed"));
		await expect(c.run(claims(), undefined, async () => {})).rejects.toMatchObject(admission("coordinator_closed"));
		gate.resolve(); await running;
		const open = new ResourceCoordinator({ maxConcurrency: 1 }); await expect(open.run(claims(), undefined, async () => { throw new Error("failure"); })).rejects.toThrow("failure");
		await expect(open.run(claims(), undefined, async () => "released")).resolves.toBe("released"); open.close();
	});
	it("admits ready independent work when the wait queue is full", async () => {
		const c = new ResourceCoordinator({ maxConcurrency: 2, maxQueueDepth: 1 }); const hold = deferred();
		const running = c.run(pathClaim("/a"), undefined, () => hold.promise);
		const blocked = c.run(pathClaim("/a"), undefined, async () => {});
		let independentStarted = false;
		const independent = c.run(pathClaim("/b"), undefined, async () => { independentStarted = true; });
		await independent; expect(independentStarted).toBe(true);
		hold.resolve(); await Promise.all([running, blocked]); c.close();
	});
	it("copies claims and does not release active reservations on abort", async () => {
		const c = new ResourceCoordinator({ maxConcurrency: 2 }); const gate = deferred(); const controller = new AbortController();
		const mutable = pathClaim("/original");
		const running = c.run(mutable, controller.signal, () => gate.promise);
		mutable.paths[0].path = "/mutated";
		controller.abort(); let secondStarted = false; const order: string[] = [];
		const queuedClaim = pathClaim("/original");
		const firstQueued = c.run(queuedClaim, undefined, async () => { order.push("first"); });
		queuedClaim.paths[0].path = "/mutated-again";
		const conflicting = c.run(pathClaim("/original"), undefined, async () => { secondStarted = true; order.push("second"); });
		await Promise.resolve(); expect(secondStarted).toBe(false);
		gate.resolve(); await Promise.all([running, firstQueued, conflicting]);
		expect(secondStarted).toBe(true); expect(order).toEqual(["first", "second"]); c.close();
	});
	it("cleans queue when waiting notification throws and handles reentrant enqueue", async () => {
		const c = new ResourceCoordinator({ maxConcurrency: 1 }); const gate = deferred(); const first = c.run(claims(), undefined, () => gate.promise);
		let reason = "";
		await expect(c.run(claims({ names: ["bad"] }), undefined, async () => {}, value => { reason = value; throw new Error("notification"); })).rejects.toThrow("notification");
		expect(reason).toBe("capacity");
		const conflictCoordinator = new ResourceCoordinator({ maxConcurrency: 2 }); const conflictGate = deferred();
		const conflictRunning = conflictCoordinator.run(pathClaim("/same"), undefined, () => conflictGate.promise);
		let conflictReason = "";
		const conflictWait = conflictCoordinator.run(pathClaim("/same"), undefined, async () => {}, value => { conflictReason = value; });
		expect(conflictReason).toBe("resource_conflict"); conflictGate.resolve(); await Promise.all([conflictRunning, conflictWait]); conflictCoordinator.close();
		let nested!: Promise<string>;
		const queued = c.run(claims({ names: ["outer"] }), undefined, async () => "outer", () => { nested = c.run(claims({ names: ["inner"] }), undefined, async () => "inner"); });
		gate.resolve(); await first; await expect(queued).resolves.toBe("outer"); await expect(nested).resolves.toBe("inner"); c.close();
	});
});
