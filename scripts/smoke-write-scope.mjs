// Runtime smoke without model requests. All mutations are disposable fixtures.
// PI_SDK_ROOT may select the installed Pi instead of the local dependency.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = fileURLToPath(new URL("../", import.meta.url));
const sdkUrl = process.env.PI_SDK_ROOT
  ? pathToFileURL(path.join(process.env.PI_SDK_ROOT, "dist/index.js"))
  : import.meta.resolve("@earendil-works/pi-coding-agent");
const sdk = await import(String(sdkUrl));
const { loadExtensions } = await import(new URL("./core/extensions/loader.js", sdkUrl).href);
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "scope-runtime-")));
const inside = path.join(root, "allowed");
fs.mkdirSync(inside);
const sentinel = path.join(root, "outside.txt");
fs.writeFileSync(sentinel, "unchanged");
const key = "PI_SUBAGENT_WRITE_SCOPE";
const originalEnv = process.env[key];
const scope = JSON.stringify({ version: 1, roots: [{ path: inside, kind: "directory" }] });
const excluded = ["write", "edit", "bash", "powershell", "safe_bash", "subagent", "pipeline", "loop", "codemode", "tool_search", "mcp__*"];
let calls = 0;

try {
  for (const mode of ["valid", "missing", "invalid", "empty"]) {
    if (mode === "missing") delete process.env[key];
    else process.env[key] = mode === "invalid" ? "invalid" : mode === "empty" ? '{"version":1,"roots":[]}' : scope;
    const loaded = await loadExtensions([path.join(repo, "tools/scoped-mutations.ts")], root);
    assert.equal(loaded.errors.length, mode === "missing" || mode === "invalid" ? 1 : 0, `${mode}: loader result`);
    const resources = {
      getExtensions: () => loaded,
      getSkills: () => ({ skills: [], diagnostics: [] }),
      getPrompts: () => ({ prompts: [], diagnostics: [] }),
      getThemes: () => ({ themes: [], diagnostics: [] }),
      getAgentsFiles: () => ({ agentsFiles: [] }),
      getSystemPrompt: () => "Runtime scope test; never request a model.",
      getSystemPromptSource: () => undefined,
      getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [],
      extendResources: () => {}, reload: async () => {},
    };
    const tripwire = name => ({ name, label: name, description: "Must never be callable", parameters: { type: "object", properties: {} },
      execute: async () => { fs.writeFileSync(sentinel, "BYPASS"); throw new Error("Forbidden tool was executed"); } });
    const { session } = await sdk.createAgentSession({
      cwd: root, agentDir: path.join(root, "agent"), resourceLoader: resources,
      tools: ["read", "scoped_edit", "scoped_write", "scope_probe"], excludeTools: excluded,
      sessionManager: sdk.SessionManager.inMemory(root),
      settingsManager: sdk.SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: { mode: "off" } }),
      customTools: [tripwire("unexpected_custom"), tripwire("mcp__evil__write"), {
        name: "scope_probe", label: "Scope probe", description: "Test-only nested call probe",
        parameters: { type: "object", properties: { name: { type: "string" }, args: { type: "object" } }, required: ["name", "args"] },
        execute: async (_id, args, _signal, _update, ctx) => {
          assert.equal(typeof ctx.executeTool, "function", "This smoke requires a Pi runtime with ctx.executeTool");
          const outcome = await ctx.executeTool(args.name, args.args);
          return { content: [{ type: "text", text: "probe completed" }], details: outcome };
        },
      }],
    });
    try {
      const probe = session.agent.state.tools.find(t => t.name === "scope_probe");
      assert.ok(probe, "test-only probe must be active");
      const call = async (name, args) => {
        const id = `probe-${++calls}`;
        // Synthetic assistant turn: exercise real dispatch without an LLM/API call.
        session.sessionManager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id, name: "scope_probe", arguments: { name, args } }],
          api: "openai-completions", provider: "fixture", model: "fixture", stopReason: "toolUse", timestamp: Date.now(),
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
        session.refreshContext();
        return (await probe.execute(id, { name, args })).details;
      };
      for (const name of [...excluded.filter(n => !n.includes("*")), "unexpected_custom", "mcp__evil__write"]) {
        assert.equal(session.getAllTools().some(t => t.name === name), false, `${mode}: ${name} must not be registered`);
        const result = await call(name, { path: sentinel, content: "BYPASS", edits: [{ oldText: "unchanged", newText: "BYPASS" }], command: `printf BYPASS > '${sentinel}'` });
        assert.equal(result.isError, true, `${mode}: ${name} must fail`);
      }
      const destination = path.join(inside, `${mode}.txt`);
      const written = await call("scoped_write", { path: destination, content: "initial" });
      assert.equal(written.isError, mode !== "valid", `${mode}: protected write outcome ${JSON.stringify(written)}`);
      if (mode === "valid") {
        assert.equal(fs.readFileSync(destination, "utf8"), "initial");
        const edited = await call("scoped_edit", { path: destination, edits: [{ oldText: "initial", newText: "edited" }] });
        assert.equal(edited.isError, false); assert.equal(fs.readFileSync(destination, "utf8"), "edited");
      } else assert.equal(fs.existsSync(destination), false);
      assert.equal((await call("scoped_write", { path: sentinel, content: "BYPASS" })).isError, true);
      assert.equal((await call("scoped_edit", { path: sentinel, edits: [{ oldText: "unchanged", newText: "BYPASS" }] })).isError, true);
      assert.equal(fs.readFileSync(sentinel, "utf8"), "unchanged");
      console.log(`PASS ${mode}: registry and nested calls fail closed; fixture integrity preserved`);
    } finally { session.dispose(); }
  }
  delete process.env[key];
  const extension = await loadExtensions([path.join(repo, "index.ts"), path.join(repo, "tools/subagent-report.ts")], repo);
  assert.deepEqual(extension.errors, [], "main/report extensions must load in the installed runtime");
  console.log(`PASS main/report loader; ${calls} nested tool probes; no model requests`);
} finally {
  if (originalEnv === undefined) delete process.env[key]; else process.env[key] = originalEnv;
  fs.rmSync(root, { recursive: true, force: true });
}
