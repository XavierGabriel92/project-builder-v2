/**
 * Interactive CLI Prompts
 *
 * Flow selection menu and feature name/context prompts using Inquirer.js.
 * Shown when no --flow flag is provided and there's no config default.
 */

import inquirer from "inquirer";
import type { DiscoveredFlow } from "../flows/discovery.ts";

// ============================================================================
// Flow Selection
// ============================================================================

/**
 * Present an interactive menu for selecting a flow.
 * Automatically skips if only one flow is available.
 *
 * @param flows - Discovered flows to choose from.
 * @returns The selected flow.
 * @throws If the user cancels (Ctrl+C).
 */
export async function selectFlow(
  flows: DiscoveredFlow[],
): Promise<DiscoveredFlow> {
  if (flows.length === 0) {
    throw new Error("No flows available");
  }

  if (flows.length === 1) return flows[0];

  const { flowId } = await inquirer.prompt<{ flowId: string }>([
    {
      type: "list",
      name: "flowId",
      message: "Select a workflow:",
      choices: flows.map(f => ({
        name: `${f.flow.id}${f.source === "project" ? " (project)" : ""} — ${f.flow.description}`,
        value: f.flow.id,
      })),
      pageSize: 15,
    },
  ]);

  const selected = flows.find(f => f.flow.id === flowId);
  if (!selected) {
    throw new Error(`Selected flow "${flowId}" not found`);
  }

  return selected;
}

// ============================================================================
// Feature Name + Context
// ============================================================================

/**
 * Prompt the user for a feature name and optional context description.
 *
 * @returns The feature name and optional context.
 * @throws If the user cancels (Ctrl+C).
 */
export async function promptFeatureName(): Promise<{
  name: string;
  context?: string;
}> {
  const { name } = await inquirer.prompt<{ name: string }>([
    {
      type: "input",
      name: "name",
      message: "Feature name (used for workflow directory):",
      validate: (val: string) =>
        val.trim().length > 0 ? true : "Feature name is required",
    },
  ]);

  const { context } = await inquirer.prompt<{ context: string }>([
    {
      type: "input",
      name: "context",
      message: "What do you want to build? (optional description):",
    },
  ]);

  return {
    name: name.trim(),
    context: context.trim() || undefined,
  };
}
