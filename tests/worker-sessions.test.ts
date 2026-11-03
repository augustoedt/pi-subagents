import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { WorkerSessions, type WorkerPolicy } from "../lib/worker-sessions";
import type { WriteScope } from "../lib/write-scope";

let temp: string;
const scope: WriteScope = { version: 1, roots: [{ path: "/workspace/src", kind: "directory" }] };
const policy = (extra: Partial<WorkerPolicy> = {}): WorkerPolicy => ({ owner: "owner", agent: "worker", fingerprint: "fp", model: "test/model", thinking: "low", cwd: "/workspace", scope, ...extra });
const makeStore = (options: { maxWorkers?: number; maxTurns?: number; maxBytes?: number } = {}) => new WorkerSessions({
	headerFactory: (cwd, id) => ({ type: "session", version: 3, id, cwd, timestamp: new Date().toISOString() }), baseDir: temp, ...options,
});
const message = (file: string, text = "prior") => {
	const previous = JSON.parse(fs.readFileSync(file, "utf8").trim().split("\n").at(-1)!);
	fs.appendFileSync(file, JSON.stringify({ type: "message", id: randomUUID(), parentId: previous.type === "session" ? null : previous.id,
		timestamp: new Date().toISOString(), message: { role: "user", content: text } }) + "\n");
};
afterEach(() => { if (temp) fs.rmSync(temp, { recursive: true, force: true }); });

describe("private worker sessions", () => {
	it("creates private files, starts once, and resumes validated history", () => {
		temp = fs.mkdtempSync(path.join(os.tmpdir(), "worker-tests-")); const store = makeStore();
		const first = store.create(policy()); expect(fs.statSync(first.directory).mode & 0o777).toBe(0o700); expect(fs.statSync(first.file).mode & 0o777).toBe(0o600);
		expect(first.start()).toBe(1); message(first.file); const done = first.finish("completed"); expect(done.resumable).toBe(true);
		const next = store.resume(first.id, policy({ scope: { version: 1, roots: [] } })); expect(next.start()).toBe(2); message(next.file, "next");
		expect(next.finish("completed")).toMatchObject({ turn: 2, previousTurns: [{ turn: 1, status: "completed" }], omittedTurns: 0 });
		store.dispose();
	});
	it("returns defensive policies, enforces ownership, policy equality, and permanent narrowing", () => {
		temp = fs.mkdtempSync(path.join(os.tmpdir(), "worker-tests-")); const store = makeStore(); const lease = store.create(policy());
		const got = store.getPolicy(lease.id, "owner"); got.scope.roots.length = 0; expect(store.getPolicy(lease.id, "owner").scope.roots).toHaveLength(1);
		expect(() => store.getPolicy(lease.id, "other")).toThrow(/unknown/);
		expect(() => store.resume(lease.id, policy({ model: "elsewhere" }))).toThrow(/busy/);
		lease.cancelBeforeStart();
		const completed = store.create(policy());
		completed.start(); message(completed.file); completed.finish("completed");
		expect(() => store.resume(completed.id, policy({ model: "elsewhere" }))).toThrow(/mismatch/);
		expect(() => store.resume(completed.id, policy({ scope: { version: 1, roots: [{ path: "/workspace", kind: "directory" }] } }))).toThrow(/widen/);
		expect(() => store.getPolicy(lease.id, "owner")).toThrow(/unknown/); store.dispose();
	});
	it("enforces unknown/busy IDs, queue cancellation, status history and turn caps", () => {
		temp = fs.mkdtempSync(path.join(os.tmpdir(), "worker-tests-")); const store = makeStore({ maxTurns: 2 });
		expect(() => store.resume("foreign", policy())).toThrow(/unknown/);
		const a = store.create(policy()); expect(() => store.resume(a.id, policy())).toThrow(/busy/); expect(a.start()).toBe(1); message(a.file); a.finish("failed");
		const queued = store.resume(a.id, policy()); queued.cancelBeforeStart();
		const b = store.resume(a.id, policy()); expect(b.start()).toBe(2); message(b.file); expect(b.finish("cancelled").previousTurns).toEqual([{ turn: 1, status: "failed" }]);
		const capped = store.resume(a.id, policy()); expect(() => capped.start()).toThrow(/turn_limit/); capped.cancelBeforeStart(); store.dispose();
	});
	it("enforces worker limits and removes idle and deferred busy artifacts on dispose", () => {
		temp = fs.mkdtempSync(path.join(os.tmpdir(), "worker-tests-")); const store = makeStore({ maxWorkers: 1 });
		const a = store.create(policy()); expect(() => store.create(policy())).toThrow(/worker_limit/); a.start();
		store.dispose(); expect(fs.existsSync(a.directory)).toBe(true); expect(() => store.create(policy())).toThrow(/disposed/);
		expect(() => a.start()).toThrow(/inactive/);
		message(a.file);
		expect(a.finish("cancelled").resumable).toBe(false);
		expect(fs.existsSync(a.directory)).toBe(false);
		expect(() => a.cancelBeforeStart()).toThrow(/inactive/);
	});
	it("fails closed for missing, malformed, oversized, symlinked, and hardlinked transcripts", () => {
		temp = fs.mkdtempSync(path.join(os.tmpdir(), "worker-tests-")); const store = makeStore({ maxBytes: 500 });
		const corrupt = store.create(policy()); corrupt.start(); message(corrupt.file); corrupt.finish("completed");
		fs.appendFileSync(corrupt.file, "{broken}\n"); expect(() => store.resume(corrupt.id, policy())).toThrow(/transcript/);
		const missing = store.create(policy()); missing.start(); message(missing.file); missing.finish("failed"); fs.unlinkSync(missing.file); expect(() => store.resume(missing.id, policy())).toThrow();
		const oversized = store.create(policy()); oversized.start(); fs.appendFileSync(oversized.file, "x".repeat(600)); expect(oversized.finish("failed").resumable).toBe(false);
		const linked = store.create(policy()); linked.start(); message(linked.file); linked.finish("completed"); fs.linkSync(linked.file, path.join(temp, "hardlink")); expect(() => store.resume(linked.id, policy())).toThrow(/transcript/);
		const symbolic = store.create(policy()); symbolic.start(); message(symbolic.file); symbolic.finish("completed"); const moved = symbolic.file + ".real"; fs.renameSync(symbolic.file, moved); fs.symlinkSync(moved, symbolic.file); expect(() => store.resume(symbolic.id, policy())).toThrow();
		store.dispose();
	});
	it("canonicalizes symlinked base directories before creating private roots", () => {
		temp = fs.mkdtempSync(path.join(os.tmpdir(), "worker-tests-"));
		const target = path.join(temp, "canonical");
		const alias = path.join(temp, "alias");
		fs.mkdirSync(target);
		fs.symlinkSync(target, alias);
		const store = new WorkerSessions({
			headerFactory: (cwd, id) => ({ type: "session", version: 3, id, cwd }),
			baseDir: alias,
		});
		const lease = store.create(policy());
		expect(path.dirname(path.dirname(lease.directory))).toBe(fs.realpathSync(target));
		lease.cancelBeforeStart();
	});
	it("rejects incomplete message histories and cleans an empty private root", () => {
		temp = fs.mkdtempSync(path.join(os.tmpdir(), "worker-tests-"));
		const store = makeStore();
		const lease = store.create(policy());
		lease.start();
		fs.appendFileSync(lease.file, JSON.stringify({ type: "message" }) + "\n");
		expect(lease.finish("failed").resumable).toBe(false);
		expect(() => store.resume(lease.id, policy())).toThrow(/transcript/);
		store.dispose();
		expect(fs.existsSync(lease.directory)).toBe(false);
		expect(fs.readdirSync(temp)).toHaveLength(0);
	});
	it("does not clean an outside child when the private root is replaced by a symlink", () => {
		temp = fs.mkdtempSync(path.join(os.tmpdir(), "worker-tests-"));
		const store = makeStore();
		const lease = store.create(policy());
		const root = path.dirname(lease.directory);
		const movedRoot = root + "-moved";
		const outside = path.join(temp, "outside");
		fs.renameSync(root, movedRoot);
		fs.mkdirSync(outside);
		const outsideChild = path.join(outside, lease.id);
		fs.mkdirSync(outsideChild);
		const sentinel = path.join(outsideChild, "sentinel");
		fs.writeFileSync(sentinel, "keep");
		fs.symlinkSync(outside, root);
		store.dispose();
		expect(fs.readFileSync(sentinel, "utf8")).toBe("keep");
	});
	it("rejects broken entry trees and unexpected persisted model selection", () => {
		temp = fs.mkdtempSync(path.join(os.tmpdir(), "worker-tests-"));
		const store = makeStore();
		for (const extra of [{ type: "message", message: { role: "user", content: "missing entry identity" } },
			{ type: "model_change", id: "id", parentId: null, timestamp: new Date().toISOString(), provider: "wrong", modelId: "model" },
			{ type: "message", id: "id", parentId: "missing-parent", timestamp: new Date().toISOString(), message: { role: "user", content: "broken tree" } }]) {
			const lease = store.create(policy()); lease.start(); message(lease.file);
			fs.appendFileSync(lease.file, JSON.stringify(extra) + "\n");
			expect(lease.finish("failed").resumable).toBe(false);
			expect(() => store.resume(lease.id, policy())).toThrow(/transcript/);
		}
		store.dispose();
	});
	it("uses UUID identities and owner disposal removes only matching workers", () => {
		temp = fs.mkdtempSync(path.join(os.tmpdir(), "worker-tests-")); const store = makeStore();
		const a = store.create(policy()), b = store.create(policy({ owner: "other" })); expect(a.id).not.toBe(b.id); store.disposeOwner("owner");
		expect(fs.existsSync(a.directory)).toBe(true);
		expect(() => store.getPolicy(a.id, "owner")).toThrow(/unknown/);
		expect(() => a.start()).toThrow(/inactive/);
		a.cancelBeforeStart();
		expect(fs.existsSync(a.directory)).toBe(false); expect(fs.existsSync(b.directory)).toBe(true); store.dispose();
	});
});
