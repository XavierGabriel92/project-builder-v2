/**
 * Runner registry — factory for AgentRunner implementations.
 *
 * Provides a single entry point for constructing runners by name.
 * Built-in runners: pi-sdk, pi-interactive, claude-code.
 *
 * To add a custom runner: register it here, then reference it
 * via --runner <name> on the CLI.
 */

import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { AgentRunner } from "../orchestrator/ports.ts";
import { PiSdkRunner } from "./pi-sdk-runner.ts";
import type { PiSdkRunnerOptions } from "./pi-sdk-runner.ts";
import { PiInteractiveRunner } from "./pi-interactive-runner.ts";
import { ClaudeCodeRunner } from "./claude-code-runner.ts";
import type { ClaudeCodeRunnerOptions } from "./claude-code-runner.ts";

// ============================================================================
// Registry
// ============================================================================

type RunnerFactory = (options?: Record<string, unknown>) => AgentRunner;

const builtinRunners: Record<string, RunnerFactory> = {
  "pi-sdk": (opts) => new PiSdkRunner(opts as unknown as PiSdkRunnerOptions),
  "pi-interactive": () => new PiInteractiveRunner(),
  "claude-code": (opts) => new ClaudeCodeRunner(opts as unknown as ClaudeCodeRunnerOptions),
};

// ============================================================================
// Public API
// ============================================================================

/**
 * List all available built-in runner names.
 */
export function getRunnerNames(): string[] {
  return Object.keys(builtinRunners);
}

/**
 * Check if a runner name is a built-in.
 */
export function isBuiltinRunner(name: string): boolean {
  return name in builtinRunners;
}

/**
 * Create an AgentRunner by name.
 *
 * @param name - Runner name (e.g. "pi-sdk", "pi-interactive", "claude-code")
 * @param authStorage - AuthStorage instance (required by pi-sdk)
 * @param modelRegistry - ModelRegistry instance (required by pi-sdk)
 * @param options - Runner-specific options (timeout, stream, claudePath, etc.)
 */
export function createRunner(
  name: string,
  authStorage: AuthStorage,
  modelRegistry: ModelRegistry,
  options?: Record<string, unknown>,
): AgentRunner {
  const factory = builtinRunners[name];
  if (!factory) {
    throw new Error(
      `Unknown runner "${name}". Available: ${getRunnerNames().join(", ")}`,
    );
  }
  return factory({ authStorage, modelRegistry, ...options });
}
