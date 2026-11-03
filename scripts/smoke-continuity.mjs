// Real Pi SDK/history interoperability. --live runs two worker invocations (paid model requests; potentially multiple requests per invocation).
// All artifacts are private fixtures; no settings or operator sessions are modified.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = fileURLToPath(new URL("../", import.meta.url));
const sdkUrl = process.env.PI_SDK_ROOT ? pathToFileURL(path.join(process.env.PI_SDK_ROOT, "dist/index.js")) : import.meta.resolve("@earendil-works/pi-coding-agent");
const sdk = await import(String(sdkUrl));
const { loadExtensions, createExtensionRuntime } = await import(new URL("./core/extensions/loader.js", sdkUrl).href);
const { createJiti } = createRequire(sdkUrl)("jiti");
const jiti = createJiti(import.meta.url);
const { WorkerSessions } = await jiti.import(path.join(repo, "lib/worker-sessions.ts"));
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "continuity-smoke-")));
fs.mkdirSync(path.join(root, "allowed"));
const policy = { owner: "sdk-fixture", agent: "fixture", fingerprint: "fixture", model: "fixture/model", thinking: "off", cwd: root,
  scope: { version: 1, roots: [{ path: path.join(root, "allowed"), kind: "directory" }] } };
const workers = new WorkerSessions({ baseDir: root, headerFactory: (cwd, id) => ({ ...sdk.SessionManager.inMemory(cwd).getHeader(), id }) });
const fixtureModel = { id: "model", name: "fixture", provider: "fixture", api: "openai-completions", baseUrl: "http://invalid.invalid", reasoning: false,
  input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1024 };
const resources = {
  getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
  getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }),
  getThemes: () => ({ themes: [], diagnostics: [] }), getAgentsFiles: () => ({ agentsFiles: [] }),
  getSystemPrompt: () => "Synthetic SDK smoke", getSystemPromptSource: () => undefined,
  getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [], extendResources: () => {}, reload: async () => {},
};
async function open(lease, tools) {
  return (await sdk.createAgentSession({ cwd: root, agentDir: path.join(root, "agent"), model: fixtureModel, thinkingLevel: "off",
    resourceLoader: resources, tools, sessionManager: sdk.SessionManager.open(lease.file, lease.directory),
    settingsManager: sdk.SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: { mode: "off" } }) })).session;
}
let liveExtension, liveContext;
try {
  const first = workers.create(policy); first.start();
  const token = randomUUID();
  const session1 = await open(first, ["read", "write"]);
  try {
    session1.sessionManager.appendMessage({ role: "user", content: `Remember ${token}`, timestamp: Date.now() });
    session1.refreshContext();
    assert.equal(session1.sessionId, first.id);
  } finally { session1.dispose(); }
  assert.equal(first.finish("completed").resumable, true);
  const size = fs.statSync(first.file).size;
  const second = workers.resume(first.id, { ...policy, scope: { version: 1, roots: [] } });
  assert.equal(second.start(), 2);
  const session2 = await open(second, ["read"]);
  try {
    assert.equal(session2.sessionId, first.id);
    assert.ok(JSON.stringify(session2.messages).includes(token), "real SDK must restore the prior transcript");
    assert.deepEqual(session2.getActiveToolNames(), ["read"], "old tool selection must not broaden explicit resume selection");
    assert.equal(`${session2.model.provider}/${session2.model.id}`, policy.model);
    session2.sessionManager.appendMessage({ role: "user", content: "Second turn", timestamp: Date.now() });
    session2.refreshContext();
  } finally { session2.dispose(); }
  assert.equal(second.finish("completed").resumable, true);
  assert.ok(fs.statSync(first.file).size > size);
  assert.equal(fs.statSync(first.file).mode & 0o777, 0o600);
  assert.throws(() => workers.resume(first.id, policy), /widen/);
  workers.dispose(); assert.equal(fs.existsSync(first.directory), false);
  console.log("PASS SDK: same transcript/id restored, explicit model/tools honored, permanent scope reduction, private modes and cleanup; no model requests");

  if (process.argv.includes("--live")) {
    const loaded = await loadExtensions([path.join(repo, "index.ts")], root);
    assert.deepEqual(loaded.errors, []);
    liveExtension = loaded.extensions[0];
    const registered = liveExtension.tools.get("subagent");
    const tool = registered.definition ?? registered;
    liveContext = { cwd: root, sessionManager: sdk.SessionManager.inMemory(root), modelRegistry: { find: () => undefined } };
    // The launcher normally derives its executable from the parent Pi argv.
    process.argv[1] = fileURLToPath(new URL("./cli.js", sdkUrl));
    const nonce = randomUUID();
    const firstResult = await tool.execute("smoke-turn-1", { agent: "worker", task: `Remember this token for a later turn: ${nonce}. Reply ACK. Do not read or write files, run commands or delegate. You may use subagent_report.`, write_scope: [], continuity: { mode: "create" } }, undefined, undefined, liveContext);
    const r1 = firstResult.details.results[0];
    assert.equal(firstResult.isError, undefined, JSON.stringify(r1.progress));
    assert.equal(r1.worker_session?.resumable, true, JSON.stringify(r1));
    console.log("PASS live turn 1: scoped worker history created", r1.worker_session.id);
    const secondResult = await tool.execute("smoke-turn-2", { agent: "worker", task: "Return the token I asked you to remember in the previous turn, exactly. Do not read files or run commands; use your conversation history. You may use subagent_report.", continuity: { mode: "resume", worker_id: r1.worker_session.id } }, undefined, undefined, liveContext);
    const r2 = secondResult.details.results[0];
    assert.equal(secondResult.isError, undefined, JSON.stringify(r2.progress));
    assert.equal(r2.worker_session.id, r1.worker_session.id); assert.equal(r2.worker_session.turn, 2);
    assert.ok(r2.output.includes(nonce), "worker must recall token not present in the second task");
    for (const r of [r1, r2]) {
      assert.deepEqual(r.delivery.observed.fileWrites, []); assert.deepEqual(r.delivery.observed.commands, []);
      assert.ok(r.progress.recentTools.every(t => t.tool === "subagent_report"), "no read/shell or other tool used to retrieve token");
      assert.deepEqual(r.delivery.restriction.scope.roots, []);
    }
    console.log("PASS live turn 2: actual worker recalled previous token without file reads; same ID, turn 2, scope inherited, zero writes/commands");
  }
} finally {
  if (liveExtension) for (const handler of liveExtension.handlers.get("session_shutdown") ?? []) await handler({ type: "session_shutdown", reason: "quit" }, liveContext);
  workers.dispose();
  fs.rmSync(root, { recursive: true, force: true });
}
