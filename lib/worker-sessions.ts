import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { WriteScope, WriteScopeEntry } from "./write-scope";

export interface WorkerPolicy {
	owner: string; agent: string; fingerprint: string; model: string; thinking: string; cwd: string; scope: WriteScope;
}
export interface WorkerSessionInfo {
	id: string; turn: number; status: "completed" | "failed" | "cancelled"; resumable: boolean;
	previousTurns: Array<{ turn: number; status: string }>; omittedTurns: number;
}
export interface WorkerLease { id: string; file: string; directory: string; start(): number; finish(status: "completed" | "failed" | "cancelled"): WorkerSessionInfo; cancelBeforeStart(): void }
interface Turn { turn: number; status: string }
interface Entry { policy: WorkerPolicy; dir: string; file: string; turns: Turn[]; busy: boolean; active: boolean; removeOnFinish: boolean; started: number }
interface Options { headerFactory: (cwd: string, id: string) => Record<string, unknown>; baseDir?: string; maxWorkers?: number; maxTurns?: number; maxBytes?: number }

const cloneScope = (scope: WriteScope): WriteScope => ({ version: 1, roots: scope.roots.map(r => ({ path: r.path, kind: r.kind })) });
const clonePolicy = (p: WorkerPolicy): WorkerPolicy => ({ ...p, scope: cloneScope(p.scope) });
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
function validatePolicy(p: WorkerPolicy): void {
	if (!isRecord(p) || [p.owner,p.agent,p.fingerprint,p.model,p.thinking,p.cwd].some(v => typeof v !== "string" || !v) ||
		!isRecord(p.scope) || p.scope.version !== 1 || !Array.isArray(p.scope.roots)) throw new Error("Invalid worker policy");
	for (const r of p.scope.roots) if (!isRecord(r) || typeof r.path !== "string" || !path.isAbsolute(r.path) || (r.kind !== "file" && r.kind !== "directory")) throw new Error("Invalid worker scope");
}
function within(parent: WriteScopeEntry, child: WriteScopeEntry): boolean {
	if (parent.kind === "file") return child.kind === "file" && parent.path === child.path;
	const rel = path.relative(parent.path, child.path);
	return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
}

export class WorkerSessions {
	private root?: string;
	private entries = new Map<string, Entry>();
	private disposed = false;
	private readonly maxWorkers: number; private readonly maxTurns: number; private readonly maxBytes: number;
	constructor(private readonly options: Options) {
		this.maxWorkers = options.maxWorkers ?? 16; this.maxTurns = options.maxTurns ?? 20; this.maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
		if (!Number.isInteger(this.maxWorkers) || this.maxWorkers < 1 || !Number.isInteger(this.maxTurns) || this.maxTurns < 1 || !Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1) throw new Error("Invalid worker session limits");
	}
	private ensureRoot(): string {
		if (!this.root) {
			const base = this.options.baseDir ?? os.tmpdir();
			fs.mkdirSync(base, { recursive: true });
			const canonicalBase = fs.realpathSync(base);
			const made = fs.mkdtempSync(path.join(canonicalBase, "pi-worker-sessions-"));
			this.root = fs.realpathSync(made);
			fs.chmodSync(this.root, 0o700);
		}
		this.validateRoot();
		return this.root;
	}
	private validateRoot(): void {
		if (!this.root) throw new Error("invalid_worker_path");
		try {
			const st = fs.lstatSync(this.root);
			if (!st.isDirectory() || st.isSymbolicLink() || fs.realpathSync(this.root) !== this.root) throw new Error();
		} catch {
			throw new Error("invalid_worker_path");
		}
	}
	private ensureLive(): void { if (this.disposed) throw new Error("worker_sessions_disposed"); }
	getPolicy(id: string, owner: string): WorkerPolicy {
		const e = this.entries.get(id);
		if (!e || e.policy.owner !== owner || e.removeOnFinish || this.disposed) throw new Error("unknown_worker");
		return clonePolicy(e.policy);
	}
	create(policy: WorkerPolicy): WorkerLease {
		this.ensureLive(); validatePolicy(policy);
		if (this.entries.size >= this.maxWorkers) throw new Error("worker_limit");
		const id = randomUUID(), root = this.ensureRoot(), dir = path.join(root, id);
		this.validateRoot();
		fs.mkdirSync(dir, { mode: 0o700 });
		fs.chmodSync(dir, 0o700);
		const file = path.join(dir, "session.jsonl");
		try {
			const header = this.options.headerFactory(policy.cwd, id);
			if (!isRecord(header) || header.type !== "session" || header.version !== 3 || header.id !== id || header.cwd !== policy.cwd) throw new Error("Invalid worker session header");
			fs.writeFileSync(file, JSON.stringify(header) + "\n", { flag: "wx", mode: 0o600 });
			fs.chmodSync(file, 0o600);
		} catch (error) {
			this.removeDirectorySafely(dir);
			this.removeRootIfEmpty();
			throw error;
		}
		const entry: Entry = { policy: clonePolicy(policy), dir, file, turns: [], busy: false, active: false, removeOnFinish: false, started: 0 };
		this.entries.set(id, entry); return this.lease(id, entry, true);
	}
	resume(id: string, policy: WorkerPolicy): WorkerLease {
		this.ensureLive(); validatePolicy(policy);
		const e = this.entries.get(id); if (!e || e.policy.owner !== policy.owner) throw new Error("unknown_worker");
		if (e.busy) throw new Error("worker_busy");
		const old = e.policy;
		if (["owner", "agent", "fingerprint", "model", "thinking", "cwd"].some(k => old[k as keyof WorkerPolicy] !== policy[k as keyof WorkerPolicy])) throw new Error("worker_policy_mismatch");
		if (policy.scope.roots.some(child => !old.scope.roots.some(parent => within(parent, child)))) throw new Error("worker_scope_widening");
		this.validateTranscript(e, true);
		e.busy = true; e.active = false; e.started = 0;
		return this.lease(id, e, false, cloneScope(policy.scope));
	}
	private validateTranscript(e: Entry, requireMessage: boolean): void {
		const root = this.root!;
		this.validateRoot();
		if (path.dirname(e.dir) !== root) throw new Error("invalid_worker_path");
		const dirStat = fs.lstatSync(e.dir);
		if (!dirStat.isDirectory() || dirStat.isSymbolicLink() || fs.realpathSync(e.dir) !== e.dir) throw new Error("invalid_worker_path");
		const st = fs.lstatSync(e.file);
		if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.size > this.maxBytes) throw new Error("invalid_worker_transcript");
		const data = fs.readFileSync(e.file, "utf8");
		if (!data.endsWith("\n")) throw new Error("invalid_worker_transcript");
		const lines = data.slice(0, -1).split("\n");
		let header: unknown;
		let messages = 0;
		const ids = new Set<string>();
		try {
			header = JSON.parse(lines[0]);
			for (let i = 1; i < lines.length; i++) {
				const row: unknown = JSON.parse(lines[i]);
				if (!isRecord(row) || typeof row.type !== "string" || !row.type || row.type === "session" ||
					typeof row.id !== "string" || !row.id || ids.has(row.id) ||
					(row.parentId !== null && (typeof row.parentId !== "string" || !ids.has(row.parentId))) ||
					typeof row.timestamp !== "string" || !Number.isFinite(Date.parse(row.timestamp))) throw new Error();
				ids.add(row.id);
				if (row.type === "model_change" && `${row.provider}/${row.modelId}` !== e.policy.model) throw new Error();
				if (row.type === "message") {
					if (!isRecord(row.message) || typeof row.message.role !== "string" || !row.message.role || !("content" in row.message)) throw new Error();
					if (row.message.role === "assistant" && `${row.message.provider}/${row.message.model}` !== e.policy.model) throw new Error();
					if (row.message.role === "user" || row.message.role === "assistant") messages++;
				}
			}
		} catch { throw new Error("invalid_worker_transcript"); }
		if (!isRecord(header) || header.type !== "session" || header.version !== 3 || header.id !== path.basename(e.dir) || header.cwd !== e.policy.cwd || (requireMessage && messages === 0)) throw new Error("invalid_worker_transcript");
	}
	private lease(id: string, e: Entry, fresh: boolean, nextScope?: WriteScope): WorkerLease {
		e.busy = true;
		let settled = false;
		return {
			id, file: e.file, directory: e.dir,
			start: () => {
				if (settled || !e.busy || e.active || e.removeOnFinish || this.disposed) throw new Error("worker_lease_inactive");
				if (e.turns.length >= this.maxTurns) throw new Error("worker_turn_limit");
				this.validateTranscript(e, !fresh);
				if (nextScope) e.policy.scope = cloneScope(nextScope);
				e.active = true;
				e.started++;
				return e.turns.length + 1;
			},
			finish: status => {
				if (settled || !e.busy || !e.active) throw new Error("worker_lease_inactive");
				settled = true;
				const turn = e.turns.length + 1;
				let resumable = false;
				try { this.validateTranscript(e, true); resumable = !e.removeOnFinish && !this.disposed && e.turns.length + 1 < this.maxTurns; }
				catch { /* Preserve child evidence; invalid histories fail closed. */ }
				e.turns.push({ turn, status });
				e.busy = false;
				e.active = false;
				if (e.removeOnFinish) this.remove(id, e);
				return { id, turn, status, resumable, previousTurns: e.turns.slice(0, -1).slice(-10).map(t => ({ ...t })), omittedTurns: Math.max(0, e.turns.length - 11) };
			},
			cancelBeforeStart: () => {
				if (settled || e.active || !e.busy) throw new Error("worker_lease_inactive");
				settled = true;
				e.busy = false;
				if (fresh || e.removeOnFinish) this.remove(id, e);
			},
		};
	}
	private removeDirectorySafely(dir: string): boolean {
		try {
			this.validateRoot();
			if (!this.root || path.dirname(dir) !== this.root) return false;
			const st = fs.lstatSync(dir);
			if (!st.isDirectory() || st.isSymbolicLink() || fs.realpathSync(dir) !== dir) return false;
			fs.rmSync(dir, { recursive: true, force: true });
			return true;
		} catch { return false; }
	}
	private remove(id: string, e: Entry): void {
		this.entries.delete(id);
		this.removeDirectorySafely(e.dir);
		this.removeRootIfEmpty();
	}
	private removeRootIfEmpty(): void {
		if (!this.root || this.entries.size !== 0) return;
		try {
			this.validateRoot();
			if (fs.readdirSync(this.root).length === 0) {
				fs.rmdirSync(this.root);
				this.root = undefined;
			}
		} catch { /* Cleanup must not mask worker result or follow replaced paths. */ }
	}
	disposeOwner(owner: string): void { this.disposeMatching(e => e.policy.owner === owner); }
	private disposeMatching(match: (e: Entry) => boolean): void { for (const [id,e] of this.entries) if (match(e)) { if (e.busy) e.removeOnFinish = true; else this.remove(id,e); } }
	dispose(): void { if (this.disposed) return; this.disposed = true; this.disposeMatching(() => true); }
}
