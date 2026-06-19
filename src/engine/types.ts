/**
 * Type definitions for the declarative flow engine
 *
 * Three layers:
 * 1. FlowDefinition — ordered steps (when: order, retries, approval flag)
 * 2. AgentManifest — self-contained step contract (tools, subagents, approval UI, prompt)
 * 3. WorkflowState — frozen run state persisted to workflow.json
 */

// ============================================================================
// Flow Definition (§7)
// ============================================================================

/** A single step in a flow. The flow says *when* — the agent .md says *everything else*. */
export interface FlowStep {
  /** Defaults to agent id; used in workflow.steps[].id */
  id?: string;

  /** → agents/{agent}.md */
  agent: string;

  /** After supervisor submits "success", pause for user approval */
  requestApproval?: boolean;

  /** Auto-retry on error until exhausted (default 1) */
  attempts?: number;

  /**
   * Optional model override for this step (e.g. "google/gemini-2.5-pro").
   * When set, the StepInstruction includes it so the routing layer can use it.
   * When unset, the default system model is used.
   */
  model?: string;
}

/** A flow is an ordered list of agent names + approval flags — nothing domain-specific. */
export interface FlowDefinition {
  id: string;
  version: number;
  description: string;
  steps: FlowStep[];

  /**
   * If true, stepComplete with result:"success" will BLOCK if declared output files are missing.
   * Default: false (backward compatible — outputs missing produce warnings only).
   */
  strictOutputs?: boolean;

  /**
   * Default model for all steps (overridden by per-step FlowStep.model).
   * Format: "provider/model-id" (e.g. "anthropic/claude-sonnet-4-5").
   * When unset, the runner's default model is used.
   */
  defaultModel?: string;
}

// ============================================================================
// Agent Manifest (§8)
// ============================================================================

/** All Pi built-in tools that agents can declare. */
export type AgentTool =
  | "subagent"
  | "ask_user_question"
  | "read"
  | "write"
  | "edit"
  | "bash"
  | "web_search"
  | "code_search"
  | "fetch_content"
  | "get_search_content"
  | "mcp"
  | "flow_step_update";

/** An approval dialog option — owned by the agent .md */
export interface ApprovalOption {
  label: string;
  description: string;
  /** Which option means "approved" → advance to next step */
  advance: boolean;
  /** If true and advance is false, abort/abandon the workflow instead of retrying */
  abort?: boolean;
  /** If true, present a text input when this option is chosen so the user can explain what to change */
  feedback?: boolean;
}

/** Approval dialog definition — agent .md owns what "approval" means for this step */
export interface ApprovalManifest {
  /** Shown as the question header (e.g. "Spec review") */
  header: string;
  /** Optional: path to an artifact to show as preview (relative to feature path) */
  preview?: string;
  /** Options presented to the user */
  options: ApprovalOption[];
}

/** Self-describing step contract from agents/*.md */
export interface AgentManifest {
  id: string;
  version: number;

  /** Tools available to this agent */
  tools: AgentTool[];

  /** Subagent name → path mapping (relative to agents/) */
  subagents?: Record<string, string>;

  /** Fan-out configuration: main agent calls Pi subagent tool */
  parallel?: {
    /** Identifier for what to iterate over (e.g. "service_dirs") */
    over: string;
    /** Subagent to fan out to */
    subagent: string;
    /** Max concurrent workers */
    concurrency?: number;
  };

  /** Expected output files (relative to feature path) */
  outputs?: string[];

  /**
   * If the flow step has requestApproval: true, the engine will
   * present this dialog after the supervisor submits "success".
   * The agent owns what "approval" means for this step.
   */
  approval?: ApprovalManifest;
}

// ============================================================================
// Step Result (§9)
// ============================================================================

/** Submitted by the supervisor only. Subagents return text to the supervisor. */
export interface StepResult {
  result: "success" | "error";
  message: string;
  /** Only relevant for error results */
  retryable?: boolean;
  /** Optional structured state updates submitted by the supervisor */
  metadata?: {
    service_dirs?: string[];
  };
}

/** User-facing, incremental activity reported while a step is running. */
export interface WorkflowStepActivity {
  /** Short semantic phase, e.g. "reading plan", "fan out workers", "running checks". */
  phase?: string;
  /** Human-readable status line for the current work. */
  message?: string;
  /** Whether the step is still progressing or needs intervention. */
  status?: "working" | "blocked" | "needs_attention";
  /** Correlated subagent async run ids, when known. */
  child_run_ids?: string[];
  /** Optional current tool summary for direct supervisor work. */
  current_tool?: string;
  /** Optional path/file currently being inspected or changed. */
  current_path?: string;
  updated_at: string;
}

/** Incremental update submitted by the supervisor while the current step runs. */
export interface WorkflowStepUpdate {
  stepIndex?: number;
  phase?: string;
  message?: string;
  status?: WorkflowStepActivity["status"];
  childRunIds?: string[];
  currentTool?: string;
  currentPath?: string;
}

// ============================================================================
// Workflow State (§10)
// ============================================================================

export type StepStatus = "pending" | "running" | "completed" | "failed";
export type WorkflowStatus = "in_progress" | "blocked" | "awaiting_user" | "abandoned" | "done";
export type AwaitingState = null | "user_gate";

/** Per-step state within a workflow run */
export interface WorkflowStep {
  index: number;
  id: string;
  agent: string;
  status: StepStatus;
  result?: StepResult;
  activity?: WorkflowStepActivity;
  attempt: number;
  started_at?: string;
  completed_at?: string;
  /** Feedback from the most recent gate answer for this step (persists across retries) */
  last_feedback?: string;
}

/** Gate state when workflow is awaiting user approval */
export interface WorkflowGate {
  /** From agent approval.header */
  header: string;
  /** From agent approval.preview */
  preview?: string;
  /** From agent approval.options */
  options: ApprovalOption[];
  /** Index of the step awaiting gate */
  stepIndex: number;
  /**
   * Unique nonce generated by the engine when the gate is created.
   * The agent must pass this back in `flow_record_gate` to prove it
   * went through the complete gate cycle (flow_continue → present gate → record).
   * The engine rejects answers with missing or incorrect nonces.
   */
  nonce: string;
}

/** Frozen run state persisted to workflow.json */
export interface WorkflowState {
  schema_version: number;
  feature: string;
  feature_path: string;
  project_root: string;
  flow_id: string;
  flow_version: number;
  /** Frozen snapshot of the flow definition at start time */
  flow_snapshot: FlowDefinition;
  current_step_index: number;
  status: WorkflowStatus;
  awaiting: AwaitingState;
  gate?: WorkflowGate;
  steps: WorkflowStep[];
  service_dirs?: string[];
  /** Free-form user description of the feature (collected at workflow start). Injected into every agent prompt. */
  feature_context?: string;
  /** Auto-discovered project rules from AGENTS.md, docs/, README.md. Injected into every agent prompt. */
  project_rules_context?: string;
  build_status?: "DONE" | "BLOCKED" | null;
}

// ============================================================================
// Step Instruction (§11) — returned to supervisor
// ============================================================================

/** What the engine returns to the supervisor for a step */
export interface StepInstruction {
  /** The agent to run */
  agent: string;
  /** The step index in the flow */
  stepIndex: number;
  /** Tools this agent is allowed to use */
  tools: AgentTool[];
  /** Subagent name → path mapping */
  subagents?: Record<string, string>;
  /** Fully loaded subagent contracts for supervisor fan-out */
  subagentInstructions?: Record<
    string,
    {
      path: string;
      tools: AgentTool[];
      prompt: string;
    }
  >;
  /** Parallel fan-out config */
  parallel?: AgentManifest["parallel"];
  /** The agent's prompt (body of the .md file) */
  prompt: string;
  /** Whether this step requires user approval after completion */
  requestApproval: boolean;
  /** If requestApproval is true, the full approval dialog manifest for advance visibility */
  approvalManifest?: ApprovalManifest;
  /** Attempt number (1-indexed) */
  attempt: number;
  /** Max attempts for this step */
  maxAttempts: number;
  /** Expected outputs */
  expectedOutputs?: string[];
  /** Feedback from a previous gate answer on this step (when retrying) */
  lastFeedback?: string;
  /** Error message from the most recent failed attempt (when retrying after an error, not a gate rejection) */
  lastError?: string;
  /**
   * Optional model override for this step.
   * When set, the LLM should use this model instead of the default.
   */
  model?: string;
}

// ============================================================================
// Gate Answer (§11)
// ============================================================================

/** User's answer to an approval gate */
export interface GateAnswer {
  stepIndex: number;
  chosenLabel: string;
  advance: boolean;
  /** If true and advance is false, abort/abandon the workflow instead of retrying */
  abort?: boolean;
  /** Free-form user feedback provided when the chosen option requested it */
  feedback?: string;
  /**
   * The nonce from the active gate, obtained from `flow_continue`.
   * The engine validates this matches the active gate's nonce and
   * rejects answers fabricated without going through the gate cycle.
   */
  gateNonce?: string;
}

// ============================================================================
// Constants
// ============================================================================

export const SCHEMA_VERSION = 1;
export const DEFAULT_ATTEMPTS = 1;
export const WORKFLOW_FILE = "workflow.json";
export const TEMP_DIR = ".temp";
