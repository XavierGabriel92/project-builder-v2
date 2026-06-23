/**
 * Prompt Builder
 *
 * Extracted from v1 engine.ts — assembles the system prefix and task prompt
 * for each agent step. Strips all LLM-supervisor protocol instructions
 * (APPROVAL_INSTRUCTION, SUPPRESS_SUBAGENT_PROGRESS, SUBAGENT_COMPLETION_SUFFIX)
 * since v2 handles gates, subagents, and flow control in pure TypeScript.
 */

import type { WorkflowState } from "./types.ts";
import type { LoadedAgent } from "./agent-loader.ts";

// ============================================================================
// buildSystemPrefix — workspace + project rules + feature context
// ============================================================================

/**
 * Build the system prompt prefix injected at the top of every agent session.
 *
 * Contains:
 * - Workspace output directory instructions
 * - Project rules (AGENTS.md content, auto-discovered)
 * - Feature context (user's description of what they want to build)
 *
 * This is stable across the session — use as the system prompt.
 */
export function buildSystemPrefix(state: WorkflowState): string {
  return workspacePrefix(
    state.feature_path,
    state.feature_context,
    state.project_rules_context,
  );
}

// ============================================================================
// buildPrompt — previous steps + agent instructions + completion
// ============================================================================

/**
 * Build the task-specific prompt for an agent step.
 *
 * Contains:
 * - Previous steps digest (summaries, so agents don't re-read all files)
 * - Agent's instructions (body of the .md file)
 * - Completion suffix (tell the agent to stop when done)
 *
 * This goes into the user message of the agent session.
 *
 * DOES NOT INCLUDE:
 * - APPROVAL_INSTRUCTION (gates handled by orchestrator, not LLM protocol)
 * - SUPPRESS_SUBAGENT_PROGRESS (subagents invoked via AgentRunner, not LLM tool)
 * - SUBAGENT_COMPLETION_SUFFIX (subagents return to orchestrator, not LLM)
 */
export function buildPrompt(agent: LoadedAgent, state: WorkflowState): string {
  return [
    workspacePrefix(
      state.feature_path,
      state.feature_context,
      state.project_rules_context,
    ),
    previousStepsDigest(state),
    agent.prompt,
    completionSuffix(state.flow_snapshot.strictOutputs ?? true),
  ]
    .filter(Boolean)
    .join("\n\n");
}

// ============================================================================
// Internal — extracted verbatim from v1 engine.ts
// ============================================================================

function workspacePrefix(
  featurePath: string,
  featureContext?: string,
  projectRulesContext?: string,
): string {
  let prefix =
    "## Workspace\n\n" +
    "Your declared output files MUST be written to .temp/" +
    featurePath +
    "/. " +
    "Always write .temp/" +
    featurePath +
    "/plan.md, NOT plan.md. " +
    "If the instructions below explicitly tell you to write files directly to the project tree, follow those instructions.\n";

  if (projectRulesContext) {
    prefix +=
      "\n## Project Rules\n\n" +
      "The following rules, conventions, and architectural constraints were " +
      "discovered from the project. Follow them for every change you make.\n\n" +
      projectRulesContext +
      "\n";
  }

  if (featureContext) {
    prefix +=
      "\n## Feature Context\n\n" +
      "The user provided this description of what they want to build:\n\n" +
      featureContext +
      "\n";
  }

  return prefix;
}

function previousStepsDigest(state: WorkflowState): string {
  const completed = state.steps.filter(
    (s) => s.status === "completed" && s.activity?.message,
  );
  if (completed.length === 0) return "";

  const lines: string[] = [
    "## Previous Steps\n",
    "These steps have already been completed. The summaries below provide enough " +
      "context that you do NOT need to read their output files unless you need " +
      "specific details beyond what is summarized here.\n",
  ];

  for (const step of completed) {
    const msg = step.activity!.message!;
    const short = msg.length > 300 ? msg.slice(0, 297) + "..." : msg;
    lines.push("- **" + step.agent + "** (completed): " + short);
  }

  return lines.join("\n") + "\n";
}

function completionSuffix(strictOutputs: boolean): string {
  const blockMsg = strictOutputs
    ? "If you do not write them, the workflow will block."
    : "If you do not write them, warnings will appear when you complete the step.";

  return (
    "\n\n## Important\n\n" +
    "Follow the instructions above carefully. Do not skip steps or complete this step " +
    "without doing the work described. The workflow expects the declared output files " +
    "to exist. " +
    blockMsg +
    "\n\n" +
    "**CRITICAL: You MUST use the write tool to create every declared output file.** " +
    "Do NOT merely describe what the file would contain or claim it exists — actually " +
    "call the write tool and create it on disk. The workflow verifies file existence " +
    "on the filesystem, not your description of it." +
    "\n\n" +
    "## Completion\n\n" +
    "When you have finished all the work described above, stop. " +
    "Do not ask what step comes next in the workflow — the workflow advances automatically. " +
    "Keep using your tools (including ask_user_question, write, subagent) as instructed " +
    "until every declared output file exists on disk and every required phase is complete."
  );
}
