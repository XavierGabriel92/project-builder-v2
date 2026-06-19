/**
 * Configuration File Support
 *
 * Reads `.pi/project-builder.json` from the project root for
 * per-project defaults. CLI flags override config values.
 */

import * as fs from "node:fs";
import * as path from "node:path";

// ============================================================================
// Types
// ============================================================================

export interface ProjectBuilderConfig {
  /** Default agent backend (e.g. "pi-interactive"). */
  runner?: string;
  /** Default gate presenter (e.g. "inquirer"). */
  gate?: string;
  /** Default flow to run when none specified. */
  defaultFlow?: string;
  /** Custom agents directory (relative to project root or absolute). */
  agentsDir?: string;
  /** Default model for all steps. */
  model?: string;
}

// ============================================================================
// Config file path
// ============================================================================

const CONFIG_FILE = ".pi/project-builder.json";

// ============================================================================
// Load
// ============================================================================

/**
 * Load project configuration from `.pi/project-builder.json`.
 *
 * @param projectRoot - Root directory of the user's project.
 * @returns Parsed config, or empty object if file is missing/invalid.
 */
export function loadConfig(projectRoot: string): ProjectBuilderConfig {
  const configPath = path.join(projectRoot, CONFIG_FILE);

  if (!fs.existsSync(configPath)) return {};

  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw);
    return {
      runner: parsed.runner,
      gate: parsed.gate,
      defaultFlow: parsed.defaultFlow,
      agentsDir: parsed.agentsDir,
      model: parsed.model,
    };
  } catch (err) {
    console.warn(
      `Warning: could not parse ${CONFIG_FILE}: ${(err as Error).message}`,
    );
    return {};
  }
}

// ============================================================================
// Merge
// ============================================================================

export interface MergedCliConfig {
  runner: string;
  gate: string;
  flowId: string;
  model?: string;
  agentsDir: string;
}

/**
 * Merge CLI arguments with project config.
 * CLI arguments take precedence over config values.
 *
 * @param cli - Parsed CLI arguments
 * @param config - Project config from loadConfig()
 * @param defaultAgentsDir - Default agents/ directory (from main.ts __dirname)
 */
export function mergeConfig(
  cli: {
    runner: string;
    gate: string;
    flowId?: string;
    model?: string;
    agentsDir?: string;
  },
  config: ProjectBuilderConfig,
  defaultAgentsDir: string,
): MergedCliConfig {
  return {
    runner:
      cli.runner !== "pi-sdk"
        ? cli.runner
        : (config.runner ?? "pi-sdk"),
    gate:
      cli.gate !== "inquirer" ? cli.gate : (config.gate ?? "inquirer"),
    flowId: cli.flowId ?? config.defaultFlow ?? "feature-build",
    model: cli.model ?? config.model,
    agentsDir:
      cli.agentsDir ?? config.agentsDir ?? defaultAgentsDir,
  };
}
