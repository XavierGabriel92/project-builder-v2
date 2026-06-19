/**
 * Flow Validation
 *
 * Validates flow definitions against available agent manifests.
 * Catches missing agents, gate steps without approval manifests,
 * and missing subagents before the orchestrator runs.
 */

import type { FlowDefinition } from "../engine/types.ts";
import { loadAgent } from "../engine/agent-loader.ts";

// ============================================================================
// Types
// ============================================================================

export interface ValidationError {
  flowId: string;
  stepIndex: number;
  agent: string;
  message: string;
}

// ============================================================================
// Validate a single flow
// ============================================================================

/**
 * Validate a flow definition against its agents directory.
 *
 * Checks:
 * 1. Every referenced agent has a .md manifest file
 * 2. Gate steps (requestApproval: true) have an approval block in their manifest
 *
 * @returns Array of validation errors (empty if valid).
 */
export function validateFlow(
  flow: FlowDefinition,
  agentsDir: string,
): ValidationError[] {
  const errors: ValidationError[] = [];

  for (let i = 0; i < flow.steps.length; i++) {
    const step = flow.steps[i];

    // 1. Agent .md exists
    let agent;
    try {
      agent = loadAgent(agentsDir, step.agent);
    } catch (err) {
      errors.push({
        flowId: flow.id,
        stepIndex: i,
        agent: step.agent,
        message: `Agent "${step.agent}" not found: ${(err as Error).message}`,
      });
      continue; // skip further validation for missing agent
    }

    // 2. Gate step must have approval manifest
    if (step.requestApproval && !agent.manifest.approval) {
      errors.push({
        flowId: flow.id,
        stepIndex: i,
        agent: step.agent,
        message: `Step requires approval but agent "${step.agent}" has no approval block in its manifest`,
      });
    }
  }

  return errors;
}

// ============================================================================
// Validate multiple flows
// ============================================================================

/**
 * Validate an array of flow definitions.
 *
 * @returns Flat array of all validation errors across all flows.
 */
export function validateFlows(
  flows: FlowDefinition[],
  agentsDir: string,
): ValidationError[] {
  return flows.flatMap(f => validateFlow(f, agentsDir));
}
