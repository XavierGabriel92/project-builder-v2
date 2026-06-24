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
  /** Optional callback for live activity updates during agent execution.
   *  Called with a human-readable message describing current activity. */
  onActivity?: (message: string) => void;

  /** Optional callback for structured flow_step_update tool calls.
   *  Receives phase, message, current path/tool from the agent's flow_step_update tool. */
  onFlowStepUpdate?: (update: {
    phase?: string;
    message?: string;
    currentPath?: string;
    currentTool?: string;
    status?: "working" | "blocked" | "needs_attention";
  }) => void;

  /** Optional callback for debug-level logging during agent execution.
   *  The orchestrator sets this when --debug is active. The runner writes
   *  detailed per-event timing (tool calls, turns, session lifecycle) to the
   *  same gate-debug.log file. */
  debugLog?: (entry: string) => void;

  /**
   * When present, the runner MUST continue the existing session instead of
   * creating a new one. The runner returns this ID in AgentRunResult.sessionId
   * after the first invocation, and the orchestrator passes it back on retries.
   * Same agent + same step = same session.
   */
  sessionId?: string;

  /**
   * Path to a persisted session JSONL file. Used on resume after a crash —
   * the runner reloads the session from disk and continues where it left off.
   * Only set on the first run after resume; subsequent retries use sessionId.
   */
  sessionFile?: string;

  /**
   * Workflow output directory (.temp/{featurePath}). The runner stores
   * session files here in .memory/ so they're co-located with workflow.json
   * and cleaned up when .temp/ is deleted.
   */
  workflowDir?: string;
}

export interface AgentRunResult {
  /** Whether the agent considers its work successful. */
  success: boolean;
  /** Human-readable summary of what happened (used in step activity messages). */
  summary: string;
  /** Model display info (e.g. "DeepSeek V4 Pro (1.0M)"). */
  modelInfo?: string;
  /** Thinking level used (e.g. "high", "medium", "low"). */
  thinkingLevel?: string;
  /** Full conversation messages (for debugging, audit, doc-sync step). */
  messages?: unknown[];
  /** Error details if failed. */
  error?: string;

  /** Token usage from the agent run (when available from the runner). */
  tokenUsage?: {
    input: number;
    output: number;
  };

  /**
   * Opaque session identifier. The orchestrator passes this back in
   * AgentRunInput.sessionId on retries so the runner can continue the
   * same conversation instead of starting fresh.
   */
  sessionId?: string;

  /**
   * Path to the persisted session JSONL file. Written by the runner after
   * the first invocation so the orchestrator can persist it in workflow
   * state and reload it on resume after a crash.
   */
  sessionFile?: string;
}

export interface AgentRunner {
  /** Unique identifier, e.g. "pi-sdk", "claude-code". */
  readonly name: string;
  /** Run the agent and return when it completes (or errors). */
  run(input: AgentRunInput): Promise<AgentRunResult>;

  /**
   * Release any resources held for a session. Called by the orchestrator
   * when a step moves past retries (advance, block, or abandon).
   * Safe to call multiple times for the same ID — must be idempotent.
   */
  disposeSession?(sessionId: string): void;
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
    steps?: Array<{ agent: string; status: "completed" | "running" | "pending"; maxAttempts: number; requestApproval?: boolean; phase?: string; startedAt?: string; completedAt?: string; attempt?: number }>;
  }): void;

  /** Called when a step is about to execute (fresh start or retry). */
  onStepStart(step: { agent: string; index: number; attempt: number; maxAttempts: number }): void;

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

  /** Called when the agent reports current activity during execution.
   *  Receives a human-readable message plus optional phase, path, tool, and status context. */
  onStepActivity?(step: { agent: string; index: number; message: string; phase?: string; path?: string; status?: "working" | "blocked" | "needs_attention"; currentTool?: string }): void;

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
