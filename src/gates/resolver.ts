/**
 * Gate Presenter Resolver
 *
 * Selects the appropriate GatePresenter implementation based on:
 * - CLI flags (--yes, --gate)
 * - The active runner (pi-interactive → PiTuiGatePresenter)
 * - Whether a PiUIContext is available
 *
 * The resolver keeps main.ts and factory.ts free of gate
 * implementation imports while allowing runtime decisions
 * about which presenter to use.
 */

import type { GatePresenter } from "../orchestrator/ports.ts";
import type { PiUIContext } from "./pi-tui-gate.ts";
import { PiTuiGatePresenter } from "./pi-tui-gate.ts";
import { InquirerGatePresenter } from "./inquirer-gate.ts";
import { AutoApproveGate } from "./noop-gate.ts";

// ============================================================================
// Options
// ============================================================================

export interface GateResolverOptions {
  /** Name of the active AgentRunner (e.g. "pi-interactive", "pi-sdk"). */
  runnerName: string;

  /** Explicit gate override from CLI (--gate <name>). */
  cliGate?: string;

  /** Whether --yes / -y flag is set (auto-approve all gates). */
  cliYes?: boolean;

  /**
   * Pi TUI context (ExtensionContext.ui).
   * Required for PiTuiGatePresenter. If not provided and the runner
   * is pi-interactive, the resolver falls back to InquirerGatePresenter.
   */
  piContext?: PiUIContext;
}

// ============================================================================
// Resolver
// ============================================================================

/**
 * Resolve the appropriate GatePresenter for the current execution context.
 *
 * Priority:
 *   1. --yes flag  → AutoApproveGate (always, regardless of runner)
 *   2. --gate flag → explicit override (name lookup)
 *   3. pi-interactive + piContext available → PiTuiGatePresenter
 *   4. pi-interactive without piContext → InquirerGatePresenter (fallback)
 *   5. Default → InquirerGatePresenter
 */
export function resolveGatePresenter(
  options: GateResolverOptions,
): GatePresenter {
  // ── 1. --yes always forces auto-approve ───────────────────────
  if (options.cliYes) {
    return new AutoApproveGate();
  }

  // ── 2. Explicit --gate override ──────────────────────────────
  if (options.cliGate) {
    return createByName(options.cliGate, options.piContext);
  }

  // ── 3. pi-interactive runner → try PiTuiGatePresenter ────────
  if (options.runnerName === "pi-interactive") {
    if (options.piContext) {
      return new PiTuiGatePresenter(options.piContext);
    }
    // No pi context available — fall back to Inquirer
    return new InquirerGatePresenter();
  }

  // ── 4. Default ───────────────────────────────────────────────
  return new InquirerGatePresenter();
}

// ============================================================================
// Internal
// ============================================================================

function createByName(
  name: string,
  piContext?: PiUIContext,
): GatePresenter {
  switch (name) {
    case "inquirer":
      return new InquirerGatePresenter();
    case "auto-approve":
      return new AutoApproveGate();
    case "pi-tui": {
      if (!piContext) {
        throw new Error(
          'Gate presenter "pi-tui" requires a PiUIContext but none was provided. ' +
            "The pi-tui gate only works inside a pi extension session.",
        );
      }
      return new PiTuiGatePresenter(piContext);
    }
    default:
      throw new Error(
        `Unknown gate presenter "${name}". Available: inquirer, auto-approve, pi-tui`,
      );
  }
}
