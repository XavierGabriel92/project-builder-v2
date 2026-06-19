/**
 * Flow Discovery
 *
 * Discovers available flow definitions: built-in flows + project-specific
 * flows from `.pi/project-builder/flows/*.json`. Project flows with the
 * same id override built-in flows.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { FlowDefinition } from "../engine/types.ts";

// ============================================================================
// Types
// ============================================================================

export interface DiscoveredFlow {
  flow: FlowDefinition;
  /** Where the flow was found: "builtin" or "project". */
  source: "builtin" | "project";
  /** File path for project flows (relative to flows dir). */
  filePath?: string;
}

// ============================================================================
// Discovery
// ============================================================================

/**
 * Discover all available flows for a project.
 *
 * Combines built-in flows with project-specific flows from
 * `.pi/project-builder/flows/*.json`. Project flows with
 * the same `id` as a built-in override the built-in.
 *
 * @param projectRoot - Root directory of the user's project.
 * @returns Discovered flows and any parse errors.
 */
export async function discoverFlows(
  projectRoot: string,
): Promise<{ flows: DiscoveredFlow[]; errors: string[] }> {
  // 1. Built-in flows
  const { allFlows } = await import("./builtin.ts");
  const builtin: DiscoveredFlow[] = allFlows.map(flow => ({
    flow,
    source: "builtin" as const,
  }));

  const discovered: DiscoveredFlow[] = [...builtin];
  const errors: string[] = [];

  // 2. Project flows (.pi/project-builder/flows/*.json)
  const projectFlowsDir = path.join(
    projectRoot,
    ".pi",
    "project-builder",
    "flows",
  );

  if (fs.existsSync(projectFlowsDir)) {
    for (const entry of fs.readdirSync(projectFlowsDir)) {
      if (!entry.endsWith(".json")) continue;

      const filePath = path.join(projectFlowsDir, entry);
      try {
        const raw = fs.readFileSync(filePath, "utf-8");
        const flow = JSON.parse(raw) as FlowDefinition;

        // Basic structural validation
        if (!flow.id || typeof flow.id !== "string") {
          errors.push(`${entry}: missing or invalid "id" field`);
          continue;
        }
        if (!Array.isArray(flow.steps)) {
          errors.push(`${entry}: missing or invalid "steps" array`);
          continue;
        }

        discovered.push({
          flow,
          source: "project",
          filePath: entry,
        });
      } catch (err) {
        errors.push(`${entry}: ${(err as Error).message}`);
      }
    }
  }

  // 3. Deduplicate: project flows override built-in with same id
  const byId = new Map<string, DiscoveredFlow>();
  for (const d of discovered) {
    // Always take the first occurrence. Since we pushed builtins first
    // then project flows, project flows will be ignored unless we
    // explicitly prioritize them.
    if (d.source === "project" || !byId.has(d.flow.id)) {
      byId.set(d.flow.id, d);
    }
  }

  return {
    flows: [...byId.values()].sort((a, b) =>
      a.flow.id.localeCompare(b.flow.id),
    ),
    errors,
  };
}
