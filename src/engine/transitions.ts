/**
 * State machine transitions for the flow engine.
 *
 * Pure functions — no I/O. The engine reads state, calls these functions,
 * then writes the resulting state back to workflow.json.
 */

import {
  DEFAULT_ATTEMPTS,
  type FlowDefinition,
  type FlowStep,
  type GateAnswer,
  type StepResult,
  type StepStatus,
  type WorkflowStepUpdate,
  type WorkflowGate,
  type WorkflowState,
  type WorkflowStatus,
  type WorkflowStep,
} from "./types.ts";

// ============================================================================
// Initialization
// ============================================================================

/** Freeze a flow definition into an initial WorkflowState. */
export function createWorkflowState(
  flow: FlowDefinition,
  feature: string,
  featurePath: string,
  projectRoot: string,
  serviceDirs?: string[],
  featureContext?: string,
  projectRulesContext?: string
): WorkflowState {
  const steps: WorkflowStep[] = flow.steps.map((step, index) => ({
    index,
    id: step.id ?? step.agent,
    agent: step.agent,
    status: "pending" as StepStatus,
    attempt: 0,
  }));

  return {
    schema_version: 1,
    feature,
    feature_path: featurePath,
    project_root: projectRoot,
    flow_id: flow.id,
    flow_version: flow.version,
    flow_snapshot: JSON.parse(JSON.stringify(flow)), // deep clone
    current_step_index: 0,
    status: "in_progress",
    awaiting: null,
    steps,
    service_dirs: serviceDirs,
    feature_context: featureContext,
    project_rules_context: projectRulesContext,
    build_status: null,
  };
}

// ============================================================================
// Step start
// ============================================================================

/** Mark the current step as running. Returns updated state. */
export function startStep(state: WorkflowState): WorkflowState {
  const next = { ...state, steps: state.steps.map((s) => ({ ...s })) };
  if (next.status === "awaiting_user") {
    const cs = next.steps[next.current_step_index];
    // Only stop if there's a real active gate for the current step.
    // Stale status (gate already resolved) → recover and continue.
    if (next.gate && cs && next.gate.stepIndex === cs.index) return next;
    next.status = "in_progress";
    next.awaiting = null;
    next.gate = undefined;
  }

  const step = next.steps[next.current_step_index];
  if (!step) return next;
  if (step.status === "running") return next;
  if (step.status !== "pending") return next;

  step.status = "running";
  if (!step.started_at) {
    step.started_at = new Date().toISOString();
  }
  step.completed_at = undefined;
  step.result = undefined;
  step.activity = {
    status: "working",
    phase: "starting",
    message: `Starting ${step.agent}`,
    updated_at: new Date().toISOString(),
  };
  step.attempt += 1;

  return next;
}

/** Merge a supervisor-submitted activity update into the current running step. */
export function updateStepActivity(
  state: WorkflowState,
  update: WorkflowStepUpdate
): { state: WorkflowState; error?: string } {
  const next = cloneState(state);
  if (next.status !== "in_progress") {
    return { state: next, error: `workflow is ${next.status}; only in-progress workflows can be updated` };
  }

  const stepIndex = update.stepIndex ?? next.current_step_index;
  if (stepIndex !== next.current_step_index) {
    return { state: next, error: "step update does not match the current step" };
  }

  const step = next.steps[stepIndex];
  if (!step) return { state: next, error: "current step not found" };
  if (step.status !== "running") {
    return { state: next, error: `step "${step.agent}" is ${step.status}; call flow_step before updating activity` };
  }

  const childRunIds = update.childRunIds
    ? [...new Set(update.childRunIds.map((id) => id.trim()).filter(Boolean))]
    : step.activity?.child_run_ids;

  step.activity = {
    ...step.activity,
    ...(update.phase !== undefined ? { phase: update.phase } : {}),
    ...(update.message !== undefined ? { message: update.message } : {}),
    ...(update.status !== undefined ? { status: update.status } : {}),
    ...(childRunIds !== undefined ? { child_run_ids: childRunIds } : {}),
    ...(update.currentTool !== undefined ? { current_tool: update.currentTool } : {}),
    ...(update.currentPath !== undefined ? { current_path: update.currentPath } : {}),
    updated_at: new Date().toISOString(),
  };

  return { state: next };
}

// ============================================================================
// Step complete — the core transition
// ============================================================================

export interface StepTransition {
  state: WorkflowState;
  /** What action the engine should take next */
  action: "advance" | "retry" | "gate" | "block" | "done";
  /** Optional: gate data to present to the user */
  gate?: WorkflowGate;
  /** Optional: error message for the caller */
  error?: string;
}

/** Current flow step being executed */
export function currentStep(state: WorkflowState): FlowStep | null {
  if (state.current_step_index >= state.flow_snapshot.steps.length) return null;
  return state.flow_snapshot.steps[state.current_step_index];
}

/** Current workflow step being executed */
export function currentWorkflowStep(state: WorkflowState): WorkflowStep | null {
  if (state.current_step_index >= state.steps.length) return null;
  return state.steps[state.current_step_index];
}

/**
 * Apply a step result and compute the next transition.
 *
 * @param state - Current workflow state
 * @param result - step-result from the supervisor
 * @param loadGate - function to build a WorkflowGate from the agent's approval manifest
 */
export function applyStepResult(
  state: WorkflowState,
  result: StepResult,
  loadGate: (agent: string, stepIndex: number) => WorkflowGate | null
): StepTransition {
  const next = cloneState(state);
  const step = currentWorkflowStep(next);
  const flowStep = currentStep(next);

  if (!step || !flowStep) {
    return { state: next, action: "done" };
  }

  if (next.status === "awaiting_user" || next.awaiting === "user_gate") {
    // Only block if there's a real active gate for *this* step.
    // Stale status (gate already resolved) → recover and continue.
    if (next.gate && next.gate.stepIndex === step.index) {
      return {
        state: next,
        action: "block",
        error: "workflow is awaiting user approval; answer the active gate before completing another step",
      };
    }
    // Stale awaiting_user without a matching gate — clean up and proceed
    next.status = "in_progress";
    next.awaiting = null;
    next.gate = undefined;
  }

  if (step.status !== "running") {
    return {
      state: next,
      action: "block",
      error: `step "${step.agent}" is ${step.status}; call flow_step before submitting a result`,
    };
  }

  step.result = { ...result };
  step.completed_at = new Date().toISOString();
  step.activity = {
    ...step.activity,
    status: result.result === "success" ? "working" : "blocked",
    message: result.message,
    updated_at: step.completed_at,
  };

  if (result.result === "success") {
    step.status = "completed";
    mergeStepMetadata(next, result);

    // Check if this step requires user approval
    if (flowStep.requestApproval) {
      const gate = loadGate(flowStep.agent, step.index);
      if (!gate) {
        // Missing approval block — should be caught at start time, but guard here too
        return {
          state: next,
          action: "block",
          error: `step "${flowStep.agent}" requires user approval but no approval block found`,
        };
      }

      next.status = "awaiting_user";
      next.awaiting = "user_gate";
      next.gate = gate;

      return { state: next, action: "gate", gate };
    }

    // No approval needed — advance
    return advanceStep(next);
  }

  // error result
  step.status = "failed";

  const maxAttempts = flowStep.attempts ?? DEFAULT_ATTEMPTS;
  if (result.retryable !== false && step.attempt < maxAttempts) {
    // Retry — status goes back to pending for re-run
    step.status = "pending";
    step.completed_at = undefined;
    return { state: next, action: "retry" };
  }

  // No retries left — block
  next.status = "blocked";
  next.build_status = "BLOCKED";
  return { state: next, action: "block" };
}

// ============================================================================
// Gate answer
// ============================================================================

export interface GateTransition {
  state: WorkflowState;
  action: "advance" | "retry" | "block" | "done" | "abort";
  error?: string;
}

/**
 * Apply a gate answer and compute the next transition.
 *
 * If the user chose an option with advance: true, the flow advances.
 * Otherwise, the caller (supervisor) decides what to do — the engine
 * returns action: "retry" to indicate the same step should be re-run.
 */
export function applyGateAnswer(
  state: WorkflowState,
  answer: GateAnswer
): GateTransition {
  const next = cloneState(state);

  if (next.status !== "awaiting_user" || next.awaiting !== "user_gate" || !next.gate) {
    return { state: next, action: "block" };
  }

  if (next.current_step_index !== answer.stepIndex) {
    return { state: next, action: "block", error: "gate answer does not match the current step" };
  }

  const chosenOption = next.gate.options.find((opt) => opt.label === answer.chosenLabel);
  if (!chosenOption) {
    return {
      state: next,
      action: "block",
      error: `unknown gate option "${answer.chosenLabel}"`,
    };
  }

  if (chosenOption.advance !== answer.advance) {
    return {
      state: next,
      action: "block",
      error: `gate option "${chosenOption.label}" advance value does not match the answer`,
    };
  }

  if ((chosenOption.abort ?? false) !== (answer.abort ?? false)) {
    return {
      state: next,
      action: "block",
      error: `gate option "${chosenOption.label}" abort value does not match the answer`,
    };
  }

  const feedback = answer.feedback?.trim();
  if (chosenOption.feedback && !feedback) {
    return {
      state: next,
      action: "block",
      error: `gate option "${chosenOption.label}" requires feedback`,
    };
  }

  next.awaiting = null;
  next.gate = undefined;

  if (answer.advance) {
    next.current_step_index += 1;
    if (next.current_step_index >= next.steps.length) {
      next.status = "done";
      next.build_status = "DONE";
      return { state: next, action: "done" };
    }
    next.status = "in_progress";
    return { state: next, action: "advance" };
  }

  // User did not approve
  if (answer.abort) {
    // Abort/exit the workflow entirely
    next.status = "abandoned";
    next.build_status = "BLOCKED";
    return { state: next, action: "abort" };
  }

  // Request changes — reset the step for re-run
  const step = next.steps[next.current_step_index];
  if (step) {
    step.status = "pending";
    step.completed_at = undefined;
    step.result = undefined;
    step.activity = undefined;
    if (feedback !== undefined) {
      step.last_feedback = feedback;
    }
  }
  next.status = "in_progress";
  return { state: next, action: "retry" };
}

// ============================================================================
// Internal helpers
// ============================================================================

function cloneState(state: WorkflowState): WorkflowState {
  return {
    ...state,
    steps: state.steps.map((s) => ({
      ...s,
      activity: s.activity
        ? {
            ...s.activity,
            child_run_ids: s.activity.child_run_ids ? [...s.activity.child_run_ids] : undefined,
          }
        : undefined,
    })),
    gate: state.gate ? { ...state.gate, options: [...state.gate.options], questions: state.gate.questions ? [...state.gate.questions] : undefined } : undefined,
    flow_snapshot: { ...state.flow_snapshot, steps: [...state.flow_snapshot.steps] },
    service_dirs: state.service_dirs ? [...state.service_dirs] : undefined,
  };
}

function mergeStepMetadata(state: WorkflowState, result: StepResult): void {
  const newServiceDirs = result.metadata?.service_dirs;
  if (!newServiceDirs) return;

  // Accumulate with existing service_dirs (deduplicated)
  state.service_dirs = [...new Set([
    ...(state.service_dirs ?? []),
    ...newServiceDirs.filter(Boolean),
  ])];
}

function advanceStep(state: WorkflowState): StepTransition {
  state.current_step_index += 1;
  return advanceGateStep(state);
}

function advanceGateStep(state: WorkflowState): GateTransition | StepTransition {
  if (state.current_step_index >= state.steps.length) {
    state.status = "done";
    state.build_status = "DONE";
    return { state, action: "done" };
  }
  state.status = "in_progress";
  return { state, action: "advance" };
}
