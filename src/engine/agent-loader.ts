/**
 * Agent manifest loader.
 *
 * Loads agents/*.md files, parses YAML frontmatter into AgentManifest,
 * validates the manifest, and returns the prompt body.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  parseFrontmatter,
  parseArrayValue,
  parseRecordValue,
} from "./frontmatter.ts";
import {
  type AgentManifest,
  type AgentTool,
  type ApprovalManifest,
  type FlowDefinition,
  type WorkflowGate,
} from "./types.ts";

// ============================================================================
// Agent Tool Validation
// ============================================================================

/** All valid tool names an agent can declare */
const VALID_TOOLS: Set<string> = new Set([
  "subagent",
  "ask_user_question",
  "read",
  "write",
  "edit",
  "bash",
  "web_search",
  "code_search",
  "fetch_content",
  "get_search_content",
  "mcp",
  "flow_step_update",
]);

/** Tools not allowed on subagents */
const MAIN_AGENT_ONLY_TOOLS = new Set(["subagent", "ask_user_question"]);

// ============================================================================
// Loading
// ============================================================================

export interface LoadedAgent {
  manifest: AgentManifest;
  /** Body of the .md file — the agent's prompt */
  prompt: string;
  /** Whether this is a subagent (lives in subagents/) */
  isSubagent: boolean;
}

/**
 * Load an agent manifest from agents/{id}.md.
 *
 * @param agentsDir - absolute path to the agents/ directory
 * @param agentId - the agent identifier (filename without .md)
 * @param isSubagent - whether this lives in agents/subagents/
 */
export function loadAgent(
  agentsDir: string,
  agentId: string,
  isSubagent = false
): LoadedAgent {
  const filePath = resolveAgentPath(agentsDir, agentId);

  if (!fs.existsSync(filePath)) {
    throw new Error(
      `Agent "${agentId}" not found at ${filePath}. Expected agents/${agentId.endsWith(".md") ? agentId : `${agentId}.md`}`
    );
  }

  const content = fs.readFileSync(filePath, "utf-8");
  const { frontmatter, body } = parseFrontmatter(content);

  return parseManifest(frontmatter, body, agentId, isSubagent);
}

/**
 * Load multiple agents at once (e.g., all agents referenced by a flow).
 * Validates that all referenced subagents exist.
 */
export function loadFlowAgents(
  agentsDir: string,
  flow: FlowDefinition
): Map<string, LoadedAgent> {
  const agents = new Map<string, LoadedAgent>();

  for (const step of flow.steps) {
    if (agents.has(step.agent)) continue;

    const agent = loadAgent(agentsDir, step.agent);
    agents.set(step.agent, agent);

    // Load all referenced subagents
    if (agent.manifest.subagents) {
      for (const [name, relativePath] of Object.entries(agent.manifest.subagents)) {
        if (agents.has(name)) continue;

        const sub = loadAgent(agentsDir, relativePath, true);
        agents.set(name, sub);
      }
    }
  }

  return agents;
}

// ============================================================================
// Validation
// ============================================================================

/**
 * Validate that all steps with requestApproval: true have an approval block
 * in their agent manifest. Throws on the first violation.
 */
export function validateFlowApproval(
  agentsDir: string,
  flow: FlowDefinition
): void {
  const errors: string[] = [];

  for (const step of flow.steps) {
    if (!step.requestApproval) continue;

    const agent = loadAgent(agentsDir, step.agent);
    const manifest = agent.manifest;

    if (!manifest.approval) {
      errors.push(
        `step "${step.id ?? step.agent}" requires user approval (requestApproval: true) ` +
          `but agent "${step.agent}" has no approval block`
      );
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `Flow "${flow.id}" validation failed:\n${errors.map((e) => `  - ${e}`).join("\n")}`
    );
  }
}

/**
 * Build a WorkflowGate from an agent's approval manifest.
 * Returns null if the agent has no approval block.
 */
export function buildGate(
  manifest: AgentManifest,
  stepIndex: number,
  nonce: string
): WorkflowGate | null {
  if (!manifest.approval) return null;

  return {
    header: manifest.approval.header,
    preview: manifest.approval.preview,
    options: manifest.approval.options,
    stepIndex,
    nonce,
  };
}

// ============================================================================
// Internal parsing
// ============================================================================

function resolveAgentPath(agentsDir: string, agentId: string): string {
  return path.join(agentsDir, agentId.endsWith(".md") ? agentId : `${agentId}.md`);
}

function parseManifest(
  frontmatter: Record<string, string>,
  body: string,
  agentId: string,
  isSubagent: boolean
): LoadedAgent {
  // --- Required fields ---
  const id = frontmatter["id"];
  if (!id) {
    throw new Error(`Agent "${agentId}" is missing required field "id" in frontmatter`);
  }

  const versionRaw = frontmatter["version"];
  if (!versionRaw) {
    throw new Error(`Agent "${agentId}" is missing required field "version" in frontmatter`);
  }
  const version = parseInt(versionRaw, 10);
  if (isNaN(version)) {
    throw new Error(`Agent "${agentId}" has invalid version: "${versionRaw}"`);
  }

  // --- Tools ---
  let rawTools = frontmatter["tools"];
  if (!rawTools && !isSubagent) {
    throw new Error(`Agent "${agentId}" is missing required field "tools" in frontmatter`);
  }
  if (!rawTools) {
    rawTools = "[]";
  }

  const tools = parseArrayValue(rawTools, "tools") as AgentTool[];

  // Validate tool names
  for (const tool of tools) {
    if (!VALID_TOOLS.has(tool)) {
      throw new Error(
        `Agent "${agentId}" has unknown tool "${tool}". Valid tools: ${[...VALID_TOOLS].join(", ")}`
      );
    }
  }

  // Subagents cannot use ask_user_question or subagent
  if (isSubagent) {
    for (const tool of tools) {
      if (MAIN_AGENT_ONLY_TOOLS.has(tool)) {
        throw new Error(
          `Subagent "${agentId}" cannot use tool "${tool}". ` +
            `Only main agents can use: ${[...MAIN_AGENT_ONLY_TOOLS].join(", ")}`
        );
      }
    }
  }

  // --- Subagents ---
  let subagents: Record<string, string> | undefined;
  const subagentsRaw = frontmatter["subagents"];
  if (subagentsRaw) {
    subagents = parseRecordValue(subagentsRaw, "subagents");

    // Subagents within subagents is not allowed
    if (isSubagent && Object.keys(subagents).length > 0) {
      throw new Error(
        `Subagent "${agentId}" cannot declare subagents. Only main agents can use subagents.`
      );
    }
  }

  // --- Parallel ---
  let parallel: AgentManifest["parallel"] | undefined;
  const parallelOver = frontmatter["parallel_over"];
  const parallelSubagent = frontmatter["parallel_subagent"];
  const parallelConcurrency = frontmatter["parallel_concurrency"];

  if (parallelOver || parallelSubagent) {
    if (isSubagent) {
      throw new Error(
        `Subagent "${agentId}" cannot declare parallel execution. Only main agents can.`
      );
    }
    if (!parallelOver || !parallelSubagent) {
      throw new Error(
        `Agent "${agentId}": parallel requires both "parallel_over" and "parallel_subagent"`
      );
    }
    parallel = {
      over: parallelOver,
      subagent: parallelSubagent,
      concurrency: parallelConcurrency ? parseInt(parallelConcurrency, 10) : undefined,
    };

    if (!tools.includes("subagent")) {
      throw new Error(
        `Agent "${agentId}" declares parallel execution but "subagent" is not in its tools list`
      );
    }

    if (subagents && !subagents[parallelSubagent]) {
      throw new Error(
        `Agent "${agentId}" declares parallel_subagent "${parallelSubagent}" but it is not present in subagents`
      );
    }
  }

  // --- Outputs ---
  let outputs: string[] | undefined;
  if (frontmatter["outputs"]) {
    outputs = parseArrayValue(frontmatter["outputs"], "outputs");
  }

  // --- Approval ---
  let approval: ApprovalManifest | undefined;
  const approvalRaw = frontmatter["approval"];
  if (approvalRaw) {
    try {
      approval = JSON.parse(approvalRaw) as ApprovalManifest;

      if (!approval.header) {
        throw new Error(`Agent "${agentId}" approval block missing "header"`);
      }
      if (!approval.options || !Array.isArray(approval.options)) {
        throw new Error(`Agent "${agentId}" approval block missing "options" array`);
      }
      if (approval.options.length === 0) {
        throw new Error(`Agent "${agentId}" approval block has empty options array`);
      }

      const hasAdvance = approval.options.some((o) => o.advance);
      if (!hasAdvance) {
        throw new Error(
          `Agent "${agentId}" approval block must have at least one option with advance: true`
        );
      }

      for (const opt of approval.options) {
        if (opt.feedback !== undefined && typeof opt.feedback !== "boolean") {
          throw new Error(
            `Agent "${agentId}" approval option "${opt.label}" has invalid feedback value (must be boolean)`
          );
        }
      }
    } catch (err) {
      if (err instanceof SyntaxError) {
        throw new Error(
          `Agent "${agentId}" has invalid JSON in approval block: ${approvalRaw}`
        );
      }
      throw err;
    }
  }

  if (isSubagent && approval) {
    throw new Error(
      `Subagent "${agentId}" cannot have an approval block. Only main agents gate the flow.`
    );
  }

  // --- Manifest ---
  const manifest: AgentManifest = {
    id,
    version,
    tools,
    subagents,
    parallel,
    outputs,
    approval,
  };

  return { manifest, prompt: body, isSubagent };
}
