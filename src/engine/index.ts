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
