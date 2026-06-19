# Implementation Plan: ENGINE Layer

Date: 2026-06-18
Architecture reference: `/Users/gabrielxavier/Documents/project-builder-v2/README.md`
Gate fix reference: `/Users/gabrielxavier/Documents/project-builder-v2/docs/gate-bug-decision.md` (Option A — proper gateLoader closure)
Orchestrator reference: `/Users/gabrielxavier/Documents/project-builder-v2/plans/orchestrator-plan.md`

---

## Goal

Create the `src/engine/` directory that provides the foundation layer for all other v2 modules. It copies (forks) the v1 pure-function engine modules and adds ONE new file — `prompt-builder.ts` — that extracts prompt assembly logic from v1's `engine.ts::step()` and removes the LLM-protocol-specific instructions no longer needed in v2.

Every other v2 module (`orchestrator.ts`, `flows/builtin.ts`, `main.ts`) imports from `src/engine/`. None of them compile until this layer exists.

---

## Architecture: Copy, don't depend

### Decision: Fork the engine, don't re-export

v2 imports from `../engine/types.ts`, `../engine/transitions.ts`, etc. — these are relative imports within the v2 source tree. We need actual files at those paths.

**Option considered:** Thin re-export shims that import from v1's install path (`/Users/gabrielxavier/.pi/agent/extensions/project-builder/src/`).

**Rejected because:**
- v1's install path is not guaranteed (different machines, pi package updates)
- v1 is not an npm dependency of v2 (it's a pi extension, package.json name: `pi-project-builder`)
- Fragile to filesystem layout changes

**Chosen:** Copy the following v1 files into `src/engine/`:

| v1 source | v2 destination | Reason |
|-----------|---------------|--------|
| `src/shared/types.ts` | `src/engine/types.ts` | All type definitions — unchanged |
| `src/engine/transitions.ts` | `src/engine/transitions.ts` | Pure state machine — unchanged |
| `src/shared/persistence.ts` | `src/engine/persistence.ts` | Atomic I/O — unchanged |
| `src/engine/agent-loader.ts` | `src/engine/agent-loader.ts` | .md manifest parser — unchanged |
| `src/shared/frontmatter.ts` | `src/engine/frontmatter.ts` | YAML parser (dep of agent-loader) — unchanged |
| `src/engine/project-rules.ts` | `src/engine/project-rules.ts` | AGENTS.md discovery — unchanged |

**All six files are copied verbatim.** No modifications to v1 source. Cherry-pick v1 bugfixes into these copies.

**NEW file:** `src/engine/prompt-builder.ts` — extracted from v1's `engine.ts::step()` inline logic.

**Barrel file:** `src/engine/index.ts` — re-exports everything so the orchestrator can `import { ... } from "../engine"`.

---

## File: `src/engine/types.ts` (COPY — no changes)

**Source:** `/Users/gabrielxavier/.pi/agent/extensions/project-builder/src/shared/types.ts`

**Copy command:**
```bash
cp /Users/gabrielxavier/.pi/agent/extensions/project-builder/src/shared/types.ts \
   /Users/gabrielxavier/Documents/project-builder-v2/src/engine/types.ts
```

**Exports (partial list — everything in the source):**
- `FlowStep` — a single step in a flow
- `FlowDefinition` — ordered list of steps + metadata
- `AgentTool` — union type of valid tool names
- `AgentManifest` — parsed frontmatter from agent .md
- `ApprovalOption`, `ApprovalManifest` — gate dialog definitions
- `StepResult` — success/error submitted by supervisor
- `WorkflowStepActivity`, `WorkflowStepUpdate` — incremental activity
- `StepStatus`, `WorkflowStatus`, `AwaitingState` — state enums
- `WorkflowStep` — per-step state within a workflow run
- `WorkflowGate` — gate state when awaiting user approval
- `WorkflowState` — full run state persisted to workflow.json
- `StepInstruction` — what the engine returns to supervisor (v1 only, unused in v2 but kept for type completeness)
- `GateAnswer` — user's answer to an approval gate
- `SCHEMA_VERSION`, `DEFAULT_ATTEMPTS`, `WORKFLOW_FILE`, `TEMP_DIR` — constants

**Import path fix:** V1's `persistence.ts` imports from `"./types.ts"`. Same relative path in v2 — no change needed. V1's `transitions.ts` imports from `"../shared/types.ts"` — needs to change to `"./types.ts"`.

**⚠️ CRITICAL: Fix import paths.** The v1 source files use `"../shared/types.ts"` and `"../engine/something.ts"` paths. After copying into v2's flat `src/engine/` directory, these need updating. See Task 2.

---

## File: `src/engine/transitions.ts` (COPY — import paths fixed)

**Source:** `/Users/gabrielxavier/.pi/agent/extensions/project-builder/src/engine/transitions.ts`

**Import path changes needed:**

| v1 import | v2 replacement |
|-----------|---------------|
| `from "../shared/types.ts"` | `from "./types.ts"` |

**Exports:**
- `createWorkflowState(flow, feature, featurePath, projectRoot, serviceDirs?, featureContext?, projectRulesContext?) → WorkflowState`
- `startStep(state) → WorkflowState`
- `updateStepActivity(state, update) → { state, error? }`
- `applyStepResult(state, result, loadGate) → StepTransition`
- `applyGateAnswer(state, answer) → GateTransition`
- `currentStep(state) → FlowStep | null`
- `currentWorkflowStep(state) → WorkflowStep | null`

**Used by:** `orchestrator.ts` (all of the above), `flows-main-plan.md`'s resume logic.

**⚠️ Verification:** The orchestrator calls `applyStepResult(state, { result: "success", message }, gateLoader)` where `gateLoader` is defined as per `docs/gate-bug-decision.md` Option A. This works ONLY IF `transitions.ts` is copied without modification — its gate-creation logic at lines ~203-209 does the right thing when `loadGate` returns a real `WorkflowGate`.

---

## File: `src/engine/persistence.ts` (COPY — import paths fixed)

**Source:** `/Users/gabrielxavier/.pi/agent/extensions/project-builder/src/shared/persistence.ts`

**Import path changes needed:**

| v1 import | v2 replacement |
|-----------|---------------|
| `from "./types.ts"` | keep — same relative path |

**Exports:**
- `resolveFeaturePath(name, projectRoot?) → string`
- `getWorkflowDir(projectRoot, featurePath) → string`
- `getWorkflowPath(projectRoot, featurePath) → string`
- `readWorkflow(projectRoot, featurePath) → WorkflowState | null`
- `writeWorkflow(projectRoot, featurePath, state) → void`
- `listWorkflows(projectRoot) → string[]`
- `findActiveWorkflows(projectRoot) → Array<{ featurePath, state }>`
- `findActiveWorkflow(projectRoot) → { featurePath, state } | null`
- `resolveWorkflow(projectRoot, featurePath?) → { featurePath, state } | null`
- `cleanupWorkflows(projectRoot, olderThanDays) → string[]`

**⚠️ Name mismatch:** The orchestrator skeleton imports `resolveWorkflowDir` but v1 exports `getWorkflowDir`. Fix the orchestrator import or add an alias in `index.ts`:

```typescript
// index.ts barrel — alias fix
export { getWorkflowDir as resolveWorkflowDir } from "./persistence.ts";
```

---

## File: `src/engine/agent-loader.ts` (COPY — import paths fixed)

**Source:** `/Users/gabrielxavier/.pi/agent/extensions/project-builder/src/engine/agent-loader.ts`

**Import path changes needed:**

| v1 import | v2 replacement |
|-----------|---------------|
| `from "../shared/frontmatter.ts"` | `from "./frontmatter.ts"` |
| `from "../shared/types.ts"` | `from "./types.ts"` |

**Exports:**
- `loadAgent(agentsDir, agentId, isSubagent?) → LoadedAgent`
- `loadFlowAgents(agentsDir, flow) → Map<string, LoadedAgent>`
- `validateFlowApproval(agentsDir, flow) → void`
- `buildGate(manifest, stepIndex, nonce) → WorkflowGate | null`
- `LoadedAgent` — interface (manifest + prompt + isSubagent)

**Used by:** `orchestrator.ts` (`loadAgent`, `buildGate`), `main.ts` (`validateFlowApproval` for flow validation).

**CRITICAL for gate fix:** `buildGate` is imported by the orchestrator for the gateLoader closure (Option A in gate-bug-decision.md). This export MUST be preserved.

---

## File: `src/engine/frontmatter.ts` (COPY — no path changes)

**Source:** `/Users/gabrielxavier/.pi/agent/extensions/project-builder/src/shared/frontmatter.ts`

**Exports:**
- `parseFrontmatter(content) → ParsedFrontmatter`
- `parseArrayValue(raw, fieldName) → string[]`
- `parseRecordValue(raw, fieldName) → Record<string, string>`

Internal dependency of `agent-loader.ts`. Not imported directly by the orchestrator.

---

## File: `src/engine/project-rules.ts` (COPY — no path changes)

**Source:** `/Users/gabrielxavier/.pi/agent/extensions/project-builder/src/engine/project-rules.ts`

**Exports:**
- `discoverProjectRules(projectRoot) → string | undefined`

Used by `prompt-builder.ts` (for `buildSystemPrefix`). Not imported directly by the orchestrator — it's called inside `prompt-builder.ts`.

---

## File: `src/engine/prompt-builder.ts` (NEW — extracted from v1 engine.ts)

This is the ONLY genuinely new file in the engine layer. It extracts three helper functions that lived inline in v1's `engine.ts::step()` and removes the LLM-protocol-specific instructions.

### Source extraction map

| Function | Source in v1 `engine.ts` | v2 treatment |
|----------|--------------------------|--------------|
| `workspacePrefix(featurePath, featureContext?, projectRulesContext?)` | Lines ~58-80 | **KEEP** — unchanged |
| `previousStepsDigest(state)` | Lines ~121-141 | **KEEP** — unchanged |
| `completionSuffix(strictOutputs)` | Lines ~143-155 | **KEEP** — unchanged |
| `APPROVAL_INSTRUCTION` | Lines ~157-215 (~58 lines) | **REMOVED** — gates handled by orchestrator, not LLM |
| `SUBAGENT_COMPLETION_SUFFIX` | Lines ~217-220 | **REMOVED** — subagents invoked by AgentRunner, not LLM subagent tool |
| `SUPPRESS_SUBAGENT_PROGRESS` | Lines ~222-240 (~19 lines) | **REMOVED** — no LLM calling subagent tool with output/progress params |

### What prompt-builder.ts exports

```typescript
/**
 * Build the system-level prompt prefix.
 *
 * Contains workspace rules, project context (AGENTS.md), and feature context.
 * This goes into the system prompt of the agent session — stable across
 * the session, not part of the task-specific user message.
 *
 * Extracted from v1 engine.ts workspacePrefix().
 */
export function buildSystemPrefix(state: WorkflowState): string;

/**
 * Build the task-specific prompt for an agent.
 *
 * Contains previous steps digest, the agent's instructions (from .md body),
 * and the completion suffix telling the agent to stop when done.
 *
 * Extracted from v1 engine.ts previousStepsDigest() + completionSuffix().
 */
export function buildPrompt(agent: LoadedAgent, state: WorkflowState): string;
```

### Implementation

```typescript
// src/engine/prompt-builder.ts

import type { WorkflowState } from "./types.ts";
import type { LoadedAgent } from "./agent-loader.ts";

// ============================================================================
// buildSystemPrefix — workspace + project rules + feature context
// ============================================================================

/**
 * Build the system prompt prefix injected at the top of every agent session.
 *
 * Contains:
 * - Workspace output directory instructions
 * - Project rules (AGENTS.md content, auto-discovered)
 * - Feature context (user's description of what they want to build)
 *
 * This is stable across the session — use as the system prompt.
 */
export function buildSystemPrefix(state: WorkflowState): string {
  return workspacePrefix(
    state.feature_path,
    state.feature_context,
    state.project_rules_context,
  );
}

// ============================================================================
// buildPrompt — previous steps + agent instructions + completion
// ============================================================================

/**
 * Build the task-specific prompt for an agent step.
 *
 * Contains:
 * - Previous steps digest (summaries, so agents don't re-read all files)
 * - Agent's instructions (body of the .md file)
 * - Completion suffix (tell the agent to stop when done)
 *
 * This goes into the user message of the agent session.
 *
 * DOES NOT INCLUDE:
 * - APPROVAL_INSTRUCTION (gates handled by orchestrator, not LLM protocol)
 * - SUPPRESS_SUBAGENT_PROGRESS (subagents invoked via AgentRunner, not LLM tool)
 * - SUBAGENT_COMPLETION_SUFFIX (subagents return to orchestrator, not LLM)
 */
export function buildPrompt(agent: LoadedAgent, state: WorkflowState): string {
  return [
    previousStepsDigest(state),
    agent.prompt,
    completionSuffix(state.flow_snapshot.strictOutputs ?? true),
  ]
    .filter(Boolean)
    .join("\n\n");
}

// ============================================================================
// Internal — extracted verbatim from v1 engine.ts
// ============================================================================

function workspacePrefix(
  featurePath: string,
  featureContext?: string,
  projectRulesContext?: string,
): string {
  let prefix =
    "## Workspace\n\n" +
    "Your declared output files MUST be written to .temp/" +
    featurePath +
    "/. " +
    "Always write .temp/" +
    featurePath +
    "/plan.md, NOT plan.md. " +
    "If the instructions below explicitly tell you to write files directly to the project tree, follow those instructions.\n";

  if (projectRulesContext) {
    prefix +=
      "\n## Project Rules\n\n" +
      "The following rules, conventions, and architectural constraints were " +
      "discovered from the project. Follow them for every change you make.\n\n" +
      projectRulesContext +
      "\n";
  }

  if (featureContext) {
    prefix +=
      "\n## Feature Context\n\n" +
      "The user provided this description of what they want to build:\n\n" +
      featureContext +
      "\n";
  }

  return prefix;
}

function previousStepsDigest(state: WorkflowState): string {
  const completed = state.steps.filter(
    (s) => s.status === "completed" && s.activity?.message,
  );
  if (completed.length === 0) return "";

  const lines: string[] = [
    "## Previous Steps\n",
    "These steps have already been completed. The summaries below provide enough " +
      "context that you do NOT need to read their output files unless you need " +
      "specific details beyond what is summarized here.\n",
  ];

  for (const step of completed) {
    const msg = step.activity!.message!;
    const short = msg.length > 300 ? msg.slice(0, 297) + "..." : msg;
    lines.push("- **" + step.agent + "** (completed): " + short);
  }

  return lines.join("\n") + "\n";
}

function completionSuffix(strictOutputs: boolean): string {
  const blockMsg = strictOutputs
    ? "If you do not write them, the workflow will block."
    : "If you do not write them, warnings will appear when you complete the step.";

  return (
    "\n\n## Important\n\n" +
    "Follow the instructions above carefully. Do not skip steps or complete this step " +
    "without doing the work described. The workflow expects the declared output files " +
    "to exist. " +
    blockMsg +
    "\n\n" +
    "## Completion\n\n" +
    "When you have finished all the work described above, stop. " +
    "Do not ask what to do next. Do not offer to continue. " +
    "The workflow will advance automatically."
  );
}
```

### What was stripped and why

| v1 artifact | Lines | Why removed |
|-------------|-------|-------------|
| `APPROVAL_INSTRUCTION` | ~58 | Teaches LLM the `flow_continue → ask_user_question → flow_record_gate` gate protocol. In v2, gates are presented directly by `GatePresenter` — no LLM protocol to teach. |
| `SUPPRESS_SUBAGENT_PROGRESS` | ~19 | Tells LLM not to set `output`/`progress` on the `subagent` tool. In v2, subagents are invoked by `AgentRunner` (pi SDK sessions), not via the LLM's `subagent` tool. |
| `SUBAGENT_COMPLETION_SUFFIX` | ~4 | Tells subagent LLMs to "return results to the orchestrator." In v2, subagents return via `AgentRunResult` from the `AgentRunner` interface — no LLM involved. |

**Net reduction: ~81 lines removed from v1's prompt assembly.**

---

## File: `src/engine/index.ts` (NEW — barrel export)

```typescript
/**
 * Engine Barrel Export
 *
 * Single import for the orchestrator:
 *   import { loadAgent, buildPrompt, buildSystemPrefix, ... } from "../engine";
 */

// ── Types ────────────────────────────────────────────────────
export type {
  FlowDefinition,
  FlowStep,
  WorkflowState,
  WorkflowStep,
  WorkflowStatus,
  StepStatus,
  StepResult,
  GateAnswer,
  AgentManifest,
  AgentTool,
  ApprovalManifest,
  ApprovalOption,
  WorkflowGate,
  WorkflowStepUpdate,
  StepInstruction,
} from "./types.ts";

// ── Constants ────────────────────────────────────────────────
export {
  SCHEMA_VERSION,
  DEFAULT_ATTEMPTS,
  WORKFLOW_FILE,
  TEMP_DIR,
} from "./types.ts";

// ── State Machine ────────────────────────────────────────────
export {
  createWorkflowState,
  startStep,
  applyStepResult,
  applyGateAnswer,
  updateStepActivity,
  currentStep,
  currentWorkflowStep,
} from "./transitions.ts";
export type { StepTransition, GateTransition } from "./transitions.ts";

// ── Persistence ──────────────────────────────────────────────
export {
  resolveFeaturePath,
  getWorkflowDir,
  getWorkflowPath,
  readWorkflow,
  writeWorkflow,
  listWorkflows,
  findActiveWorkflows,
  findActiveWorkflow,
  resolveWorkflow,
  cleanupWorkflows,
} from "./persistence.ts";
// Alias: orchestrator imports resolveWorkflowDir, v1 exports getWorkflowDir
export { getWorkflowDir as resolveWorkflowDir } from "./persistence.ts";

// ── Agent Loading ────────────────────────────────────────────
export {
  loadAgent,
  loadFlowAgents,
  validateFlowApproval,
  buildGate,
} from "./agent-loader.ts";
export type { LoadedAgent } from "./agent-loader.ts";

// ── Prompt Assembly (NEW in v2) ──────────────────────────────
export { buildPrompt, buildSystemPrefix } from "./prompt-builder.ts";
```

---

## How this enables everything else to compile

### Dependency chain

```
engine/types.ts ──────────────────────────────────────────────────────────────┐
engine/frontmatter.ts                                                         │
engine/project-rules.ts                                                       │
                                                                              │
engine/transitions.ts ──► imports: ./types.ts                                │
engine/persistence.ts ──► imports: ./types.ts                                │
engine/agent-loader.ts ─► imports: ./types.ts, ./frontmatter.ts              │
engine/prompt-builder.ts ► imports: ./types.ts, ./agent-loader.ts            │
engine/index.ts ────────► re-exports: all of the above                       │
                                                                              │
orchestrator/ports.ts ──► zero deps (standalone interfaces)                  │
orchestrator/orchestrator.ts ► imports: ../engine (index.ts), ./ports.ts     │
                                                                              │
flows/builtin.ts ───────► imports: ../engine/types.ts                        │
runners/*.ts ───────────► imports: ../orchestrator/ports.ts                  │
gates/*.ts ─────────────► imports: ../orchestrator/ports.ts                  │
verifiers/*.ts ─────────► imports: ../orchestrator/ports.ts                  │
progress/*.ts ──────────► imports: ../orchestrator/ports.ts                  │
main.ts ────────────────► imports: ./orchestrator/*, ./runners/*, ./gates/*, etc. │
```

**Once `src/engine/` exists, everything compiles.** Every other layer depends on `ports.ts` (already done) OR `engine/*` (this plan). No circular dependencies.

---

## Unit test plan

### Test file: `test/engine/prompt-builder.test.ts`

```typescript
import { describe, it } from "node:test";
import assert from "node:assert";
import { buildPrompt, buildSystemPrefix } from "../../src/engine/prompt-builder.ts";
import type { WorkflowState, AgentManifest, LoadedAgent } from "../../src/engine/types.ts";

describe("prompt-builder", () => {
  // ── buildSystemPrefix ──────────────────────────────────────

  it("includes workspace path instruction", () => {
    const state = makeState({ feature_path: "18-06-2026-user-auth" });
    const result = buildSystemPrefix(state);
    assert.match(result, /write files.*\.temp\/18-06-2026-user-auth/);
  });

  it("includes project rules when present", () => {
    const state = makeState({ project_rules_context: "## Rules\n\n- Use tabs" });
    const result = buildSystemPrefix(state);
    assert.match(result, /Project Rules/);
    assert.match(result, /Use tabs/);
  });

  it("includes feature context when present", () => {
    const state = makeState({ feature_context: "Build OAuth2 login" });
    const result = buildSystemPrefix(state);
    assert.match(result, /Feature Context/);
    assert.match(result, /OAuth2 login/);
  });

  it("does NOT include feature context section when absent", () => {
    const state = makeState({ feature_context: undefined });
    const result = buildSystemPrefix(state);
    assert.doesNotMatch(result, /Feature Context/);
  });

  // ── buildPrompt ────────────────────────────────────────────

  it("includes agent prompt body", () => {
    const agent = makeAgent({ prompt: "# Spec Write\n\nYou are the spec-write agent." });
    const state = makeState({});
    const result = buildPrompt(agent, state);
    assert.match(result, /spec-write agent/);
  });

  it("includes previous steps digest when there are completed steps", () => {
    const state = makeState({
      steps: [
        { status: "completed", agent: "plan", activity: { message: "Plan created", updated_at: "" } },
      ],
    });
    const agent = makeAgent({ prompt: "do stuff" });
    const result = buildPrompt(agent, state);
    assert.match(result, /Previous Steps/);
    assert.match(result, /plan.*completed.*Plan created/);
  });

  it("omits previous steps digest when no completed steps", () => {
    const state = makeState({ steps: [] });
    const agent = makeAgent({ prompt: "do stuff" });
    const result = buildPrompt(agent, state);
    assert.doesNotMatch(result, /Previous Steps/);
  });

  it("truncates long step activity messages", () => {
    const longMsg = "a".repeat(500);
    const state = makeState({
      steps: [{ status: "completed", agent: "spec-write", activity: { message: longMsg, updated_at: "" } }],
    });
    const agent = makeAgent({ prompt: "do stuff" });
    const result = buildPrompt(agent, state);
    assert.match(result, /\.\.\./); // truncated marker
    assert.ok(result.length < longMsg.length + 200); // much shorter
  });

  it("includes completion suffix with strict outputs message", () => {
    const state = makeState({ flow_snapshot: { strictOutputs: true } });
    const agent = makeAgent({ prompt: "do stuff" });
    const result = buildPrompt(agent, state);
    assert.match(result, /workflow will block/);
    assert.match(result, /Do not ask what to do next/);
  });

  it("includes completion suffix with non-strict message", () => {
    const state = makeState({ flow_snapshot: { strictOutputs: false } });
    const agent = makeAgent({ prompt: "do stuff" });
    const result = buildPrompt(agent, state);
    assert.match(result, /warnings will appear/);
  });

  // ── REMOVALS (regression checks) ───────────────────────────

  it("does NOT include APPROVAL_INSTRUCTION gate protocol text", () => {
    const state = makeState({});
    const agent = makeAgent({ prompt: "do stuff" });
    const result = buildPrompt(agent, state);
    assert.doesNotMatch(result, /flow_continue/);
    assert.doesNotMatch(result, /flow_record_gate/);
    assert.doesNotMatch(result, /gate nonce/);
    assert.doesNotMatch(result, /flow_step_complete/);
  });

  it("does NOT include SUPPRESS_SUBAGENT_PROGRESS", () => {
    const state = makeState({});
    const agent = makeAgent({ prompt: "do stuff" });
    const result = buildPrompt(agent, state);
    assert.doesNotMatch(result, /Subagent Behavior/);
    assert.doesNotMatch(result, /includeProgress: true/);
  });

  it("does NOT include SUBAGENT_COMPLETION_SUFFIX", () => {
    const state = makeState({});
    const agent = makeAgent({ prompt: "do stuff" });
    const result = buildPrompt(agent, state);
    assert.doesNotMatch(result, /Return your results to the orchestrator/);
  });
});

// ── Test helpers ─────────────────────────────────────────────

function makeState(overrides: Partial<WorkflowState>): WorkflowState {
  return {
    schema_version: 1,
    feature: "test-feature",
    feature_path: "18-06-2026-test-feature",
    project_root: "/tmp/test",
    flow_id: "test-flow",
    flow_version: 1,
    flow_snapshot: {
      id: "test-flow",
      version: 1,
      description: "test",
      steps: [],
      strictOutputs: true,
      ...overrides.flow_snapshot,
    },
    current_step_index: 0,
    status: "in_progress",
    awaiting: null,
    steps: overrides.steps ?? [],
    ...overrides,
  };
}

function makeAgent(overrides: Partial<LoadedAgent>): LoadedAgent {
  return {
    manifest: {
      id: "test-agent",
      version: 1,
      tools: ["read", "write"],
    } as AgentManifest,
    prompt: "",
    isSubagent: false,
    ...overrides,
  };
}
```

**11 test cases**, all pure functions — no I/O, no mocking needed. Run with `node --test --experimental-strip-types test/engine/prompt-builder.test.ts`.

---

## Prioritized task list

| Priority | Task | Effort | Depends on |
|----------|------|--------|------------|
| **P0** | 1. Create `src/engine/` directory | Instant | — |
| **P0** | 2. Copy 6 v1 files, fix import paths | 20 min | Task 1 |
| **P0** | 3. Create `prompt-builder.ts` with `buildPrompt` and `buildSystemPrefix` | 15 min | Task 2 |
| **P0** | 4. Create `index.ts` barrel export with all re-exports + aliases | 10 min | Tasks 2, 3 |
| **P0** | 5. Verify orchestrator compiles (`import { ... } from "../engine"`) | 5 min | Task 4 |
| **P0** | 6. Write `prompt-builder.test.ts` (11 test cases) | 20 min | Task 3 |
| **P1** | 7. Run v1's existing unit tests against copied files (regression check) | 10 min | Task 2 |
| **P1** | 8. Run v2 type-check across all layers | 5 min | Task 5 |
| **P2** | 9. Document import path mapping for future v1→v2 cherry-picks | 10 min | — |

**Total P0 effort: ~70 minutes.** After Task 5, every other v2 layer compiles.

---

## Import path mapping (Task 2 detail)

When copying v1 source files, every `from "..."` import referencing v1 paths must be updated:

### `types.ts`
- No imports from other project files (only imports from typebox and node builtins) — **no changes needed.**

### `transitions.ts`
- `from "../shared/types.ts"` → `from "./types.ts"`
- No other imports — **1 line change.**

### `persistence.ts`
- `from "./types.ts"` — same relative path, **no change.**

### `agent-loader.ts`
- `from "../shared/frontmatter.ts"` → `from "./frontmatter.ts"`
- `from "../shared/types.ts"` → `from "./types.ts"`
- **2 line changes.**

### `frontmatter.ts`
- No imports from other project files — **no changes needed.**

### `project-rules.ts`
- No imports from other project files — **no changes needed.**

**Total: 3 import path fixes across 6 files.** Trivial — no logic changes.

---

## Potential runtime issue: workspace output path

v1's `workspacePrefix` uses `featurePath` as the output directory. In v1, this is computed by `resolveFeaturePath(featureName, projectRoot)` inside `engine.start()`. In v2, the orchestrator calls `resolveFeaturePath` and passes it to `createWorkflowState`, which stores it in `state.feature_path`. `buildSystemPrefix` reads it from there.

**Verification:** The orchestrator calls:
```typescript
const featurePath = resolveFeaturePath(featureName, projectRoot);
let state = createWorkflowState(flow, featureName, featurePath, projectRoot, ...);
```

Then later calls:
```typescript
buildSystemPrefix(state)  // → reads state.feature_path
```

This works because `createWorkflowState` stores `featurePath` as `state.feature_path`. The mapping is correct. **No issue.**

---

## Cross-references

- **gate-bug-decision.md** — requires `buildGate` export from agent-loader.ts (preserved in this plan)
- **orchestrator-plan.md Tasks 1, 2, 3** — all depend on this engine layer existing
- **flows-main-plan.md Task 1** — imports `FlowDefinition` from engine/types.ts
- **gates-plan.md** — gate state machine fix assumes Option A (gateLoader closure using `buildGate`)
- **runners-plan.md** — `PiSdkRunner` receives `prompt` and `systemPrompt` from `buildPrompt`/`buildSystemPrefix`
