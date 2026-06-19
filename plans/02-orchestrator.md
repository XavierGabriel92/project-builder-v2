# Implementation Plan: ORCHESTRATOR Layer

Date: 2026-06-18
Architecture reference: `/Users/gabrielxavier/Documents/project-builder-v2/README.md`

---

## Goal

Implement the core `runFlow()` loop that iterates through flow steps, invokes agents via `AgentRunner`, verifies outputs, presents gates, and handles retries/blocks/abandon — all without importing any concrete implementation.

---

## Current state

`src/orchestrator/orchestrator.ts` exists as a skeleton. It has `runFlow()` and `executeStep()` with the correct structure but uses stub engine functions (`loadAgent`, `buildPrompt`, `buildSystemPrefix`, `noopLoadGate`) that don't yet exist. It also makes assumptions about how the engine handles gate state that need reconciliation with the v1 engine.

`src/orchestrator/ports.ts` exists and is complete — no changes needed.

---

## Task 1: Reconcile orchestrator with v1 engine API

**Problem:** The orchestrator currently calls engine functions directly (`loadAgent`, `buildPrompt`, `buildSystemPrefix`) that don't exist in v1's `engine.ts`. In v1, prompt assembly happens inside `engine.step()` which also returns a `StepInstruction`. In v2, we don't need `StepInstruction` — we assemble the prompt ourselves and pass it to `AgentRunner.run()`.

**What v1 engine.ts provides:**
```typescript
// v1 engine.ts exports:
start(flow, featureName, projectRoot, options) → StartResult
step(projectRoot, options) → StepInstruction | null     // Returns assembled prompt
stepComplete(result, projectRoot, options) → StepCompleteResult
stepUpdate(update, projectRoot, featurePath?) → StepUpdateResult
recordGate(answer, projectRoot, featurePath?) → GateResult
status(projectRoot, featurePath?) → WorkflowState
list(projectRoot) → string[]
abort(projectRoot, featurePath?) → WorkflowState
validateFlows(flows, agentsDir) → void
```

**What v2 orchestrator needs from the engine:**
```typescript
// Transitions (pure state machine):
createWorkflowState(flow, feature, featurePath, projectRoot, ...) → WorkflowState
startStep(state) → WorkflowState
applyStepResult(state, result, loadGate) → StepTransition
applyGateAnswer(state, answer) → GateTransition
currentStep(state) → FlowStep | null
currentWorkflowStep(state) → WorkflowStep | null

// Persistence:
resolveFeaturePath(name, projectRoot) → string
resolveWorkflowDir(projectRoot, featurePath) → string
writeWorkflow(projectRoot, featurePath, state) → void
readWorkflow(projectRoot, featurePath) → WorkflowState | null

// Agent loading:
loadAgent(agentsDir, agentId, isSubagent?) → LoadedAgent

// Prompt assembly (NEW — extracted from v1's engine.step()):
assembleAgentPrompt(agent: LoadedAgent, state: WorkflowState, workflowDir: string) → string
```

**Action:** Create an `src/engine/` directory that re-exports from v1's engine but adds the prompt assembly function. Specifically:

**File:** `src/engine/prompt-assembly.ts` (NEW)

```typescript
// Extracted from v1 engine.ts workspacePrefix + previousStepsDigest + completionSuffix
// but WITHOUT APPROVAL_INSTRUCTION and SUPPRESS_SUBAGENT_PROGRESS
export function assembleAgentPrompt(
  agent: LoadedAgent,
  state: WorkflowState,
  workflowDir: string
): string {
  return [
    workspacePrefix(state.feature_path, state.feature_context, state.project_rules_context),
    previousStepsDigest(state),
    agent.prompt,
    // NO APPROVAL_INSTRUCTION (gates handled by orchestrator)
    // NO SUPPRESS_SUBAGENT_PROGRESS (subagents handled by agent, not engine)
    completionSuffix(state.flow_snapshot.strictOutputs ?? true),
  ].filter(Boolean).join("\n\n");
}
```

**File:** `src/engine/index.ts` (NEW)

```typescript
// Re-exports from v1 engine, plus prompt assembly
export { createWorkflowState, startStep, applyStepResult, applyGateAnswer, currentStep } from "./transitions.ts";
export { resolveFeaturePath, resolveWorkflowDir, writeWorkflow, readWorkflow, getWorkflowDir, listWorkflows } from "./persistence.ts";
export { loadAgent, loadFlowAgents, validateFlowApproval, buildGate } from "./agent-loader.ts";
export { assembleAgentPrompt } from "./prompt-assembly.ts";
export type { FlowDefinition, FlowStep, WorkflowState, WorkflowStep, StepResult, GateAnswer, LoadedAgent, AgentManifest } from "./types.ts";
```

**Acceptance:** `npm run test` passes all existing v1 unit tests (they test transitions, persistence, agent-loader). New `prompt-assembly.test.ts` verifies prompt assembly produces correct output without APPROVAL_INSTRUCTION.

---

## Task 2: Remove noopLoadGate from orchestrator

**Problem:** The orchestrator currently uses `noopLoadGate()` in `applyStepResult()` because it handles gates externally. But v1's `applyStepResult()` only uses `loadGate` when `requestApproval: true` AND `result: "success"`. In v2, the orchestrator never calls `applyStepResult` with `loadGate` producing a real gate — the gate is handled by `GatePresenter` *after* the step result is applied.

**Decision:** The orchestrator should call `applyStepResult()` with a no-op gate loader AND `requestApproval` set to `false` on the flow step snapshot, so the engine transitions normally. Then the orchestrator checks `flowStep.requestApproval` from the *original* flow definition (not the snapshot) and presents the gate itself.

**Change in orchestrator.ts:**
```typescript
// Before calling applyStepResult, strip requestApproval from the snapshot
// so the engine doesn't create gate state. We handle gates externally.
const stepForEngine = { ...flowStep, requestApproval: false };
// ...but we keep the original flowStep for our own gate check below.
```

Alternatively, just let `noopLoadGate` return `null` — the engine will see `requestApproval: true` but the `loadGate` returns `null`, which causes the engine to return `action: "block"` with error "no approval block found." That's the existing behavior and it works because the orchestrator ignores the transition's action when it handles gates itself.

**Acceptance:** After `applyStepResult` with a gate step, the engine's transition has `action: "block"` (because loadGate returns null), but the orchestrator ignores that and proceeds to present the gate via GatePresenter.

---

## Task 3: Implement step feedback injection for retries

**Problem:** When a gate rejects with feedback ("change X to Y"), the agent should retry with that feedback. Currently the orchestrator records the feedback in the engine state (via `applyGateAnswer` → `last_feedback`), but the prompt for the retry doesn't include it.

**Change in orchestrator.ts `executeStep()`:**
```typescript
// After gate rejection with feedback:
if (answer.feedback) {
  // Inject feedback into the prompt for the retry
  feedbackForRetry = answer.feedback;
}
continue; // retry loop will use feedbackForRetry

// In the retry: append feedback to prompt
const prompt = assembleAgentPrompt(agent, state, workflowDir);
const fullPrompt = feedbackForRetry
  ? prompt + `\n\n## Feedback from Review\n\n${feedbackForRetry}\n\nRevise your work based on this feedback.`
  : prompt;
```

**Acceptance:** If gate returns feedback "remove the Events section", the retry prompt includes that text before the main prompt.

---

## Task 4: Handle the "awaiting_user" state for resume

**Problem:** When resuming a workflow that was in `awaiting_user` state (process crashed during gate presentation), the orchestrator needs to re-present the gate, not run a new agent.

**Change in runFlow():**
```typescript
if (state.status === "awaiting_user" && state.gate) {
  // Re-present the gate from the persisted state
  const approval = /* get agent approval manifest */;
  const answer = await gatePresenter.present({
    header: state.gate.header,
    previewPath: state.gate.preview ? path.join(workflowDir, state.gate.preview) : undefined,
    options: state.gate.options,
  }, projectRoot);
  
  const gateTransition = applyGateAnswer(state, {
    stepIndex: state.gate.stepIndex,
    chosenLabel: answer.label,
    advance: answer.advance,
    abort: answer.abort,
    feedback: answer.feedback,
  });
  state = gateTransition.state;
  writeWorkflow(projectRoot, featurePath, state);
  continue; // back to the main loop
}
```

**Acceptance:** Resume a workflow stuck at `awaiting_user` — the gate is re-presented, user answers, flow continues.

---

## Task 5: Add progress reporting for missing outputs (non-strict mode)

**Problem:** When `strictOutputs: false`, missing outputs produce warnings but don't block. The orchestrator should report them via `FlowProgress` but still advance.

**Change in orchestrator.ts:**
```typescript
if (!verification.allExist) {
  if (strictOutputs) {
    // ...existing blocking logic...
  } else {
    // Non-strict: warn via progress, but advance anyway
    if (progress && verification.missing.length > 0) {
      // Add a new FlowProgress method or use onStepEnd with warnings
      console.warn(`Warning: expected outputs missing (non-strict mode): ${verification.missing.join(", ")}`);
    }
  }
}
```

**Acceptance:** With `strictOutputs: false`, a step that produces no output files still advances with a warning.

---

## Task 6: Orchestrator unit tests

**File:** `test/orchestrator.test.ts`

Test with mock `AgentRunner`, `GatePresenter`, `OutputVerifier`:

| Test | What it verifies |
|------|-----------------|
| All steps succeed, no gates | Flow completes, every step ran exactly once |
| Step fails, retries, succeeds | Flow advances after retry |
| Step fails all retries | Flow returns `blocked` |
| Gate step: approve | Flow advances |
| Gate step: reject with feedback | Step retries with feedback in prompt |
| Gate step: abort | Flow returns `abandoned` |
| Missing outputs (strict) | Flow blocks |
| Missing outputs (non-strict) | Flow advances with warning |
| Resume from awaiting_user | Gate is re-presented |
| Empty flow (0 steps) | Flow returns `done` immediately |

**Mock strategy:**
```typescript
class MockAgentRunner implements AgentRunner {
  readonly name = "mock";
  private responses: AgentRunResult[];
  constructor(...responses: AgentRunResult[]) { this.responses = responses; }
  async run(): Promise<AgentRunResult> {
    return this.responses.shift() ?? { success: true, summary: "ok", expectedOutputs: [] };
  }
}

class MockGatePresenter implements GatePresenter {
  readonly name = "mock";
  private answers: GateAnswer[];
  constructor(...answers: GateAnswer[]) { this.answers = answers; }
  async present(): Promise<GateAnswer> {
    return this.answers.shift() ?? { label: "Approve", advance: true };
  }
}
```

**Dependencies:** Requires `src/engine/` stubs to compile. The engine functions are imported by the orchestrator — they need to exist (even as re-exports from v1) before tests can run.

---

## Task 7: Extract OrchestratorOptions to its own type file

**Problem:** `OrchestratorOptions` currently lives in `orchestrator.ts` which makes it hard for `main.ts` to import cleanly (it pulls in engine deps). Move the type to a separate file.

**File:** `src/orchestrator/types.ts` (NEW)

```typescript
import type { FlowDefinition, WorkflowState } from "../engine/types.ts";
import type { AgentRunner, GatePresenter, OutputVerifier, FlowProgress } from "./ports.ts";

export interface OrchestratorOptions {
  flow: FlowDefinition;
  featureName: string;
  featureContext?: string;
  projectRoot: string;
  agentsDir: string;
  agentRunner: AgentRunner;
  gatePresenter: GatePresenter;
  outputVerifier: OutputVerifier;
  progress?: FlowProgress;
  serviceDirs?: string[];
  resumeFrom?: WorkflowState;
}

export interface FlowOutcome {
  status: "done" | "blocked" | "abandoned";
  state: WorkflowState;
}
```

---

## Task 8: Handle SIGINT/SIGTERM gracefully

**Problem:** Ctrl+C during agent execution or gate presentation should persist state and exit cleanly, not leave a corrupted workflow.

**Implementation:**
```typescript
// In runFlow():
let aborted = false;
const onSignal = () => { aborted = true; };
process.on("SIGINT", onSignal);
process.on("SIGTERM", onSignal);

// In the main loop, after each agent run:
if (aborted) {
  writeWorkflow(projectRoot, featurePath, state);
  process.off("SIGINT", onSignal);
  process.off("SIGTERM", onSignal);
  return { status: "abandoned", state };
}
```

**Acceptance:** Ctrl+C during agent execution persists the current step as "running" in workflow.json. Resuming later restarts that step.

---

## Prioritized task list

| Priority | Task | Effort | Depends on |
|----------|------|--------|------------|
| P0 | Task 1: Reconcile with v1 engine API | L | engine files ported from v1 |
| P0 | Task 2: Remove noopLoadGate (cleanup) | XS | Task 1 |
| P1 | Task 3: Feedback injection for retries | S | none |
| P1 | Task 4: Handle awaiting_user for resume | M | persistence.ts |
| P1 | Task 5: Non-strict output warnings | XS | none |
| P1 | Task 7: Extract types to separate file | XS | none |
| P2 | Task 6: Orchestrator unit tests | M | Tasks 1-5 |
| P2 | Task 8: Signal handling | S | none |

## Risks

1. **Engine import paths.** The orchestrator imports from `../engine/`. If the engine files are symlinked or copied from v1, TypeScript path resolution must work. Consider a path alias in tsconfig.json (`@engine` → `src/engine`).

2. **Prompt assembly must NOT include APPROVAL_INSTRUCTION.** This is the most critical v2 change. If the old prompt assembly code accidentally includes the 200-line gate protocol instruction, the agent will try to follow a protocol that doesn't exist.

3. **State mutation during gate presentation.** If the process crashes between GatePresenter returning and `writeWorkflow()`, the gate answer is lost. Consider persisting immediately after the gate answer is collected, before processing the transition.
