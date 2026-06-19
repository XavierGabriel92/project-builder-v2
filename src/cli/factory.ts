/**
 * Dependency Injection Factory
 *
 * Constructs AgentRunner and GatePresenter instances by name.
 * Keeps main.ts free of concrete runner/gate imports.
 *
 * The runner registry handles runner construction.
 * Gates are simple enough to create directly.
 */

import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { AgentRunner, GatePresenter } from "../orchestrator/ports.ts";
import { createRunner } from "../runners/registry.ts";
import { InquirerGatePresenter } from "../gates/inquirer-gate.ts";
import { AutoApproveGate } from "../gates/noop-gate.ts";

// ============================================================================
// AgentRunner
// ============================================================================

/**
 * Create an AgentRunner by name.
 *
 * @param name - Runner name (e.g. "pi-sdk", "pi-interactive", "claude-code")
 * @param authStorage - AuthStorage instance (for pi-sdk)
 * @param modelRegistry - ModelRegistry instance (for pi-sdk)
 * @param options - Runner-specific options (timeout, stream, claudePath, etc.)
 */
export function createAgentRunner(
  name: string,
  authStorage: AuthStorage,
  modelRegistry: ModelRegistry,
): AgentRunner {
  return createRunner(name, authStorage, modelRegistry);
}

// ============================================================================
// GatePresenter
// ============================================================================

/**
 * Create a GatePresenter by name.
 *
 * @param name - Gate name (e.g. "inquirer", "auto-approve")
 */
export function createGatePresenter(name: string): GatePresenter {
  switch (name) {
    case "inquirer":
      return new InquirerGatePresenter();
    case "auto-approve":
      return new AutoApproveGate();
    default:
      throw new Error(
        `Unknown gate presenter "${name}". Available: inquirer, auto-approve`,
      );
  }
}
