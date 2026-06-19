/**
 * Resume Support
 *
 * Finds resumable workflows in `.temp/` directories so that
 * a crashed or interrupted flow can continue from where it left off.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { WorkflowState } from "../engine/types.ts";
import { readWorkflow } from "../engine/persistence.ts";
import { currentStep } from "../engine/transitions.ts";

// ============================================================================
// Types
// ============================================================================

export interface ResumableWorkflow {
  /** Feature path (directory name in .temp/, e.g. "18-06-2026-user-auth"). */
  featurePath: string;
  /** The full workflow state from workflow.json. */
  state: WorkflowState;
  /** Modification time of workflow.json (ms since epoch). */
  mtime: number;
}

// ============================================================================
// Discovery
// ============================================================================

/**
 * Find all resumable workflows in a project.
 *
 * Scans .temp subdirectories for workflow.json files and returns
 * workflows with status "in_progress" or "awaiting_user",
 * sorted by most recently modified first.
 *
 * @param projectRoot - Root directory of the user's project.
 * @returns Array of resumable workflows (empty if none).
 */
export function findResumableWorkflows(
  projectRoot: string,
): ResumableWorkflow[] {
  const tempDir = path.join(projectRoot, ".temp");
  if (!fs.existsSync(tempDir)) return [];

  const results: ResumableWorkflow[] = [];

  for (const entry of fs.readdirSync(tempDir)) {
    const dirPath = path.join(tempDir, entry);
    const wfStat = fs.statSync(dirPath, { throwIfNoEntry: false });
    if (!wfStat?.isDirectory()) continue;

    const wfPath = path.join(dirPath, "workflow.json");
    if (!fs.existsSync(wfPath)) continue;

    try {
      const state = readWorkflow(projectRoot, entry);
      if (!state) continue;

      // Only in-progress and awaiting_user workflows are resumable
      if (
        state.status !== "in_progress" &&
        state.status !== "awaiting_user" &&
        state.status !== "abandoned"
      ) {
        continue;
      }

      const stat = fs.statSync(wfPath);
      results.push({
        featurePath: entry,
        state,
        mtime: stat.mtimeMs,
      });
    } catch {
      // Corrupt or inaccessible workflow, skip
    }
  }

  // Sort by most recently modified first
  return results.sort((a, b) => b.mtime - a.mtime);
}

// ============================================================================
// Resume info
// ============================================================================

/**
 * Extract resume information from a workflow state.
 *
 * @param workflow - The resumable workflow.
 * @returns Flow id, feature name/context, and current step info.
 */
export function resumeWorkflow(workflow: ResumableWorkflow): {
  flowId: string;
  featureName: string;
  featureContext?: string;
  currentStepIndex: number;
  currentStepAgent: string;
} {
  const step = currentStep(workflow.state);
  return {
    flowId: workflow.state.flow_id,
    featureName: workflow.state.feature,
    featureContext: workflow.state.feature_context,
    currentStepIndex: workflow.state.current_step_index,
    currentStepAgent: step?.agent ?? "(done)",
  };
}
