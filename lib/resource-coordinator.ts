import type { WriteScope, WriteScopeEntry } from "./write-scope";

export interface ResourceClaims {
	paths: WriteScopeEntry[];
	names: string[];
	writer: boolean;
	globalWriter: boolean;
}

type AdmissionCode = "queue_cancelled" | "queue_timeout" | "queue_full" | "coordinator_closed";
export class ResourceAdmissionError extends Error {
	readonly code: AdmissionCode;
	constructor(code: AdmissionCode, message: string = code) { super(message); this.name = "ResourceAdmissionError"; this.code = code; }
}

const mutators = new Set(["edit", "write", "scoped_edit", "scoped_write"]);
const readonlyTools = new Set(["read", "grep", "find", "ls", "subagent_report"]);
const globalTools = new Set(["bash", "powershell", "safe_bash", "subagent"]);

export function createResourceClaims(plan: { scope?: WriteScope; agent: { tools: string[] } }, resources?: unknown): ResourceClaims {
	let names: string[] = [];
	if (resources !== undefined) {
		if (!Array.isArray(resources) || resources.length > 20) throw new Error("resources must be an array of at most 20 names");
		for (const name of resources) {
			if (typeof name !== "string" || !name.trim() || name.length > 128) throw new Error("resource names must be nonblank strings of at most 128 characters");
			if (name.startsWith("__")) throw new Error("resource names beginning with '__' are reserved");
			names.push(name.normalize("NFC").toLowerCase());
		}
		names = [...new Set(names)];
	}
	const tools = plan.agent.tools;
	const hasMutator = tools.some(tool => mutators.has(tool));
	const paths = hasMutator && plan.scope ? plan.scope.roots.map(root => ({ ...root })) : [];
	const writer = hasMutator || tools.some(tool => globalTools.has(tool) || (!readonlyTools.has(tool) && !mutators.has(tool)));
	return { paths, names, writer, globalWriter: writer && hasMutator && paths.length === 0 || writer && tools.some(tool => globalTools.has(tool) || (!readonlyTools.has(tool) && !mutators.has(tool))) };
}

// Case-folding and NFC prevent collisions on case-insensitive filesystems, at the cost of conservative false conflicts on case-sensitive ones.
function pathKey(value: string): string { return value.normalize("NFC").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase(); }
function within(child: string, parent: string): boolean { return child === parent || child.startsWith(parent.endsWith("/") ? parent : `${parent}/`); }
function pathsConflict(a: WriteScopeEntry, b: WriteScopeEntry): boolean {
	const ap = pathKey(a.path), bp = pathKey(b.path);
	if (a.kind === "file" && b.kind === "file") return ap === bp;
	if (a.kind === "directory" && b.kind === "directory") return within(ap, bp) || within(bp, ap);
	return a.kind === "directory" ? within(bp, ap) : within(ap, bp);
}
function conflicts(a: ResourceClaims, b: ResourceClaims): boolean {
	if (a.names.some(name => b.names.includes(name))) return true;
	if (a.writer && b.writer && (a.globalWriter || b.globalWriter)) return true;
	return a.writer && b.writer && a.paths.some(x => b.paths.some(y => pathsConflict(x, y)));
}

interface Waiter<T> {
	claims: ResourceClaims; signal?: AbortSignal; fn: (waitMs: number) => Promise<T>; onWaiting?: (reason: string) => void;
	resolve(value: T): void; reject(error: unknown): void; queuedAt: number; timer?: ReturnType<typeof setTimeout>;
	abort?: () => void; done: boolean;
}

export class ResourceCoordinator {
	private readonly maxConcurrency: number;
	private readonly maxQueueDepth: number;
	private readonly queueTimeoutMs: number;
	private active: ResourceClaims[] = [];
	private queue: Waiter<unknown>[] = [];
	private closed?: string;
	constructor(options: { maxConcurrency: number; maxQueueDepth?: number; queueTimeoutMs?: number }) {
		if (!Number.isSafeInteger(options.maxConcurrency) || options.maxConcurrency < 1) throw new Error("maxConcurrency must be a positive safe integer");
		this.maxConcurrency = options.maxConcurrency;
		this.maxQueueDepth = options.maxQueueDepth ?? 64;
		this.queueTimeoutMs = options.queueTimeoutMs ?? 0;
		if (!Number.isSafeInteger(this.maxQueueDepth) || this.maxQueueDepth < 0) throw new Error("maxQueueDepth must be a nonnegative safe integer");
		if (!Number.isSafeInteger(this.queueTimeoutMs) || this.queueTimeoutMs < 0) throw new Error("queueTimeoutMs must be a nonnegative safe integer");
	}
	run<T>(claims: ResourceClaims, signal: AbortSignal | undefined, fn: (waitMs: number) => Promise<T>, onWaiting?: (reason: string) => void): Promise<T> {
		const reservation: ResourceClaims = { paths: claims.paths.map(path => ({ ...path })), names: [...claims.names], writer: claims.writer, globalWriter: claims.globalWriter };
		if (this.closed) return Promise.reject(new ResourceAdmissionError("coordinator_closed", this.closed));
		if (signal?.aborted) return Promise.reject(new ResourceAdmissionError("queue_cancelled"));
		if (this.canStart(reservation) && !this.queue.some(waiter => !waiter.done && conflicts(waiter.claims, reservation))) return this.start(reservation, fn, 0);
		if (this.queue.length >= this.maxQueueDepth) return Promise.reject(new ResourceAdmissionError("queue_full"));
		return new Promise<T>((resolve, reject) => {
			const waiter: Waiter<T> = { claims: reservation, signal, fn, onWaiting, resolve, reject, queuedAt: Date.now(), done: false };
			this.queue.push(waiter as Waiter<unknown>);
			const fail = (code: AdmissionCode) => { if (waiter.done) return; waiter.done = true; this.cleanup(waiter); this.queue = this.queue.filter(item => item !== waiter); reject(new ResourceAdmissionError(code)); this.drain(); };
			if (signal) { waiter.abort = () => fail("queue_cancelled"); signal.addEventListener("abort", waiter.abort, { once: true }); }
			if (this.queueTimeoutMs > 0) waiter.timer = setTimeout(() => fail("queue_timeout"), this.queueTimeoutMs);
			try { onWaiting?.(this.active.length >= this.maxConcurrency ? "capacity" : "resource_conflict"); } catch (error) { waiter.done = true; this.cleanup(waiter); this.queue = this.queue.filter(item => item !== waiter); reject(error); this.drain(); }
			this.drain();
		});
	}
	close(reason = "Resource coordinator is closed"): void {
		if (this.closed) return;
		this.closed = reason;
		for (const waiter of this.queue.splice(0)) { waiter.done = true; this.cleanup(waiter); waiter.reject(new ResourceAdmissionError("coordinator_closed", reason)); }
	}
	private cleanup(waiter: Waiter<unknown>): void { if (waiter.timer) clearTimeout(waiter.timer); if (waiter.abort) waiter.signal?.removeEventListener("abort", waiter.abort); }
	private canStart(claims: ResourceClaims): boolean { return this.active.length < this.maxConcurrency && !this.active.some(active => conflicts(active, claims)); }
	private start<T>(claims: ResourceClaims, fn: (waitMs: number) => Promise<T>, waitMs: number): Promise<T> {
		this.active.push(claims); let released = false;
		const release = () => { if (released) return; released = true; const index = this.active.indexOf(claims); if (index >= 0) this.active.splice(index, 1); this.drain(); };
		return Promise.resolve().then(() => fn(waitMs)).finally(release);
	}
	private drain(): void {
		let progressed = true;
		while (progressed && this.active.length < this.maxConcurrency) {
			progressed = false;
			for (let i = 0; i < this.queue.length; i++) {
				const waiter = this.queue[i];
				if (waiter.done || !this.canStart(waiter.claims)) continue;
				if (this.queue.slice(0, i).some(earlier => !earlier.done && conflicts(earlier.claims, waiter.claims))) continue;
				this.queue.splice(i, 1); waiter.done = true; this.cleanup(waiter);
				this.start(waiter.claims, waiter.fn, Date.now() - waiter.queuedAt).then(waiter.resolve, waiter.reject);
				progressed = true; break;
			}
		}
	}
}
