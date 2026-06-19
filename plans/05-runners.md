# Implementation Plan: RUNNERS Layer

Date: 2026-06-18
Architecture reference: `/Users/gabrielxavier/Documents/project-builder-v2/README.md`

---

## Goal

Implement concrete `AgentRunner` implementations that invoke LLM agents via different backends — all conforming to the `AgentRunner` interface in `ports.ts`.

---

## Current state

Three stubs exist:
- `src/runners/pi-sdk-runner.ts` — uses `createAgentSession()` but has placeholder model resolution and incomplete summary extraction
- `src/runners/pi-interactive-runner.ts` — uses `InteractiveMode` but doesn't pass agent tools or model
- `src/runners/claude-code-runner.ts` — spawns `claude` CLI with basic args but doesn't handle prompt passthrough properly

All three need production-quality implementations.

---

## Task 1: Productionize PiSdkRunner

**Current issues:**
1. Model resolution is a placeholder comment (`/* parse provider/id */`)
2. Doesn't set system prompt on the session
3. Doesn't pass `contextFiles` (if provided, should read them and prepend to prompt)
4. `extractSummary` is fragile (assumes text content type, doesn't handle tool results)
5. No timeout/abort support
6. `expectedOutputs` is always empty `[]` — should be populated from the agent manifest (but the runner doesn't have access to it)

**File:** `src/runners/pi-sdk-runner.ts`

**Changes:**

### 1a. Model resolution
```typescript
private resolveModel(input: AgentRunInput): Model | undefined {
  if (!input.model) return this.defaultModel;

  // Parse "provider/model" string — same format as pi's --model flag
  const parts = input.model.split("/");
  if (parts.length === 2) {
    const [provider, id] = parts;
    const model = getModel(provider as any, id);
    if (model) return model;
    // Fall back to registry find for custom models
    return this.modelRegistry.find(provider, id);
  }
  // Single token — try as model id across all providers
  return this.modelRegistry.find(/* ... */) ?? this.defaultModel;
}
```

### 1b. System prompt support
```typescript
const resourceLoader = input.systemPrompt
  ? new DefaultResourceLoader({
      systemPromptOverride: () => input.systemPrompt,
    })
  : undefined;

if (resourceLoader) await resourceLoader.reload();

const { session } = await createAgentSession({
  // ...existing options...
  resourceLoader,
});
```

### 1c. Context files
```typescript
if (input.contextFiles && input.contextFiles.length > 0) {
  const contextContents = input.contextFiles
    .map(f => {
      const absPath = path.resolve(input.cwd, f);
      if (!fs.existsSync(absPath)) return null;
      return `\n<file path="${f}">\n${fs.readFileSync(absPath, "utf-8")}\n</file>`;
    })
    .filter(Boolean)
    .join("\n");

  if (contextContents) {
    finalPrompt = contextContents + "\n\n" + finalPrompt;
  }
}
```

### 1d. Improved summary extraction
```typescript
function extractSummary(messages: AgentMessage[]): string {
  // Find the last assistant message
  const lastAssistant = [...messages].reverse().find(m => m.role === "assistant");
  if (!lastAssistant) return "Agent completed (no assistant response)";

  // Extract text from content
  const content = lastAssistant.content;
  if (!Array.isArray(content)) return "Agent completed";

  const textBlocks = content.filter(
    (c): c is { type: "text"; text: string } => c.type === "text"
  );

  const combined = textBlocks.map(t => t.text).join("\n").trim();

  // If no text, check for tool calls
  if (!combined) {
    const toolBlocks = content.filter(
      (c): c is { type: "tool_use"; name: string } => c.type === "tool_use"
    );
    if (toolBlocks.length > 0) {
      return `Agent used tools: ${toolBlocks.map(t => t.name).join(", ")}`;
    }
    return "Agent completed";
  }

  // Truncate to 300 chars for workflow activity
  return combined.length > 300 ? combined.slice(0, 297) + "..." : combined;
}
```

### 1e. Timeout support (via AbortController)
```typescript
export interface PiSdkRunnerOptions {
  // ...existing...
  /** Timeout in ms for the entire agent run. Default: no timeout. */
  timeout?: number;
}

async run(input: AgentRunInput): Promise<AgentRunResult> {
  const controller = new AbortController();

  const timeoutMs = this.options.timeout;
  const timer = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : null;

  try {
    await session.prompt(finalPrompt, { signal: controller.signal });
    // ...
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      return {
        success: false,
        summary: `Agent timed out after ${timeoutMs}ms`,
        expectedOutputs: [],
        error: `Timeout after ${timeoutMs}ms`,
      };
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
```

### 1f. Expected outputs
The runner can't verify outputs (that's `OutputVerifier`'s job). It CAN list them from the agent manifest, but the runner doesn't receive the manifest — only the prompt, tools, and model. Keep `expectedOutputs: []` and let the orchestrator handle this with `OutputVerifier`.

**Acceptance:** Unit test with mocked `createAgentSession`: runner passes prompt + tools + model correctly, extracts summary from messages array, handles timeout.

---

## Task 2: Productionize PiInteractiveRunner

**Current issues:**
1. Doesn't pass agent tools to the InteractiveMode session
2. Doesn't set the correct model (Uses default from auth.json)
3. Doesn't inject system prompt
4. Doesn't handle the case where the user aborts the pi TUI (Ctrl+C)
5. `extractSummary` duplicates PiSdkRunner — extract to shared utility

**File:** `src/runners/pi-interactive-runner.ts`

**Changes:**

### 2a. Pass tools and model
```typescript
import { getModel, type Model } from "@earendil-works/pi-ai";

async run(input: AgentRunInput): Promise<AgentRunResult> {
  // Resolve model
  let model: Model | undefined;
  if (input.model) {
    const [provider, id] = input.model.split("/");
    model = getModel(provider as any, id);
  }

  const { session } = await createAgentSession({
    sessionManager: SessionManager.inMemory(),
    authStorage: AuthStorage.create(),
    modelRegistry: ModelRegistry.create(AuthStorage.create()),
    model,                                    // ← set model
    tools: input.tools as string[],           // ← set tools
    cwd: input.cwd,
  });
  // ...
}
```

Wait — `InteractiveMode` constructor takes `runtime` and initialMessage. The session is created inside InteractiveMode. We need to customize the session creation.

**Better approach:** Use `createAgentSessionRuntime` with a custom factory that applies tools and model:

```typescript
async run(input: AgentRunInput): Promise<AgentRunResult> {
  const services = await createAgentSessionServices({ cwd: input.cwd });

  // Resolve model
  let model: Model | undefined;
  if (input.model) {
    const [provider, id] = input.model.split("/");
    model = getModel(provider as any, id);
  }

  const sessionManager = SessionManager.create(input.cwd);

  const createRuntime: CreateAgentSessionRuntimeFactory = async ({
    cwd, sessionManager, sessionStartEvent,
  }) => {
    const result = await createAgentSessionFromServices({
      services,
      sessionManager,
      sessionStartEvent,
    });
    // Override tools and model on the created session
    if (input.tools.length > 0) {
      result.session.agent.state.tools = input.tools.map(name => ({
        name,
        // ...tool definitions would need to be resolved
      }));
    }
    if (model) {
      await result.session.setModel(model);
    }
    return { ...result, services, diagnostics: services.diagnostics };
  };

  const runtime = await createAgentSessionRuntime(createRuntime, {
    cwd: input.cwd,
    agentDir: getAgentDir(),
    sessionManager,
  });

  const mode = new InteractiveMode(runtime, {
    migratedProviders: [],
    modelFallbackMessage: undefined,
    initialMessage: input.prompt,
    initialImages: [],
    initialMessages: [],
  });

  await mode.run();
  // ...
}
```

### 2b. Handle user abort
`InteractiveMode.run()` doesn't throw on Ctrl+C — it resolves normally but the session may be empty. Detect this:

```typescript
await mode.run();

const messages = runtime.session.agent.state.messages;
if (messages.length === 0) {
  return {
    success: false,
    summary: "User aborted the session",
    expectedOutputs: [],
    error: "User aborted",
  };
}
```

### 2c. Extract shared summary utility

**File:** `src/runners/shared.ts` (NEW)

```typescript
import type { AgentMessage } from "@earendil-works/pi-agent-core";

export function extractSummary(messages: AgentMessage[]): string {
  const lastAssistant = [...messages].reverse().find(m => m.role === "assistant");
  if (!lastAssistant) return "Agent completed (no response)";

  const content = lastAssistant.content;
  if (!Array.isArray(content)) return "Agent completed";

  const textBlocks = content.filter(
    (c): c is { type: "text"; text: string } =>
      typeof c === "object" && c !== null && "type" in c && c.type === "text"
  );

  const combined = textBlocks.map(t => t.text).join("\n").trim();
  if (!combined) {
    const toolBlocks = content.filter(
      (c): c is { type: "tool_use"; name: string } =>
        typeof c === "object" && c !== null && "type" in c && c.type === "tool_use"
    );
    if (toolBlocks.length > 0) {
      return `Used tools: ${toolBlocks.map(t => t.name).join(", ")}`;
    }
    return "Agent completed";
  }

  return combined.length > 300 ? combined.slice(0, 297) + "..." : combined;
}
```

Update `PiSdkRunner` and `PiInteractiveRunner` to import from `./shared.ts`.

**Acceptance:** Manual test: `--runner pi-interactive` launches a full pi TUI with the correct tools and model. Ctrl+C returns cleanly. Agent output is summarized.

---

## Task 3: Productionize ClaudeCodeRunner

**Current issues:**
1. `--allowedTools` is a Claude Code flag but the exact flag name may differ
2. Doesn't map pi tool names to Claude Code tool names (pi uses `bash`, CC uses `Bash`)
3. No timeout support
4. `stdout` capture for summary is fragile (no structured output from CC)
5. No model override for `claude` CLI (CC uses its own model config)
6. Prompt passthrough via stdin may not work with all `claude` CLI modes

**File:** `src/runners/claude-code-runner.ts`

**Changes:**

### 3a. Tool name mapping
```typescript
const TOOL_MAP: Record<string, string> = {
  "read": "Read",
  "write": "Write",
  "edit": "Edit",
  "bash": "Bash",
  "grep": "Grep",
  "find": "Glob",       // Claude Code uses "Glob" for file search
  "ls": "LS",
  "web_search": "WebSearch",
  "web_fetch": "WebFetch",
};

function mapTools(tools: string[]): string[] {
  return tools
    .map(t => TOOL_MAP[t] ?? t)
    .filter(Boolean);
}
```

### 3b. Use --print mode correctly
```typescript
const args: string[] = [
  "-p",                    // --print (non-interactive, prints result and exits)
  "--output-format", "text",
  "--verbose",             // Include tool outputs in the result
];

// Allowed tools
const allowedTools = mapTools(input.tools);
if (allowedTools.length > 0) {
  args.push("--allowedTools", allowedTools.join(","));
}

// Model
if (input.model) {
  args.push("--model", input.model);
}
```

### 3c. Pass prompt via --prompt flag (not stdin)
Claude Code accepts prompts via `-p` for print mode:
```typescript
// Write prompt to a temp file (handles long prompts safely)
const tmpFile = path.join(os.tmpdir(), `pb-agent-${Date.now()}.md`);
fs.writeFileSync(tmpFile, input.prompt);

const child = spawn(this.claudePath, [...args, `@${tmpFile}`], {
  cwd: input.cwd,
  stdio: ["ignore", "pipe", "pipe"],
});
```

### 3d. Timeout support
```typescript
let timedOut = false;
const timer = this.options.timeout
  ? setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, this.options.timeout)
  : null;
```

### 3e. Summary extraction
Parse the last non-empty line of stdout as summary:
```typescript
const lines = stdout.trim().split("\n");
const lastLine = lines[lines.length - 1]?.trim();
const summary = lastLine && lastLine.length <= 300
  ? lastLine
  : `Claude Code completed (${stdout.length} chars output)`;
```

**Acceptance:** Integration test: `--runner claude-code` runs a simple prompt, captures stdout, reports success. Timeout kills process. Tool names mapped correctly.

---

## Task 4: Add runner configuration from environment

**Problem:** Each runner has different configuration needs (API keys, binary paths, timeout). These should be configurable via environment variables, not hardcoded.

**File:** `src/runners/config.ts` (NEW)

```typescript
// src/runners/config.ts
export interface RunnerEnv {
  // Pi SDK
  PI_CODING_AGENT_DIR?: string;
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;

  // Claude Code
  CLAUDE_CODE_PATH?: string;
  CLAUDE_CODE_TIMEOUT_MS?: string;

  // General
  AGENT_TIMEOUT_MS?: string;
}

export function loadRunnerEnv(): RunnerEnv {
  return {
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    CLAUDE_CODE_PATH: process.env.CLAUDE_CODE_PATH,
    CLAUDE_CODE_TIMEOUT_MS: process.env.CLAUDE_CODE_TIMEOUT_MS,
    AGENT_TIMEOUT_MS: process.env.AGENT_TIMEOUT_MS,
  };
}
```

Each runner reads from this in its constructor.

---

## Task 5: Runner registry for dynamic loading

**Goal:** Support custom runners loaded from user projects (like flow discovery). A project could have `.pi/project-builder/runners/my-runner.ts` that exports an `AgentRunner`.

**File:** `src/runners/registry.ts` (NEW)

```typescript
import type { AgentRunner } from "../orchestrator/ports.ts";
import { PiSdkRunner } from "./pi-sdk-runner.ts";
import { PiInteractiveRunner } from "./pi-interactive-runner.ts";
import { ClaudeCodeRunner } from "./claude-code-runner.ts";

type RunnerFactory = (options?: Record<string, unknown>) => AgentRunner;

const builtinRunners: Record<string, RunnerFactory> = {
  "pi-sdk": (opts) => new PiSdkRunner(opts as any),
  "pi-interactive": () => new PiInteractiveRunner(),
  "claude-code": (opts) => new ClaudeCodeRunner(opts as any),
};

export function getRunnerNames(): string[] {
  return Object.keys(builtinRunners);
}

export function isBuiltinRunner(name: string): boolean {
  return name in builtinRunners;
}

export function createRunner(
  name: string,
  authStorage: AuthStorage,
  modelRegistry: ModelRegistry,
  options?: Record<string, unknown>,
): AgentRunner {
  const factory = builtinRunners[name];
  if (!factory) {
    throw new Error(
      `Unknown runner "${name}". Available: ${getRunnerNames().join(", ")}`
    );
  }
  return factory({ authStorage, modelRegistry, ...options });
}
```

Update `src/cli/factory.ts` to use this registry instead of a switch statement.

**Acceptance:** `getRunnerNames()` returns `["pi-sdk", "pi-interactive", "claude-code"]`. `createRunner("pi-sdk", auth, registry)` returns PiSdkRunner. Unknown name throws.

---

## Task 6: Direct API runner (optional, P2)

**Stub for future:** `src/runners/direct-api-runner.ts`

A runner that calls Anthropic/OpenAI APIs directly without pi SDK. This enables running the flow orchestrator in environments where pi SDK can't be installed. Lower priority — implement only if needed.

---

## Prioritized task list

| Priority | Task | Effort | Depends on |
|----------|------|--------|------------|
| P0 | Task 1: Productionize PiSdkRunner | L | pi SDK types |
| P0 | Task 2: Productionize PiInteractiveRunner | L | pi SDK InteractiveMode |
| P1 | Task 3: Productionize ClaudeCodeRunner | M | `claude` CLI installed for testing |
| P1 | Task 4: Runner env config | S | none |
| P1 | Task 5: Runner registry | S | Tasks 1-3 |
| P2 | Task 6: Direct API runner | DEFERRED | — |

## Risks

1. **Pi SDK model resolution is complex.** `getModel(provider, id)` requires exact provider strings. If the user passes `--model anthropic/claude-sonnet-4-5` but the SDK expects `"anthropic"` → lowercase vs. `"Anthropic"` — need to test. Consider case-insensitive matching.

2. **InteractiveMode may have side effects** (modifying auth.json, writing sessions to disk). Test that it doesn't leave sessions behind or corrupt auth when used programmatically.

3. **Claude Code `claude` CLI may not be on PATH.** The runner should handle this gracefully with a clear error message: "Claude Code CLI not found. Install via `npm install -g @anthropic-ai/claude-code`."

4. **Tool name mapping for Claude Code is fragile.** Claude Code may add/rename tools. The mapping table must be maintained. Consider making it configurable.
