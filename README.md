# Project Builder v2 — Architecture Proposal

**A layered flow orchestration engine where agents are invoked programmatically via a swappable AgentRunner interface, rather than executed by an LLM supervisor inside a pi extension.**

Date: 2026-06-18

---

## Motivation

Project Builder v1 (current) runs inside pi as an extension. An LLM supervisor calls `flow_start` → `flow_step` → `flow_step_complete` → `flow_record_gate`, mediating every state transition. This works but has fundamental issues:

- The LLM supervisor costs tokens on every step (not doing useful work, just orchestrating)
- Gate handling requires ~200 lines of protocol instruction to prevent LLM mistakes (wrong nonce, fabricating answers, executing feedback as work orders)
- The LLM can skip steps, misread prompts, or hallucinate state transitions
- Flow control logic lives in prompt text, not code — impossible to unit test

**v2 flips this:** the flow orchestrator is pure TypeScript code. Agents are invoked via a swappable `AgentRunner` interface. Gates are direct UI prompts. The LLM only does useful work — it never mediates flow state.

---

## Architecture Sketch

```
┌──────────────────────────────────────────────────────────────┐
│                    FLOW ORCHESTRATOR                          │
│                    (orchestrator.ts)                          │
│                                                               │
│  "for each step: run agent → verify outputs → present gate   │
│   → advance or retry"                                        │
│                                                               │
│  Knows about: FlowDefinition, WorkflowState, Engine           │
│  Knows NOTHING about: pi SDK, Claude Code, CLI, Web UI       │
│                                                               │
│             │                  │                  │           │
│      AgentRunner          GatePresenter      OutputVerifier   │
│      (interface)          (interface)        (interface)      │
└─────────┼────────────────────┼───────────────────┼───────────┘
          │                    │                   │
    ┌─────┴──────────┐  ┌──────┴────────┐  ┌───────┴──────────┐
    │ LAYER 2        │  │ LAYER 3       │  │ LAYER 1 (trivial)│
    │ Agent Runners  │  │ Gate UIs      │  │ Filesystem check │
    └────────────────┘  └───────────────┘  └──────────────────┘
```

**Layers:**

| Layer | Role | Swappable |
|-------|------|-----------|
| **Orchestrator** | Pure logic: iterate steps, retry, gate, advance. Depends only on interfaces. | No — this IS project-builder |
| **AgentRunner** | Invoke an agent (LLM session) and return results | Yes — pi SDK, Claude Code, direct API, etc. |
| **GatePresenter** | Show approval dialog, collect user answer | Yes — Inquirer CLI, pi TUI, web dashboard, auto-approve (CI) |
| **OutputVerifier** | Check expected files exist after agent runs | Yes — filesystem, git diff, custom |
| **FlowProgress** | Report step start/end, gates, completion (observability) | Yes — console, Slack, noop |
| **Engine** | Pure state machine: createWorkflowState, startStep, applyStepResult, applyGateAnswer | Reused from v1 (transitions.ts, persistence.ts, agent-loader.ts) |

---

## Layer 1: Ports (stable contracts)

`src/orchestrator/ports.ts` — never changes when you swap implementations.

```typescript
export interface AgentRunInput {
  prompt: string;
  systemPrompt?: string;
  tools: string[];
  cwd: string;
  model?: string;
  contextFiles?: string[];
}

export interface AgentRunResult {
  success: boolean;
  summary: string;
  expectedOutputs: { path: string; exists: boolean }[];
  messages?: unknown[];
  error?: string;
}

export interface AgentRunner {
  readonly name: string;
  run(input: AgentRunInput): Promise<AgentRunResult>;
}

export interface GateInput {
  header: string;
  previewPath?: string;
  options: Array<{
    label: string;
    description: string;
    advance: boolean;
    abort?: boolean;
    feedback?: boolean;
  }>;
}

export interface GateAnswer {
  label: string;
  advance: boolean;
  abort?: boolean;
  feedback?: string;
}

export interface GatePresenter {
  readonly name: string;
  present(gate: GateInput, cwd: string): Promise<GateAnswer>;
}

export interface OutputVerifier {
  verify(expectedOutputs: string[], cwd: string): {
    allExist: boolean;
    missing: string[];
    existing: string[];
  };
}

export interface FlowProgress {
  onStepStart(step: { agent: string; index: number; attempt: number }): void;
  onStepEnd(step: { agent: string; index: number; result: AgentRunResult }): void;
  onGate(gate: GateInput): void;
  onFlowComplete(): void;
  onFlowBlocked(error: string): void;
}
```

---

## Layer 2: Orchestrator (pure logic)

`src/orchestrator/orchestrator.ts` — the engine. Does NOT import pi SDK, Inquirer, or any concrete implementation. Only imports the engine (transitions, persistence, agent-loader) and ports.

Main function: `runFlow(options: OrchestratorOptions): Promise<FlowOutcome>`

```
while steps remain:
  for attempt in 1..maxAttempts:
    mark step running
    → agentRunner.run(prompt)        // layer boundary
    if failed → retry or block
    → outputVerifier.verify(files)
    if missing → retry (strict) or warn
    if gate step:
      → gatePresenter.present(gate)  // layer boundary
      if approve → advance
      if reject → retry with feedback
      if abort → abandon
    else → advance
  persist workflow.json
→ done
```

---

## Layer 3a: Agent Runners

Swappable implementations of `AgentRunner`.

| Implementation | What it does |
|----------------|-------------|
| `PiSdkRunner` | Creates an `AgentSession` via pi SDK, streams output to stdout, waits for completion. Programmatic — no TUI. |
| `PiInteractiveRunner` | Hands control to pi's full interactive TUI (`InteractiveMode`). Human gets message queue, tree nav, model switching, compaction. |
| `ClaudeCodeRunner` | Spawns `claude` CLI process, pipes prompt, waits for exit. |
| `DirectApiRunner` | Direct Anthropic/OpenAI API calls. No pi dependency at all. |

To change agent backend: swap one import in `main.ts`.

---

## Layer 3b: Gate Presenters

Swappable implementations of `GatePresenter`.

| Implementation | What it does |
|----------------|-------------|
| `InquirerGatePresenter` | CLI prompts via Inquirer.js. Shows preview file, presents options, collects optional free-text feedback. |
| `PiTuiGatePresenter` | Uses pi's `ctx.ui.select` / `ctx.ui.input` when running inside a pi extension. |
| `AutoApproveGate` | Auto-approves every gate. For CI/CD pipelines. |
| `WebGatePresenter` | POSTs gate to a web dashboard, waits for WebSocket/SSE response. |

To change gate UX: swap one import in `main.ts`.

---

## Directory structure

```
project-builder-v2/
├── src/
│   ├── engine/                    # Reused from v1 (mostly unchanged)
│   │   ├── types.ts               #   FlowDefinition, WorkflowState, AgentManifest, etc.
│   │   ├── transitions.ts         #   Pure state machine
│   │   ├── persistence.ts         #   Atomic workflow.json read/write
│   │   └── agent-loader.ts        #   Parse agents/*.md → prompt + manifest
│   │
│   ├── orchestrator/
│   │   ├── ports.ts               # AgentRunner, GatePresenter, OutputVerifier, FlowProgress
│   │   └── orchestrator.ts        # runFlow() — pure logic, depends only on ports + engine
│   │
│   ├── runners/
│   │   ├── pi-sdk-runner.ts       # AgentRunner via createAgentSession()
│   │   ├── pi-interactive-runner.ts # AgentRunner via InteractiveMode (full TUI)
│   │   └── claude-code-runner.ts  # AgentRunner via `claude` CLI
│   │
│   ├── gates/
│   │   ├── inquirer-gate.ts       # GatePresenter via Inquirer.js CLI
│   │   ├── pi-tui-gate.ts         # GatePresenter via pi's ctx.ui
│   │   └── noop-gate.ts           # GatePresenter that auto-approves (CI)
│   │
│   ├── verifiers/
│   │   └── filesystem.ts          # OutputVerifier via fs.existsSync
│   │
│   ├── progress/
│   │   └── console.ts             # FlowProgress that logs to stdout
│   │
│   ├── flows/
│   │   └── builtin.ts             # FEATURE_BUILD_FLOW and other FlowDefinitions
│   │
│   └── main.ts                    # Entry point — wires implementations together
│
├── agents/                         # Agent .md manifests (reused from v1)
│   ├── spec-write.md
│   ├── plan.md
│   ├── implement.md
│   ├── review.md
│   ├── lint.md
│   ├── doc-sync.md
│   └── subagents/
│       ├── scout.md
│       ├── worker.md
│       └── reviewer.md
│
├── test/
│   ├── orchestrator.test.ts       # Unit tests for runFlow with mock AgentRunner/GatePresenter
│   ├── transitions.test.ts        # Reused from v1
│   └── agent-loader.test.ts       # Reused from v1
│
├── package.json
└── tsconfig.json
```

---

## What disappears from v1

These exist solely to control an LLM supervisor. They vanish in v2:

| v1 artifact | Why it's gone |
|-------------|---------------|
| `APPROVAL_INSTRUCTION` (200+ lines) | No LLM to teach the gate protocol |
| `SUPPRESS_SUBAGENT_PROGRESS` | No LLM calling the subagent tool |
| `completionSuffix` | No need to tell the LLM to stop |
| `workspacePrefix` / `previousStepsDigest` | Now assembled by the orchestrator, not injected into an LLM prompt |
| Gate nonce system (`crypto.randomUUID()`) | No LLM to fabricate answers — gate is a direct function call |
| `checkGateBlock()` | No LLM to do work between gate presentation and recording |
| `ALLOWED_DURING_GATE` set | Same reason |
| `src/ui/` (tools.ts, commands.ts, engine-context.ts, step-summary-widget.ts) | No pi extension layer — replaced by direct SDK calls |
| 9 `flow_*` pi custom tools | Replaced by direct engine API calls |

**Net reduction: ~800+ lines of LLM-control machinery.**

---

## What stays from v1 (reused as-is)

| v1 artifact | Why it stays |
|-------------|-------------|
| `types.ts` — all type definitions | Same FlowDefinition, WorkflowState, AgentManifest, etc. |
| `transitions.ts` — pure state machine | Same state transitions, now called directly from orchestrator |
| `persistence.ts` — atomic workflow.json I/O | Same persistence needs |
| `agent-loader.ts` — parse .md → AgentManifest + prompt | Same parsing, slightly different prompt assembly |
| `agents/*.md` — all agent manifests | Same prompts, same approval dialogs |
| `flows/index.ts` — FlowDefinitions | Same flow definitions |
| `frontmatter.ts` — YAML frontmatter parser | Same parsing |
| `project-rules.ts` — AGENTS.md discovery | Same project context discovery |

---

## Key constraints to enforce in implementation

1. **Orchestrator never imports concrete implementations.** Only `ports.ts`, `engine/*`, and `node:path`.
2. **AgentRunner implementations MUST handle their own session lifecycle.** Create, run, dispose. No leaking state.
3. **GatePresenter implementations MUST block until answered.** No callbacks or event-based gates — the orchestrator does `await gatePresenter.present(...)`.
4. **Output verification happens AFTER agent completion, BEFORE gate.** So the human sees a gate with the actual output file available.
5. **Engine state is persisted at every transition.** If the process crashes, resume from workflow.json.
6. **Agent .md files remain the single source of truth** for prompts, tools, subagents, and approval dialogs. No hardcoded agent behavior in the orchestrator.
