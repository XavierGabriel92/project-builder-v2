/**
 * Project Builder v2 — Flow Orchestrator
 *
 * Pure logic: iterates through flow steps, invokes agents via AgentRunner,
 * verifies outputs, presents gates, and advances/retries/blocks.
 *
 * Depends ONLY on:
 *   - ports.ts          (AgentRunner, GatePresenter, OutputVerifier, FlowProgress)
 *   - engine/types.ts   (FlowDefinition, WorkflowState, etc.)
 *   - engine/transitions.ts  (createWorkflowState, startStep, applyStepResult, applyGateAnswer)
 *   - engine/persistence.ts  (writeWorkflow, resolveWorkflowDir)
 *   - engine/agent-loader.ts (loadAgent, buildGate, buildPrompt, buildSystemPrefix)
 *   - node:path
 *
 * Does NOT import:
 *   - @earendil-works/pi-coding-agent
 *   - inquirer
 *   - Any concrete runner/gate/verifier implementation
 */

import * as path from "node:path";
import type { FlowDefinition, WorkflowState, FlowStep } from "../engine/types.ts";
import {
  createWorkflowState,
  startStep,
  applyStepResult,
  applyGateAnswer,
  currentStep,
} from "../engine/transitions.ts";
import {
  loadAgent,
  buildGate,
} from "../engine/agent-loader.ts";
import {
  buildPrompt,
  buildSystemPrefix,
} from "../engine/prompt-builder.ts";
import {
  writeWorkflow,
  resolveWorkflowDir,
  resolveFeaturePath,
} from "../engine/persistence.ts";
import type {
  AgentRunner,
  GatePresenter,
  OutputVerifier,
  FlowProgress,
} from "./ports.ts";

// ============================================================================
// Options
// ============================================================================

export interface OrchestratorOptions {
  /** The flow definition to run. */
  flow: FlowDefinition;
  /** Human-readable feature name (e.g. "user-auth"). */
  featureName: string;
  /** Free-form user description of what they want to build. */
  featureContext?: string;
  /** Project root directory. */
  projectRoot: string;
  /** Path to agents/ directory containing .md manifests. */
  agentsDir: string;

  // ── Swappable dependencies ──────────────────────────────────

  agentRunner: AgentRunner;
  gatePresenter: GatePresenter;
  outputVerifier: OutputVerifier;
  progress?: FlowProgress;

  /** Optional service directories (for doc-sync, etc.). */
  serviceDirs?: string[];

  /** Resume from an existing workflow state (for --resume). */
  resumeFrom?: WorkflowState;
}

export interface FlowOutcome {
  status: "done" | "blocked" | "abandoned";
  state: WorkflowState;
}

// ============================================================================
// runFlow
// ============================================================================

export async function runFlow(options: OrchestratorOptions): Promise<FlowOutcome> {
  const {
    flow, featureName, featureContext, projectRoot: rawProjectRoot, agentsDir,
    agentRunner, gatePresenter, outputVerifier, progress, serviceDirs,
    resumeFrom,
  } = options;

  // Normalize project root (strip trailing spaces/slashes)
  const projectRoot = path.resolve(rawProjectRoot.trim());

  // ── Initialize engine state ──────────────────────────────────
  let state: WorkflowState;
  if (resumeFrom) {
    state = resumeFrom;
  } else {
    const featurePath = resolveFeaturePath(featureName, projectRoot);
    state = createWorkflowState(
      flow, featureName, featurePath, projectRoot,
      serviceDirs, featureContext,
    );
    writeWorkflow(projectRoot, featurePath, state);
  }

  const workflowDir = resolveWorkflowDir(projectRoot, state.feature_path);

  // ── Resume: re-present gate if state is awaiting_user ─────────
  if (state.status === "awaiting_user" && state.gate) {
    state = await presentAndResolveGate(
      state, state.gate, workflowDir, projectRoot,
      gatePresenter, progress,
    );
    writeWorkflow(projectRoot, state.feature_path, state);

    if (state.status === "abandoned") {
      return { status: "abandoned", state };
    }
  }

  // ── Resume: fast-forward if step was interrupted but outputs exist ──
  if (resumeFrom) {
    const interruptedStep = state.steps[state.current_step_index];
    if (interruptedStep?.status === "running") {
      const flowStep = currentStep(state);
      if (flowStep) {
        const agent = loadAgent(agentsDir, flowStep.agent);
        const outputs = agent.manifest.outputs ?? [];
        if (outputs.length > 0) {
          const verification = outputVerifier.verify(
            outputs.map(o => path.join(workflowDir, o)),
            workflowDir,
          );
          if (verification.allExist) {
            console.log(`  ↪ Fast-forward: outputs already exist (${outputs.join(", ")}), skipping agent`);
            const gateLoader = (_a: string, si: number) => {
              if (!agent.manifest.approval) return null;
              return buildGate(agent.manifest, si, "v2-no-nonce");
            };
            const existingMsg = interruptedStep.activity?.message ?? `Resumed: outputs already exist`;
            const transition = applyStepResult(
              state,
              { result: "success", message: existingMsg },
              gateLoader,
            );
            state = transition.state;
            writeWorkflow(projectRoot, state.feature_path, state);

            // Present gate if needed
            if (flowStep.requestApproval && agent.manifest.approval && state.gate) {
              state = await presentAndResolveGate(
                state, state.gate, workflowDir, projectRoot,
                gatePresenter, progress,
              );
              writeWorkflow(projectRoot, state.feature_path, state);
            }
          }
        }
      }
    }
  }

  // ── Main loop ────────────────────────────────────────────────
  progress?.onFlowStart({
    flowId: flow.id,
    feature: state.feature,
    totalSteps: flow.steps.length,
  });

  while (true) {
    const flowStep = currentStep(state);
    if (!flowStep) break; // done — no more steps

    state = await executeStep(
      flowStep, state, workflowDir, projectRoot, agentsDir,
      agentRunner, gatePresenter, outputVerifier, progress,
    );

    // Persist after each step
    writeWorkflow(projectRoot, state.feature_path, state);

    // Check terminal states
    if (state.status === "blocked") {
      progress?.onFlowBlocked(
        state.steps[state.current_step_index]?.result?.message ?? "Unknown error"
      );
      return { status: "blocked", state };
    }
    if (state.status === "abandoned") {
      return { status: "abandoned", state };
    }
  }

  // ── Done ─────────────────────────────────────────────────────
  state = { ...state, status: "done" as const, build_status: "DONE" };
  writeWorkflow(projectRoot, state.feature_path, state);
  progress?.onFlowComplete();
  return { status: "done", state };
}

// ============================================================================
// executeStep — run one step, including retries and gates
// ============================================================================

async function executeStep(
  flowStep: NonNullable<ReturnType<typeof currentStep>>,
  state: WorkflowState,
  workflowDir: string,
  projectRoot: string,
  agentsDir: string,
  agentRunner: AgentRunner,
  gatePresenter: GatePresenter,
  outputVerifier: OutputVerifier,
  progress?: FlowProgress,
): Promise<WorkflowState> {
  // Load agent manifest
  const agent = loadAgent(agentsDir, flowStep.agent);
  const maxAttempts = flowStep.attempts ?? 1;

  // ── Gate loader closure (replaces noopLoadGate) ─────────────
  // Properly creates gate state via buildGate so the engine enters
  // awaiting_user and applyGateAnswer can process the answer.
  const gateLoader = (_agent: string, stepIndex: number) => {
    if (!agent.manifest.approval) return null;
    return buildGate(agent.manifest, stepIndex, "v2-no-nonce");
  };

  // Track feedback from gate rejections for retry injection
  let feedbackForRetry: string | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Mark step running in engine
    state = startStep(state);
    writeWorkflow(projectRoot, state.feature_path, state);
    progress?.onStepStart({ agent: flowStep.agent, index: state.current_step_index, attempt });

    // ── Build prompt with retry feedback ───────────────────────
    let prompt = buildPrompt(agent, state);
    if (feedbackForRetry) {
      prompt = prompt + `\n\n## Feedback from Review\n\n${feedbackForRetry}\n\nRevise your work based on this feedback.`;
      feedbackForRetry = undefined; // only inject for this attempt
    }

    // ── Layer boundary: AgentRunner ────────────────────────────
    // Resolve model: per-step > flow default > runner default
    const model = flowStep.model
      ?? state.flow_snapshot.defaultModel
      ?? undefined;

    const result = await agentRunner.run({
      prompt,
      systemPrompt: buildSystemPrefix(state),
      tools: agent.manifest.tools,
      cwd: projectRoot,
      model,
    });

    progress?.onStepEnd({ agent: flowStep.agent, index: state.current_step_index, result });

    // ── Handle failure ─────────────────────────────────────────
    if (!result.success) {
      if (attempt < maxAttempts && result.error) {
        // Apply error result with retryable flag, then continue loop
        const transition = applyStepResult(
          state,
          { result: "error", message: result.error, retryable: true },
          gateLoader,
        );
        state = transition.state;
        continue;
      }
      // No retries left → block
      const transition = applyStepResult(
        state,
        { result: "error", message: result.error ?? "Step failed", retryable: false },
        gateLoader,
      );
      return transition.state;
    }

    // ── Verify outputs ─────────────────────────────────────────
    const strictOutputs = state.flow_snapshot.strictOutputs ?? true;
    const outputs = agent.manifest.outputs ?? [];
    const verification = outputVerifier.verify(
      outputs.map(o => path.join(workflowDir, o)),
      workflowDir,
    );

    if (!verification.allExist) {
      if (strictOutputs) {
        if (attempt < maxAttempts) {
          // Outputs missing but retries remain — treat as error and retry
          const missingList = verification.missing.join(", ");
          const transition = applyStepResult(
            state,
            { result: "error", message: `Missing outputs: ${missingList}`, retryable: true },
            gateLoader,
          );
          state = transition.state;
          continue;
        }
        // No retries left → block
        const transition = applyStepResult(
          state,
          { result: "error", message: `Missing outputs: ${verification.missing.join(", ")}`, retryable: false },
          gateLoader,
        );
        return transition.state;
      } else {
        // Non-strict mode: warn about missing outputs but don't block
        if (progress && verification.missing.length > 0) {
          console.warn(`Warning: expected outputs missing (non-strict mode): ${verification.missing.join(", ")}`);
        }
      }
    }

    // ── Apply success to engine ────────────────────────────────
    const transition = applyStepResult(
      state,
      { result: "success", message: result.summary },
      gateLoader,
    );
    state = transition.state;

    // ── Gate? ──────────────────────────────────────────────────
    if (flowStep.requestApproval && agent.manifest.approval && state.gate) {
      const gateStepIndex = state.gate.stepIndex;

      // Engine entered awaiting_user with a gate object — present it
      progress?.onGate({
        header: state.gate.header,
        previewPath: state.gate.preview
          ? path.join(workflowDir, state.gate.preview)
          : undefined,
        options: state.gate.options,
      });

      state = await presentAndResolveGate(
        state, state.gate, workflowDir, projectRoot,
        gatePresenter, progress,
      );

      // After gate resolution, engine sets status to "in_progress"
      // for BOTH approved and rejected. Distinguish by checking if
      // the gated step was reset to "pending" (rejected/retry).
      const gatedStep = state.steps[gateStepIndex];
      if (gatedStep && gatedStep.status === "pending") {
        // Rejected — step was reset for retry, inject feedback
        if (gatedStep.last_feedback) {
          feedbackForRetry = gatedStep.last_feedback;
        }
        continue; // retry the step
      }

      // Approved (step completed, advanced to next) or abandoned
      return state;
    }

    // No gate → step is done, break out of retry loop
    return state;
  }

  return state;
}

// ============================================================================
// presentAndResolveGate — shared gate presentation + engine resolution
// ============================================================================

/**
 * Present an approval gate to the user and feed the answer back to the engine.
 *
 * Shared between the normal step-gate flow (after agent success) and the
 * resume-from-crash flow (when state was persisted as awaiting_user).
 *
 * @param state - Current workflow state (must be awaiting_user with a gate)
 * @param gate - The WorkflowGate from the engine state
 * @param workflowDir - Feature workflow directory
 * @param projectRoot - Project root
 * @param gatePresenter - Gate presenter implementation
 * @param progress - Optional progress reporter
 * @returns The new workflow state after gate resolution
 */
async function presentAndResolveGate(
  state: WorkflowState,
  gate: { header: string; preview?: string; options: Array<{ label: string; description: string; advance: boolean; abort?: boolean; feedback?: boolean }>; stepIndex: number },
  workflowDir: string,
  projectRoot: string,
  gatePresenter: GatePresenter,
  progress?: FlowProgress,
): Promise<WorkflowState> {
  const previewPath = gate.preview
    ? path.join(workflowDir, gate.preview)
    : undefined;

  // ── Layer boundary: GatePresenter ────────────────────────────
  const answer = await gatePresenter.present({
    header: gate.header,
    previewPath,
    options: gate.options,
  }, projectRoot);

  if (answer.advance) {
    // Approved — advance to next step
    const gateTransition = applyGateAnswer(state, {
      stepIndex: gate.stepIndex,
      chosenLabel: answer.label,
      advance: true,
    });
    return gateTransition.state;
  }

  if (answer.abort) {
    // Abandon workflow
    const gateTransition = applyGateAnswer(state, {
      stepIndex: gate.stepIndex,
      chosenLabel: answer.label,
      advance: false,
      abort: true,
    });
    return gateTransition.state;
  }

  // Reject with feedback → reset step for retry
  const gateTransition = applyGateAnswer(state, {
    stepIndex: gate.stepIndex,
    chosenLabel: answer.label,
    advance: false,
    feedback: answer.feedback,
  });
  return gateTransition.state;
}
