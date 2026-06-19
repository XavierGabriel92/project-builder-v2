/**
 * Project Builder v2 — Stable Ports
 *
 * Every interface the orchestrator depends on. Swap implementations
 * behind these interfaces to change agent backends, gate UIs, or
 * verification strategies without touching the orchestrator.
 *
 * New implementations go in:
 *   runners/   → AgentRunner
 *   gates/     → GatePresenter
 *   verifiers/ → OutputVerifier
 *   progress/  → FlowProgress
 */

// ============================================================================
// AgentRunner — invoke an agent (LLM session) and return results
// ============================================================================

export interface AgentRunInput {
  /** The full prompt (body of agent .md, assembled by the engine). */
  prompt: string;
  /** System-level instructions (workspace rules, previous steps context). */
  systemPrompt?: string;
  /** Tool names the agent is allowed to use. */
  tools: string[];
  /** Working directory for the agent session. */
  cwd: string;
  /** Optional model override (e.g. "google/gemini-2.5-pro"). Runner decides how to resolve. */
  model?: string;
  /** Files to read into context before the agent starts. */
  contextFiles?: string[];
}

export interface AgentRunResult {
  /** Whether the agent considers its work successful. */
  success: boolean;
  /** Human-readable summary of what happened (used in step activity messages). */
  summary: string;
  /** Declared output files and whether they exist on disk. */
  expectedOutputs: Array<{ path: string; exists: boolean }>;
  /** Full conversation messages (for debugging, audit, doc-sync step). */
  messages?: unknown[];
  /** Error details if failed. */
  error?: string;
}

export interface AgentRunner {
  /** Unique identifier, e.g. "pi-sdk", "claude-code". */
  readonly name: string;
  /** Run the agent and return when it completes (or errors). */
  run(input: AgentRunInput): Promise<AgentRunResult>;
}

// ============================================================================
// GatePresenter — show approval dialog, collect user answer
// ============================================================================

export interface GateInput {
  /** Shown as the question header (e.g. "Spec Review"). */
  header: string;
  /** Path to a file to show as preview (resolved by the presenter). */
  previewPath?: string;
  /** Options presented to the user. */
  options: Array<{
    label: string;
    description: string;
    /** Which option means "approved" → advance to next step. */
    advance: boolean;
    /** If true and advance is false, abort/abandon the workflow. */
    abort?: boolean;
    /** If true, present a text input so the user can explain what to change. */
    feedback?: boolean;
  }>;
}

export interface GateAnswer {
  /** Exact label of the chosen option. */
  label: string;
  /** Whether this choice means "advance to next step." */
  advance: boolean;
  /** Whether this choice means "abandon the workflow." */
  abort?: boolean;
  /** Free-form user feedback (present when the chosen option had feedback: true). */
  feedback?: string;
}

export interface GatePresenter {
  /** Unique identifier, e.g. "inquirer", "pi-tui", "auto-approve". */
  readonly name: string;
  /**
   * Show the gate to the user and wait for their answer.
   * Blocks until an answer is provided. Must not throw under normal
   * user interaction (Esc/Ctrl+C should return an abort-type answer).
   */
  present(gate: GateInput, cwd: string): Promise<GateAnswer>;
}

// ============================================================================
// OutputVerifier — check that expected files exist
// ============================================================================

export interface OutputVerifier {
  /**
   * Verify that declared output files exist.
   * @param expectedOutputs - paths relative to feature workflow dir
   * @param cwd - project root
   */
  verify(expectedOutputs: string[], cwd: string): {
    allExist: boolean;
    missing: string[];
    existing: string[];
  };
}

// ============================================================================
// FlowProgress — observability hooks (optional)
// ============================================================================

export interface FlowProgress {
  // ── Required lifecycle hooks ────────────────────────────────

  /** Called once when the flow run begins. */
  onFlowStart(info: {
    flowId: string;
    feature: string;
    totalSteps: number;
    /** Step history for resume display (agent name + status per step). */
    steps?: Array<{ agent: string; status: "completed" | "running" | "pending" }>;
  }): void;

  /** Called when a step is about to execute (fresh start or retry). */
  onStepStart(step: { agent: string; index: number; attempt: number }): void;

  /** Called when a step completes (success or failure). */
  onStepEnd(step: { agent: string; index: number; result: AgentRunResult }): void;

  /** Called when a gate is about to be presented to the user. */
  onGate(gate: GateInput): void;

  /** Called when the flow successfully finishes all steps. */
  onFlowComplete(): void;

  /** Called when the user explicitly abandons the workflow via a gate abort option. */
  onFlowAbandoned(): void;

  /** Called when a step exhausts all retry attempts and the flow blocks. */
  onFlowBlocked(error: string): void;

  // ── Optional hooks (no-op if not implemented) ────────────────

  /** Called when a step is about to retry, with the reason for the retry. */
  onStepRetry?(step: {
    agent: string;
    index: number;
    attempt: number;
    reason: "error" | "gate_rejected" | "missing_outputs";
  }): void;

  /** Called after output verification, showing what was found. */
  onOutputVerification?(result: {
    allExist: boolean;
    missing: string[];
    existing: string[];
  }): void;
}
