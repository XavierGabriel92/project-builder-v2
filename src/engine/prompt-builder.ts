/**
 * Prompt Builder
 *
 * Extracted from v1 engine.ts — assembles the system prefix and task prompt
 * for each agent step. Strips all LLM-supervisor protocol instructions
 * (APPROVAL_INSTRUCTION, SUPPRESS_SUBAGENT_PROGRESS, SUBAGENT_COMPLETION_SUFFIX)
 * since v2 handles gates, subagents, and flow control in pure TypeScript.
 */

import * as fs from "node:fs";
import * as path from "node:path";
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
export function buildSystemPrefix(state: WorkflowState, outputs?: string[]): string {
  return workspacePrefix(
    state.project_root,
    state.feature_path,
    state.feature_context,
    state.project_rules_context,
    outputs,
  );
}

// ============================================================================
// buildPrompt — previous steps + agent instructions + completion
// ============================================================================

/**
 * Build the task-specific prompt for an agent step.
 *
 * Contains:
 * - Pipeline role intro (first agent only — shows what downstream agents expect)
 * - Previous steps context (output file contents from completed steps)
 * - Agent's instructions (body of the .md file)
 * - Completion suffix (tell the agent to stop when done)
 *
 * This goes into the user message of the agent session.
 *
 * NOTE: workspace + project rules + feature context are injected via
 * buildSystemPrefix into the system prompt — NOT duplicated here.
 *
 * DOES NOT INCLUDE:
 * - APPROVAL_INSTRUCTION (gates handled by orchestrator, not LLM protocol)
 * - SUPPRESS_SUBAGENT_PROGRESS (subagents invoked via AgentRunner, not LLM tool)
 * - SUBAGENT_COMPLETION_SUFFIX (subagents return to orchestrator, not LLM)
 */
export function buildPrompt(agent: LoadedAgent, state: WorkflowState): string {
  return [
    pipelineRoleIntro(state),
    previousStepsContext(state),
    agent.prompt,
    completionSuffix(
      state.flow_snapshot.strictOutputs ?? true,
      agent.manifest.outputs,
      state.feature_path,
    ),
  ]
    .filter(Boolean)
    .join("\n\n");
}

// ============================================================================
// Internal — extracted verbatim from v1 engine.ts
// ============================================================================

function workspacePrefix(
  projectRoot: string,
  featurePath: string,
  featureContext?: string,
  projectRulesContext?: string,
  outputs?: string[],
): string {
  const tempDir = `${projectRoot}/.temp/${featurePath}`;
  const outputFileList = outputs && outputs.length > 0
    ? outputs.map(o => `${tempDir}/${o}`).join(", ")
    : "";

  let prefix =
    "## Workspace\n\n" +
    "Your declared output files MUST be written to " +
    tempDir +
    "/.";

  if (outputFileList) {
    prefix += " Specifically, you must write: " + outputFileList + ".";
  }

  prefix +=
    " If the instructions below explicitly tell you to write files directly to the project tree, follow those instructions.\n";

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

/**
 * Map of agent IDs to the output files they declare.
 *
 * Mirrors the `outputs` field from each agent's YAML frontmatter in agents/*.md.
 * When adding a new agent with declared outputs, add its entry here so downstream
 * agents receive the output content in their prompt context.
 *
 * Agents without declared outputs (no entry) fall back to the activity message.
 */
const AGENT_OUTPUTS: Record<string, string[]> = {
  "spec-write": ["spec.md"],
  "plan": ["plan.md", "service-dirs.json"],
  "implement": ["implementation-notes.md"],
  "review": ["review-findings.md"],
  "lint": ["lint-report.md"],
  "doc-sync": ["doc-sync-report.md"],
  "triage": ["triage-report.md"],
  "reproduce": ["reproduce-report.md"],
  "diagnose": ["diagnose-report.md"],
  "fix": ["fix-notes.md"],
  "verify": ["verify-report.md"],
};

/** Max bytes to read and inject from a single output file. Above this, truncate. */
const MAX_OUTPUT_FILE_BYTES = 8_000;

/** Max total bytes across all injected output files. Prevents prompt bloat. */
const MAX_TOTAL_OUTPUT_BYTES = 30_000;

/**
 * Build a context section that includes the actual content of output files
 * from completed previous steps.
 *
 * Instead of truncating vague activity messages to 300 chars (which downstream
 * agents ignore anyway), this reads the real output files that previous agents
 * wrote to .temp/{feature_path}/ and injects their content directly.
 *
 * Downstream agents no longer need to spend 2-4 turns re-reading spec.md,
 * plan.md, etc. — the content is already in their first-turn context.
 *
 * Falls back to the old activity-message digest for agents without declared
 * outputs or when output files are missing.
 */
function previousStepsContext(state: WorkflowState): string {
  const completed = state.steps.filter(
    (s) => s.status === "completed",
  );
  if (completed.length === 0) return "";

  const tempDir = path.join(state.project_root, ".temp", state.feature_path);
  const lines: string[] = [
    "## Context from Previous Steps\n",
    "These steps have already been completed. Their output files are included " +
      "below so you have full context without re-reading them.\n",
  ];

  let totalBytes = 0;

  for (const step of completed) {
    let anyFileInjectedForStep = false;

    const outputs = AGENT_OUTPUTS[step.agent];
    if (!outputs || outputs.length === 0) {
      // No declared outputs — fall back to activity message
      if (step.activity?.message) {
        const msg = step.activity.message;
        const short = msg.length > 300 ? msg.slice(0, 297) + "..." : msg;
        lines.push("- **" + step.agent + "** (completed): " + short);
      }
      continue;
    }

    for (const output of outputs) {
      const filePath = path.join(tempDir, output);
      try {
        if (!fs.existsSync(filePath)) continue;
        const stat = fs.statSync(filePath);
        if (!stat.isFile() || stat.size === 0) continue;

        const readSize = Math.min(stat.size, MAX_OUTPUT_FILE_BYTES);
        const content = readFileHead(filePath, readSize);
        const truncated = stat.size > MAX_OUTPUT_FILE_BYTES;

        if (totalBytes + readSize > MAX_TOTAL_OUTPUT_BYTES) {
          // Budget exhausted — include a note but skip full content
          lines.push(
            "- **" + step.agent + " → " + output + "**: " +
              "(file too large for prompt — read it from " +
              ".temp/" + state.feature_path + "/" + output + " if needed)",
          );
          continue;
        }

        totalBytes += readSize;
        anyFileInjectedForStep = true;

        lines.push(
          "### " + step.agent + " → " + output + "\n",
          "```",
          content,
          (truncated ? "\n[...truncated from " + formatBytes(stat.size) + " — read the full file for complete context]" : ""),
          "```",
        );
      } catch {
        // File unreadable — fall through to activity message
      }
    }

    // If no file was injected for this step, fall back to activity message
    if (!anyFileInjectedForStep && step.activity?.message) {
      const msg = step.activity.message;
      const short = msg.length > 300 ? msg.slice(0, 297) + "..." : msg;
      lines.push("- **" + step.agent + "** (completed): " + short);
    }
  }

  return lines.join("\n") + "\n";
}

/**
 * Read the first `bytes` bytes of a file as UTF-8.
 */
function readFileHead(filePath: string, bytes: number): string {
  const buf = Buffer.alloc(bytes);
  const fd = fs.openSync(filePath, "r");
  try {
    const read = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.toString("utf-8", 0, read);
  } finally {
    fs.closeSync(fd);
  }
}

/** Format byte count for human display. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

/**
 * Inject pipeline role context for the first agent in a flow.
 *
 * The first agent (e.g., spec-write) has no prior steps to draw context from
 * but has the hardest job — it must produce output that downstream agents can
 * act on without guessing. This section tells it what agents follow and what
 * they need.
 */
function pipelineRoleIntro(state: WorkflowState): string {
  const completedCount = state.steps.filter(
    (s) => s.status === "completed",
  ).length;
  if (completedCount > 0) return "";

  const flowSteps = state.flow_snapshot.steps;
  const totalSteps = flowSteps.length;
  const currentIndex = state.current_step_index;
  const downstream = flowSteps.slice(currentIndex + 1);

  if (downstream.length === 0) return "";

  const lines: string[] = [
    "## Your Role in the Pipeline\n",
    "You are step " + (currentIndex + 1) + " of " + totalSteps +
      " in the `" + state.flow_id + "` flow. After you, the following agents will run:",
  ];

  for (const ds of downstream) {
    const desc = STEP_DESCRIPTIONS[ds.agent] ?? "executes its task";
    lines.push("- **" + ds.agent + "**: " + desc);
  }

  lines.push(
    "",
    "The quality of your output determines whether downstream agents can work " +
      "without guessing. Every vague requirement or unresolved question you leave " +
      "will cause cascading errors downstream. Be thorough now so they don't have " +
      "to compensate later.",
  );

  return lines.join("\n");
}

/** Short descriptions of what each agent in the pipeline does. */
const STEP_DESCRIPTIONS: Record<string, string> = {
  "spec-write": "writes a detailed specification covering product, engineering, risks, and non-functional requirements",
  "plan": "decomposes the spec into an executable plan with tasks, dependencies, and test strategy",
  "implement": "dispatches workers to implement each task from the plan",
  "review": "audits every engineering rule against the changed code and fixes violations",
  "lint": "ensures the codebase is lint-clean across all service directories",
  "doc-sync": "writes feature records and updates reference documentation",
  "triage": "triages the bug report and determines severity and scope",
  "reproduce": "reproduces the bug and documents reproduction steps",
  "diagnose": "diagnoses the root cause of the bug",
  "fix": "implements the bug fix",
  "verify": "verifies the fix and runs regression tests",
};

function completionSuffix(strictOutputs: boolean, outputs?: string[], featurePath?: string): string {
  const blockMsg = strictOutputs
    ? "If you do not write them, the workflow will block."
    : "If you do not write them, warnings will appear when you complete the step.";

  const outputNames = outputs && outputs.length > 0
    ? outputs.map(o => `${o} (at .temp/${featurePath}/${o})`).join(", ")
    : "";

  const fileListMsg = outputNames
    ? ` Your declared output files are: ${outputNames}.`
    : "";

  return (
    "\n\n## Important\n\n" +
    "Follow the instructions above carefully. Do not skip steps or complete this step " +
    "without doing the work described. The workflow expects the declared output files " +
    "to exist." +
    fileListMsg +
    " " +
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
