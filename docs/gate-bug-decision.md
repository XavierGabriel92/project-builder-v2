# Decision: Fix gateLoader closure for state-machine gate handling

**Date:** 2026-06-18  
**Status:** Accepted  
**Option:** A — Proper gateLoader closure  
**Replaces:** `noopLoadGate()` → state-machine bypass  

---

## 1. The Bug

### What happens

The orchestrator skeleton in `src/orchestrator/orchestrator.ts` calls `applyStepResult(state, { success }, noopLoadGate)`, then later calls `applyGateAnswer(state, answer)`. This fails silently — the gate never processes the user's answer.

### Root cause

Two parts conspire:

**Part 1: `noopLoadGate` returns null.**

At the bottom of `orchestrator.ts`:

```typescript
function noopLoadGate(): null {
  return null;
}
```

This is passed as the `loadGate` argument to `applyStepResult(state, result, noopLoadGate)`.

**Part 2: The engine uses `loadGate` to decide whether to enter `awaiting_user` state.**

In v1's `transitions.ts:203-209`:

```typescript
if (flowStep.requestApproval) {
  const gate = loadGate(flowStep.agent, step.index);
  if (!gate) {
    return {
      state: next,
      action: "block",
      error: "...no approval block found",
    };
  }
  // Creates awaiting_user state with gate object
  next.status = "awaiting_user";
  next.awaiting = "user_gate";
  next.gate = gate;
  return { state: next, action: "gate", gate };
}
```

Because `noopLoadGate` returns `null`, the engine takes the `if (!gate)` branch and **blocks the step**. The state machine never enters `awaiting_user`.

**Part 3: `applyGateAnswer` guards on that state.**

In v1's `transitions.ts:269`:

```typescript
if (next.status !== "awaiting_user" || next.awaiting !== "user_gate" || !next.gate) {
  return { state: next, action: "block" };
}
```

When the orchestrator later calls `applyGateAnswer(state, answer)`, the state is NOT `awaiting_user` — it's `blocked` (from Part 2) or `in_progress` (if somehow past the guard). Either way, the gate answer is silently swallowed and the step never advances.

### Visual: the death loop

```
┌─ executeStep() ──────────────────────────────────────────────┐
│                                                               │
│  1. agentRunner.run() → success                              │
│                                                               │
│  2. applyStepResult(state, {success}, noopLoadGate)          │
│     ┌──────────────────────────────────────────────────┐     │
│     │  engine: flowStep.requestApproval? → YES         │     │
│     │  engine: gate = noopLoadGate() → NULL            │     │
│     │  engine: if (!gate) → BLOCK                      │     │
│     │  returns: { action: "block", ... }               │     │
│     └──────────────────────────────────────────────────┘     │
│                                                               │
│  3. state.status = "blocked"  ← WRONG                        │
│                                                               │
│  4. if (flowStep.requestApproval) → true                     │
│     gatePresenter.present(gate) → user answers               │
│                                                               │
│  5. applyGateAnswer(state, answer)                           │
│     ┌──────────────────────────────────────────────────┐     │
│     │  engine: state.status === "awaiting_user"? → NO  │     │
│     │  engine: return { action: "block" }              │     │
│     └──────────────────────────────────────────────────┘     │
│                                                               │
│  ✗ Gate answer silently discarded                            │
│  ✗ Step never advances                                       │
│  ✗ Workflow is stuck                                         │
│                                                               │
└───────────────────────────────────────────────────────────────┘
```

---

## 2. Three Options Considered

### Option A: Fix gateLoader to be a proper closure (RECOMMENDED)

Replace `noopLoadGate` with a closure that calls `buildGate()` from the engine's `agent-loader.ts`. The engine creates `awaiting_user` state with the gate object. The orchestrator presents the gate. `applyGateAnswer` works as designed because the state precondition is satisfied.

```typescript
// Inside executeStep(), after loading the agent:
const gateLoader = (_agent: string, stepIndex: number) => {
  if (!agent.manifest.approval) return null;
  return buildGate(agent.manifest, stepIndex, "v2-no-nonce");
};
```

| Pro | Con |
|-----|-----|
| Engine owns all state transitions (tested v1 code) | Passes a vestigial nonce string to `buildGate` |
| Workflow.json records gate state — resumable after crash | One new closure (3 lines) |
| `applyGateAnswer` validates label, advance/abort flags, stepIndex match | |
| No v1 engine fork required | |
| Gate nonce is harmless — only `engine.ts::recordGate()` validates it, and we never call that | |

---

### Option B: Bypass `applyGateAnswer` entirely

Handle gate state transitions manually in the orchestrator: increment `current_step_index`, set `status`, reset step to `pending` for retry, inject feedback.

```typescript
// Instead of calling applyGateAnswer:
if (answer.advance) {
  state.current_step_index += 1;
  if (state.current_step_index >= state.steps.length) {
    state.status = "done";
  }
}
if (answer.abort) {
  state.status = "abandoned";
}
if (!answer.advance && !answer.abort) {
  const step = state.steps[state.current_step_index];
  step.status = "pending";
  step.last_feedback = answer.feedback;
}
```

| Pro | Con |
|-----|-----|
| Zero engine changes | Duplicates `advanceStep` + `applyGateAnswer` logic |
| No vestigial nonce | No engine validation (label existence, advance/abort consistency) |
| Dead simple — you can SEE every transition | Workflow.json won't show gate state |
| | Every bug the v1 engine already fixed, you re-introduce |
| | Not resumable — crash mid-gate and state is inconsistent |

---

### Option C: Relax `applyGateAnswer`'s state guard

Remove the `state.status === "awaiting_user"` precondition from v1's `transitions.ts:269`.

```typescript
// BEFORE (v1):
if (next.status !== "awaiting_user" || next.awaiting !== "user_gate" || !next.gate) {
  return { state: next, action: "block" };
}

// AFTER (relaxed):
if (!next.gate) {
  return { state: next, action: "block", error: "no active gate" };
}
```

| Pro | Con |
|-----|-----|
| Clean call signature | Forks v1 engine code |
| `applyGateAnswer` works from any state | Loses the invariant: "gates only exist when state machine expects them" |
| | Accidental call on non-gate step silently corrupts state instead of blocking |
| | Must copy and maintain the fork forever |

---

## 3. Why Option A

### Engine remains the single authority on state transitions

The v1 state machine in `transitions.ts` has been tested for every transition path:

- `start()` → `in_progress`  
- `startStep()` → `running`  
- `applyStepResult(success, no gate)` → advance → `in_progress` (next step) / `done`  
- `applyStepResult(success, with gate)` → `awaiting_user` with gate object  
- `applyStepResult(error, retryable)` → reset to `pending` (retry)  
- `applyStepResult(error, exhausted)` → `blocked`  
- `applyGateAnswer(approve)` → advance → `in_progress` / `done`  
- `applyGateAnswer(reject)` → reset to `pending` with feedback  
- `applyGateAnswer(abort)` → `abandoned`  

Option A preserves every one of these. The gate path is identical to v1's LLM-supervisor path — the only difference is WHO calls `applyGateAnswer` (orchestrator vs. LLM supervisor). The state machine doesn't know or care.

### Workflow.json records gate state — resumable after crash

If the process dies after `applyStepResult` creates `awaiting_user` but before the user answers the gate:

```json
{
  "status": "awaiting_user",
  "awaiting": "user_gate",
  "gate": {
    "header": "Spec Review",
    "options": [...],
    "stepIndex": 0,
    "nonce": "v2-no-nonce"
  },
  "current_step_index": 0,
  "steps": [
    { "status": "completed", ... }
  ]
}
```

A `--resume` flag can read this state, detect `awaiting_user`, re-present the gate, and continue. Option B can't do this — the state is `in_progress` with no gate context.

### One line of new code, three lines of closure

The entire fix is:

```typescript
const gateLoader = (_agent: string, stepIndex: number) => {
  if (!agent.manifest.approval) return null;
  return buildGate(agent.manifest, stepIndex, "v2-no-nonce");
};
```

Option B requires ~30 lines of duplication. Option C requires forking the engine.

### The vestigial nonce is harmless

In v1, the nonce prevents LLMs from fabricating gate answers without going through the `flow_continue → ask_user_question → flow_record_gate` cycle. Nonce validation lives ONLY in `engine.ts::recordGate()`:

```typescript
// engine.ts — the ONLY nonce validation code (we never call this):
if (!answer.gateNonce) { /* block */ }
if (answer.gateNonce !== resolved.state.gate.nonce) { /* block */ }
```

`transitions.ts::applyGateAnswer()` does NOT validate nonces. The nonce string `"v2-no-nonce"` is stored in `gate.nonce`, passed through `gate.nonce` in the `WorkflowGate`, and never checked. It's harmless data.

### No v1 engine fork required

Options A uses the engine as a library dependency. Options B and C either duplicate or modify it. Keeping the engine unmodified means future v1 bugfixes flow into v2 automatically.

---

## 4. The Fix

### Before (broken — current skeleton)

```typescript
// orchestrator.ts — BROKEN
async function executeStep(...) {
  const agent = loadAgent(agentsDir, flowStep.agent);
  // ...

  // ── Apply success to engine ────────────────────────────────
  let transition = applyStepResult(          // ← BROKEN
    state,
    { result: "success", message: result.summary },
    noopLoadGate,                            // ← returns null
  );
  state = transition.state;                  // ← state is "blocked", not "awaiting_user"

  // ── Gate? ──────────────────────────────────────────────────
  if (flowStep.requestApproval && agent.manifest.approval) {
    // ...
    const answer = await gatePresenter.present({...});

    if (answer.advance) {
      const gateTransition = applyGateAnswer( // ← BROKEN
        state,                                 // ← state.status !== "awaiting_user"
        { stepIndex: state.current_step_index, chosenLabel: answer.label, advance: true }
      );
      return gateTransition.state;           // ← returns { action: "block" }, never advances
    }
  }
}

function noopLoadGate(): null {
  return null;  // ← THE BUG
}
```

### After (fixed — Option A)

```typescript
// orchestrator.ts — FIXED
async function executeStep(...) {
  const agent = loadAgent(agentsDir, flowStep.agent);
  // ...

  // ── Build proper gateLoader closure ────────────────────────
  const gateLoader = (_agent: string, stepIndex: number) => {
    if (!agent.manifest.approval) return null;
    return buildGate(agent.manifest, stepIndex, "v2-no-nonce");
  };

  // ── Apply success to engine ────────────────────────────────
  let transition = applyStepResult(          // ← FIXED
    state,
    { result: "success", message: result.summary },
    gateLoader,                              // ← returns WorkflowGate, not null
  );
  state = transition.state;                  // ← state is "awaiting_user" with gate object

  // ── Gate? ──────────────────────────────────────────────────
  if (flowStep.requestApproval && agent.manifest.approval) {
    // transition.action === "gate" → gate is in state.gate
    const approval = agent.manifest.approval;
    const previewPath = approval.preview
      ? path.join(workflowDir, approval.preview)
      : undefined;

    progress?.onGate({ header: approval.header, previewPath, options: approval.options });

    const answer = await gatePresenter.present({
      header: approval.header,
      previewPath,
      options: approval.options,
    }, projectRoot);

    if (answer.advance) {
      const gateTransition = applyGateAnswer( // ← WORKS
        state,                                 // ← state.status === "awaiting_user" ✓
        {
          stepIndex: state.current_step_index,
          chosenLabel: answer.label,
          advance: true,
        }
      );
      return gateTransition.state;           // ← advances to next step ✓
    }

    if (answer.abort) {
      const gateTransition = applyGateAnswer(state, {
        stepIndex: state.current_step_index,
        chosenLabel: answer.label,
        advance: false,
        abort: true,
      });
      return gateTransition.state;           // ← marks abandoned ✓
    }

    // Reject with feedback → retry
    const gateTransition = applyGateAnswer(state, {
      stepIndex: state.current_step_index,
      chosenLabel: answer.label,
      advance: false,
      feedback: answer.feedback,
    });
    state = gateTransition.state;            // ← step reset to pending with feedback ✓
    continue;                                // ← retries the step ✓
  }

  // No gate → advance happened inside applyStepResult
  return state;
}

// Delete this:
// function noopLoadGate(): null { return null; }
```

### Required import

Add to `orchestrator.ts`:

```typescript
import { buildGate } from "../engine/agent-loader.ts";
```

---

## 5. Verification

### Unit test approach

```typescript
describe("executeStep — gate handling", () => {
  it("creates awaiting_user state when step has requestApproval", () => {
    // Arrange: step with requestApproval: true, agent has approval manifest
    const flow = makeFlow([{ agent: "spec-write", requestApproval: true }]);
    const agent = makeAgent({ approval: { header: "Review", options: [...] } });
    const runner = new MockAgentRunner();   // always returns success
    const gate = new MockGatePresenter();   // returns approve

    // Act
    const state = await executeStep(flowStep, initialState, ...);

    // Assert
    expect(state.status).toBe("awaiting_user");
    expect(state.awaiting).toBe("user_gate");
    expect(state.gate).toBeDefined();
    expect(state.gate.header).toBe("Review");
  });

  it("applyGateAnswer advances when user approves", () => {
    // Start from awaiting_user state with gate
    const state = makeAwaitingUserState();

    const result = applyGateAnswer(state, {
      stepIndex: 0,
      chosenLabel: "Approve",
      advance: true,
    });

    expect(result.action).toBe("advance");
    expect(result.state.status).toBe("in_progress");
    expect(result.state.current_step_index).toBe(1);
  });

  it("applyGateAnswer retries when user rejects with feedback", () => {
    const state = makeAwaitingUserState();

    const result = applyGateAnswer(state, {
      stepIndex: 0,
      chosenLabel: "Request changes",
      advance: false,
      feedback: "Missing error handling section",
    });

    expect(result.action).toBe("retry");
    expect(result.state.status).toBe("in_progress");
    expect(result.state.steps[0].status).toBe("pending");
    expect(result.state.steps[0].last_feedback).toBe("Missing error handling section");
  });

  it("applyGateAnswer abandons when user aborts", () => {
    const state = makeAwaitingUserState();

    const result = applyGateAnswer(state, {
      stepIndex: 0,
      chosenLabel: "Exit",
      advance: false,
      abort: true,
    });

    expect(result.action).toBe("abort");
    expect(result.state.status).toBe("abandoned");
  });

  it("does NOT enter awaiting_user when agent has no approval manifest", () => {
    const flow = makeFlow([{ agent: "plan", requestApproval: false }]);
    const agent = makeAgent({ approval: undefined });

    const state = await executeStep(...);

    expect(state.status).not.toBe("awaiting_user");
    expect(state.gate).toBeUndefined();
  });
});
```

### Manual verification checklist

- [ ] Start a flow with a gate step (e.g., feature-build flow → spec-write)
- [ ] Verify the engine creates `awaiting_user` state after agent completes
- [ ] Verify the gate is presented with correct header, options, and preview
- [ ] Verify "Approve" advances to the next step
- [ ] Verify "Request changes" resets the step and injects feedback into the retry
- [ ] Verify "Exit" marks the workflow as abandoned
- [ ] Verify non-gate steps skip the gate entirely and advance immediately
- [ ] Kill the process mid-gate, restart with `--resume`, verify the gate re-presents

---

## 6. Cross-references

This bug was independently identified in three implementation plans:

- **[../plans/02-orchestrator.md](../plans/02-orchestrator.md)** — Section "Gate state machine mismatch". Identifies that `noopLoadGate` prevents state from reaching `awaiting_user`, and that `applyGateAnswer` guards on that exact state.

- **[../plans/03-gates.md](../plans/03-gates.md)** — Section "Gate state machine mismatch". Identifies that `applyGateAnswer` blocks because `state.status !== "awaiting_user"`, and confirms Option A (gateLoader closure + `buildGate`).

- **[../plans/06-flows-main.md](../plans/06-flows-main.md)** — Section "Handle gate without engine awaiting_user state". Identifies the same issue while planning the CLI resume feature and confirms that `noopLoadGate` causes the gate transition to silently fail.

---

## References

- v1 engine: `agent/extensions/project-builder/src/engine/`
- v1 `buildGate()`: `agent-loader.ts:153`
- v1 `applyStepResult()`: `transitions.ts:165` (gate creation at line 203)
- v1 `applyGateAnswer()`: `transitions.ts:263` (state guard at line 269)
- v2 orchestrator: `src/orchestrator/orchestrator.ts` (affected code at line 215)
- v2 ports: `src/orchestrator/ports.ts`
