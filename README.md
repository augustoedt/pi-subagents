# @rohaquinlop/pi-subagents

A [pi](https://github.com/earendil-works/pi) extension that registers three agent orchestration tools — `subagent`, `pipeline`, and `loop` — with four built-in agents:

## Installation

```bash
pi install @rohaquinlop/pi-subagents
```

| Agent | Tools | Model | Purpose |
|-------|-------|-------|---------|
| **scout** | read, grep, find, ls | deepseek-v4-flash | Fast codebase recon |
| **researcher** | web_search, web_fetch | deepseek-v4-flash | Web research |
| **reviewer** | read, grep, find, ls | inherit (high thinking) | Read-only code and security review |
| **worker** | read, write, edit, safe_bash, web_search, web_fetch, subagent | deepseek-v4-flash | Code changes (can dispatch scout/researcher to protect its own context) |

`worker` is allowlisted to spawn only `scout` and `researcher` (via `subagent_agents` in its frontmatter), so the chain stops at depth 2 — a worker cannot recurse into another worker.

## Dependencies

`safe_bash` ships in this repo (`tools/safe-bash.ts`). `web_search` and `web_fetch` do not — `researcher` and `worker` depend on them. Grab those two extensions from [amosblomqvist/pi-config](https://github.com/amosblomqvist/pi-config) (`extensions/web-search/`, `extensions/web-fetch/`) and drop them into `~/.pi/agent/extensions/`. A dispatch now fails explicitly before spawning if any declared tool lacks a mapping or its extension file is missing/unreadable. This checks mapping/files, not whether an arbitrary extension successfully registers its tool at runtime.

## Usage

### Subagent — Single Agent Dispatch

One tool call = one subagent:
```json
{ "agent": "scout", "task": "Find all auth-related files in src/" }
```

To fan out, emit multiple `subagent` tool calls in the same assistant turn. The instance-local coordinator admits independent work concurrently up to `maxConcurrency` (default 4); overlapping write scopes or named resources wait. Unscoped potential writers serialize conservatively.

Each subagent runs as an isolated `pi` process with no inherited conversation — supply context in `task` or the optional fields below. Process isolation is not filesystem isolation or a sandbox. The `reviewer` has no edit, write, or shell tools; provide paths and review criteria in the task. It inherits the parent session's model.

For a security review:
```json
{ "agent": "reviewer", "task": "Review authentication changes in src/auth/ for concrete security defects. Report severity, file and line, impact, and fix. Do not change files." }
```

### Pipeline — Sequential Agent Chains

Chain 2–5 agents in sequence where each agent's output feeds as context into the next. Use `{previous}` in a step's task to inject the prior step's output.

```json
{ "tool": "pipeline", "args": { "steps": [
  { "agent": "scout", "task": "Find all auth-related code in src/" },
  { "agent": "worker", "task": "Based on these findings:\n{previous}\n\nImplement password reset flow." }
]}}
```

Each step runs a separate subagent process. The pipeline stops on the first error. Per-step and total usage (tokens, cost, duration) are shown in the TUI.

### Loop — Iterative Refinement

Run the same agent 2–5 times, passing all prior iteration outputs as context. Optionally use a `judge` agent to stop early when quality is sufficient.

**Basic (fixed iterations):**

```json
{ "tool": "loop", "args": {
  "agent": "worker",
  "task": "Write a comprehensive README for this project.",
  "max_iterations": 3
}}
```

**With judge for dynamic stopping:**

```json
{ "tool": "loop", "args": {
  "agent": "worker",
  "task": "Write a comprehensive README for this project.",
  "max_iterations": 5,
  "judge": {
    "agent": "reviewer",
    "criteria": "Is this README complete, well-structured, and ready for publication? Answer YES or NO."
  }
}}
```

The judge evaluates each iteration's output. When satisfied (YES), the loop stops early — no wasted iterations. Judge feedback is passed back to the runner agent for refinement.

## Config

Config is read from two locations, the second overriding the first:

1. `config.json` next to `index.ts` — inside `node_modules`, so it is usually
   gitignored and is **replaced whenever the package updates**. Fine for a
   throwaway local tweak.
2. `~/.pi/agent/pi-subagents.config.json` — survives updates and can be tracked
   alongside the rest of your pi config. Put anything you want to keep here.

```json
{ "maxConcurrency": 4 }
```

Merging is shallow: a key set in the user file replaces the package file's value
outright. A malformed file is skipped with a warning rather than silently
dropping your settings.

### Model tiers

Pinning a concrete model in every agent file couples the whole fleet to one
provider — switching means editing each file. Define tiers instead, in
`~/.pi/agent/pi-subagents.config.json` so they survive package updates:

```json
{
  "modelTiers": {
    "fast": "deepseek/deepseek-v4-flash",
    "deep": "deepseek/deepseek-v4-pro"
  }
}
```

Agent files then reference a tier by role, and one config edit repoints them all:

```yaml
model: $fast
```

A tier may point at another tier, or at `inherit`. Cycles are detected and
reported rather than followed. An undefined tier fails the dispatch with the
agent named — it never falls back to some default model.

## Delegation contract (local `feat/better-subagent`)

Existing `agent`, `task`, and `cwd` calls remain valid. Three optional arrays
(maximum 20 nonblank strings of 2000 characters each) add explicit context:

```json
{
  "agent": "worker",
  "task": "Add login tests",
  "context_files": ["src/auth/login.ts"],
  "acceptance": ["Cover invalid password and expired session"],
  "constraints": ["Do not change production code", "Do not commit"]
}
```

`context_files` are existing readable files, relative to the child cwd or
absolute (`@` and `~/` file references supported). They are passed as canonical
paths, **not automatically read/injected**. File contents are task data, not
instructions overriding the delegation. Each pipeline step accepts these
fields; a loop passes them to its runner and judge. Context files are checked
when the corresponding execution starts, so an earlier step may create one.

`constraints` are prompt instructions, **not enforced write scopes or locks**.
Use `write_scope` below for enforced tool-level write boundaries. Resource
coordination and opt-in worker continuity are described below; neither is an OS
sandbox or a cross-instance lock. Cwd, concrete model/tier resolution, declared
tool mappings/files, and supported configuration value types are checked
before spawn. Provider availability, credentials and dynamic tool registration
are not proven by this preflight.

### Controlled write scope

The coordinator chooses the smallest scope allowed by the user's authorization:

```json
{
  "agent": "worker",
  "task": "Add login tests; report checks for the coordinator to run",
  "write_scope": [{ "path": "tests/auth", "kind": "directory" }]
}
```

- Available on `subagent`, each pipeline step, and `loop` (runner and judge).
  Omitted preserves the original profile; `[]` denies all writes. Explicit
  `null` is rejected rather than coerced into an absent permission field.
- At most 20 entries: nonblank paths up to 2000 characters, relative to cwd
  or absolute. No globs, `@`, `~/`, or file URLs in **scope declarations**.
- A `file` scope permits exactly that file; a new file requires an existing
  parent. A `directory` scope must already exist and permits descendants,
  including new subdirectories. Filesystem roots and `.git` are forbidden.
- Only already-declared `edit`/`write` capabilities are replaced by
  `scoped_edit`/`scoped_write`; readonly profiles never gain write access.
  Local `read`/`grep`/`find`/`ls` remain available if declared; reporting is added.
- Shell (`bash`/`safe_bash`), code execution, network/custom tools, MCP and
  nested delegation are unavailable. **The coordinator runs builds/tests.**
  Disabled tools and canonical roots are disclosed in the prompt and delivery.
- Original mutators are excluded; protected tools have distinct names.
  A failed guard-extension load does not restore unrestricted `edit`/`write`.
  Retries retain the policy; inherited scope cannot widen. `envExtra` cannot
  set the reserved `PI_SUBAGENT_WRITE_SCOPE` variable.

Checks reject symlink escapes, dangling links, special files and multi-linked
files. Roots are pinned to **canonical pathnames, not original directory inode
identities**: recreating a directory at the same authorized pathname does not
widen scope. Pipeline roots are resolved before the first step, so a preceding
step cannot create a directory used as a new scope root in that pipeline.

This is tool-boundary enforcement, **not an OS sandbox**, read confinement,
filesystem snapshot or resource lock. Trusted extension/guard code, external
processes and cross-process TOCTOU races are not isolated. Do not delegate edits
to the trusted runtime itself and expect self-protection; the coordinator must
validate such changes before another execution/reload. Workers requiring
more access must report the blocker; the coordinator decides whether a new
scope is already authorized or needs user approval.

### Resource coordination (instance-local)

`resources?: string[]` is available on `subagent`, each pipeline step, and `loop`
(runner and judge). Names are exclusive reservations, not permissions: at most
20 nonblank names of 128 characters; the `__` prefix is reserved. Names and path
comparisons are NFC-normalized and case-folded, which can conservatively serialize
otherwise distinct paths on case-sensitive filesystems.

- Effective writers automatically reserve exact files/subtrees from `write_scope`.
- Unscoped shell/custom tools and other potential writers use a global writer
  reservation. Proven read-only profiles do not reserve writes automatically.
- Capacity and all resources are admitted together. Independent waiting work can
  start without waiting for an unrelated busy resource; conflicting waiters keep
  arrival order. No slot is consumed while waiting for resource availability.
- `maxQueueDepth` defaults to 64; `queueTimeoutMs` defaults to 0 (no queue deadline).
  Child execution timeouts remain separate. Queue cancellation never spawns a child.
- Running reservations release after the child exits, even on cancellation/failure.
  Pipeline steps and loop runner/judge turns release between executions.
- Delivery metadata reports claims, wait duration and reason. This coordinates
  direct sibling calls only, not another Pi, descendants, other extensions, external
  commands or editors. It does not provide a consistent snapshot for reads.

### Worker continuity (opt-in, subagent only)

Create a scoped worker whose own history will be needed again:

```json
{
  "agent": "worker",
  "task": "Implement the first part; report checks for the coordinator",
  "write_scope": [{ "path": "src/feature", "kind": "directory" }],
  "continuity": { "mode": "create" }
}
```

Continue using the `worker_session.id` returned in text/details:

```json
{
  "agent": "worker",
  "task": "Correct the edge case from your previous turn",
  "continuity": { "mode": "resume", "worker_id": "<returned UUID>" }
}
```

A new child process loads the same private transcript; this is not a live daemon.
Omitted `continuity` retains the original ephemeral behavior. Creation requires
explicit `write_scope` (including `[]`). Resume inherits omitted cwd/scope; explicit
scope may narrow permanently but never widen. Agent/profile, concrete model,
thinking and cwd remain pinned. Unknown IDs, incompatible policy, missing/corrupt
history and concurrent turns fail explicitly. A busy worker rejects another turn
rather than silently queuing it. The orchestrator does not automatically repeat
persistent turns (including loop-detector retries); failed/cancelled turns require
an explicit resume and valid history. Internal Pi/provider transport retries are
not disabled by this feature.

Ownership lasts only for the current parent session/instance. Reload, session
replacement or restart invalidates IDs. Temporary directories are private (0700),
JSONL files are precreated 0600, and only owned artifacts are cleaned after active
children exit. Runtime transcript writes are administrative metadata **outside
workspace write_scope**; they may contain code and tool outputs. A hard crash can
leave private temporary residues; there is no automatic takeover or cross-process
recovery. Never pass arbitrary session paths or import another session's ID.

Limits: 16 workers per instance, 20 turns per worker, 16 MiB per transcript checked
between turns (not an in-flight disk quota). No silent eviction or JSONL truncation.
`worker_session` reports ID, turn, status, resumability and bounded prior-turn
references; `Delivery v1` remains evidence for **one turn**, not cumulative approval.
Pipeline/loop receive resource coordination but remain ephemeral in this version.

## Output

The normal textual answer remains available. Each child also receives a
read-only reporting tool, `subagent_report`, to declare its status, summary,
claimed files, unexecuted checks, assumptions, and blockers. A missing report
is explicitly `not_reported`; no JSON is inferred from arbitrary prose.

`details.results[].delivery`, pipeline step `delivery`, and loop iteration
`delivery`/`judgeDelivery` keep typed v1 metadata. Model-facing text includes a
bounded summary/evidence before the answer. Existing codemode callers still
receive text (no new `outputSchema` conversion).

**Process completion, agent declaration and observed tool outcomes are separate.**
Acceptance stays `not_verified`: a zero child exit, a successful shell tool, or
a judge's YES is not proof that tests/acceptance passed. The coordinator must
inspect evidence and missing checks. Successful direct `edit`/`write` events
(including their `scoped_*` counterparts) and `bash`/`safe_bash` outcomes are recorded independently of the declaration;
this is neither a full git diff nor an inventory of shell/descendant writes.
Only actual tool-provided log paths are preserved. No logs or exit codes are
invented from the agent's final answer.

Evidence retains at most 20 paths and 20 commands (1000-character command/output
excerpts); missing events, omissions and truncation are disclosed. A report is
limited to 16 KB JSON. Evidence survives retry; later work invalidates a stale
report. Large model-facing outputs are head-truncated at Pi's normal limits.
If artifacts are needed, request their creation explicitly and inspect them.

Development state and local install/rollback: [docs/README.md](docs/README.md).

## UI

Two levels, toggled with `ctrl+o`:

- **Collapsed (default):** the tool call shows one line — `subagent <agent> <60-char task preview>`. The result block shows the agent header (status, tool count, duration), the chronological tool log (one line per call, running calls marked with `▸`), the latest prose "thinking" line, and a usage line (tokens in/out, cache, cost, context-window gauge).
- **Expanded:** the call header streams the full task body live as the parent writes it (like `write`/`edit`). The result block additionally renders the subagent's full final output as markdown. Successful `edit` calls show a bounded preview of removed and added replacement lines under the file path; this is not a full repository diff (use `git diff` for that). Nested children (when a worker spawns scout/researcher) render inline, indented under the row that dispatched them, with their own per-row context gauge.

In interactive Pi, `/se` lists the **ten most recent executions** of `subagent`, `pipeline`, or `loop` on the active session branch, including read-only agents such as `scout` and `researcher`. Select an execution to read its saved textual result; when it has successful `edit` calls, choose between the result and per-call diffs. Edits from nested agents show their author path. Use ↑/↓ to select, Enter to open, and Esc to return. In a result or diff, ↑/↓ scroll by line and Shift+↑/↓ by page. Very long textual results show an explicit warning after the first 128,000 characters; the saved result is unchanged. `ctrl+o` keeps a short inline preview; `/se` stores a larger diff per call (up to 500 lines or 32 KB), with a warning if its per-edit limit was reached.

The live tool log remains limited to 50 calls. When older calls are evicted, `/se` retains up to 100 of their successful edits, capped at 512 KB per agent execution; if the archive overflows, the run shows an omission count. Failed runs remain browsable and failed edit attempts are counted, but only successful calls have diffs. Results saved by older versions may lack evicted edits, and older pipeline/loop results may lack all edits; `/se` flags this uncertainty. The explorer reads only the active branch of the current session, including when it is reopened. The ten-execution limit is a deliberate approximation, not a measurement of the terminal's scrollback buffer. Protected `scoped_edit` calls follow the same diff path. It does not show `write`/`scoped_write` diffs, reconstruct file contents, or use cumulative `git diff`.

## Registering Agents from Other Extensions

Other extensions can dynamically register and unregister agents at runtime. This is useful for domain-specific agents that should only be available when a particular extension is active.

### 1. Define agent `.md` files

Create markdown files with YAML frontmatter in your extension's directory (e.g. `my-extension/agents/my-agent.md`):

```markdown
---
name: my-agent
description: Does a specific thing
tools: web_search, video_extract
model: claude-sonnet-4-20250514
---

You are an agent that does a specific thing...
```

Frontmatter fields:
- **name** (required) — unique agent name, used in `{ agent: "my-agent" }` calls
- **description** — short description
- **tools** — comma-separated list of tools the agent needs (builtin or extension). Include `subagent` here to let this agent spawn other agents.
- **model** (required) — provider-agnostic model identifier (e.g. `deepseek-v4-flash`). Pi resolves it from any registered provider that serves it. Two indirections avoid pinning a provider here: `inherit` uses whatever model the session is currently on (and follows `/model` switches), and `$name` looks up a tier from [`modelTiers`](#model-tiers). Nested subagents inherit the top-level session model via `PI_SUBAGENT_INHERIT_MODEL`.
- **thinking** (required) — reasoning level: `off`, `low`, `medium`, `high`. A file missing this is skipped during discovery, same as one missing `name`, `description`, `tools` or `model`.
- **subagent_agents** — if `subagent` is in `tools`, restrict which agents this one may spawn. Comma-separated list of agent names. Omit for no restriction. Enforced by passing `PI_SUBAGENT_ALLOWED` env to the child `pi` process — the child's subagents extension filters its registry before any tool description sees it, so the child LLM literally can't reference an agent outside the allowlist.

The markdown body becomes the agent's system prompt.

Agents can optionally declare a `connector` field in their frontmatter — a prompt template that wraps their output before it's passed as `{previous}` to the next agent in a pipeline:

```yaml
connector: "## Key findings from codebase exploration:\n\n{output}"
```

Connectors use single-line format with `\n` for line breaks. They can be overridden per-step via the optional `connector` field on pipeline steps.

### 2. Register agents via `globalThis.__pi_subagents`

Pi loads extensions via jiti, which creates separate module instances. Direct imports from the subagents extension will reference a different `agents` array than the one the `subagent` tool uses. Use the `globalThis` bridge instead:

```typescript
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";

interface AgentConfig {
  name: string;
  description: string;
  tools: string[];
  model: string;
  thinking: string;        // "off" | "low" | "medium" | "high"
  systemPrompt: string;
  filePath: string;
  subagentAgents?: string[]; // optional spawn-allowlist when `subagent` is in tools
}

const AGENTS_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), "agents");

function registerMyAgents(): void {
  const subagents = (globalThis as any).__pi_subagents as
    | { registerAgent: (config: AgentConfig) => void; unregisterAgent: (name: string) => void }
    | undefined;
  if (!subagents) return; // subagents extension not loaded

  for (const entry of fs.readdirSync(AGENTS_DIR)) {
    if (!entry.endsWith(".md")) continue;
    const filePath = path.join(AGENTS_DIR, entry);
    const content = fs.readFileSync(filePath, "utf-8");
    const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);
    if (!frontmatter.name) continue;

    const tools = (frontmatter.tools || "").split(",").map(t => t.trim()).filter(Boolean);
    const subagentAgents = frontmatter.subagent_agents
      ? frontmatter.subagent_agents.split(",").map(t => t.trim()).filter(Boolean)
      : undefined;
    try {
      subagents.registerAgent({
        name: frontmatter.name,
        description: frontmatter.description || "",
        tools,
        model: frontmatter.model || "anthropic/claude-sonnet-4-6",
        thinking: frontmatter.thinking || "medium",
        systemPrompt: body,
        filePath,
        ...(subagentAgents ? { subagentAgents } : {}),
      });
    } catch {
      // Already registered — skip
    }
  }
}
```

Call `registerMyAgents()` when your extension activates (e.g. in a command handler). The agents become available to the `subagent` tool immediately.

### 3. Adding custom tool support

If your agents need tools beyond the built-in set, those tools must be mapped in the `CUSTOM_TOOL_EXTENSIONS` record in `subagents/index.ts`:

```typescript
const CUSTOM_TOOL_EXTENSIONS: Record<string, string> = {
  web_search: path.join(EXT_BASE, "web-search", "index.ts"),
  web_fetch: path.join(EXT_BASE, "web-fetch", "index.ts"),
  safe_bash: path.join(TOOLS_DIR, "safe-bash.ts"),
  video_extract: path.join(EXT_BASE, "video-extract", "index.ts"),
  youtube_search: path.join(EXT_BASE, "youtube-search", "index.ts"),
  google_image_search: path.join(EXT_BASE, "google-image-search", "index.ts"),
};
```

Built-in tools (`read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`) work automatically. Any other tool the agent lists in its frontmatter must have a corresponding entry here pointing to the extension's `index.ts`.

The `subagent` tool itself is listed in `CUSTOM_TOOL_EXTENSIONS` pointing back to this extension's own `index.ts` — that's how an agent like `worker` can recursively spawn other agents. Recursion is bounded only by each agent's `subagent_agents` allowlist (e.g. worker can spawn scout/researcher, neither of which declares the `subagent` tool, so the chain stops at depth 2).

### 4. Model-specific extensions (no manual mapping)

Extensions that apply to specific models (not tools) can declare `appliesToModels`
in their `package.json` and auto-load without any `CUSTOM_TOOL_EXTENSIONS` mapping:

```json
{
  "pi": {
    "extensions": ["./extensions/index.ts"],
    "appliesToModels": ["deepseek-*"]
  }
}
```

When a subagent's configured model matches one of the patterns, the extension is
loaded via `--extension` in the child process. Glob patterns (`*` wildcard) match
the **model ID** (the portion after the last `/`, e.g. `deepseek-v4-flash` in
`nan/deepseek-v4-flash`). Plain strings without wildcards match the **provider
name** (the portion before the `/`, e.g. `nan` in `nan/deepseek-v4-flash`).
Matching is case-insensitive.

## Structure

```
@rohaquinlop/pi-subagents/
├── index.ts           # Extension entry point
├── agents/            # Built-in agent configs (frontmatter + system prompt)
├── lib/               # Pure helper functions (agent discovery, frontmatter parsing,
│                      #   config loading, model tier resolution)
└── tools/             # Extensions loaded into subagent processes
    └── safe-bash.ts   # bash with dangerous command blocking
```

## Acknowledgements

The pipeline and loop tools are conceptually inspired by [RecursiveMAS](https://arxiv.org/abs/2604.25917) — a research framework for scaling agent collaboration through iterative refinement and system-level orchestration.
