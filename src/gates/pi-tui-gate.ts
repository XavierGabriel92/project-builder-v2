/**
 * Pi TUI Gate Presenter
 *
 * Renders approval gates inside pi's interactive TUI using native
 * UI components (select menus, input prompts, notifications).
 *
 * Only works when running inside a pi extension session where
 * the ExtensionContext is available. Falls back to InquirerGatePresenter
 * when no UI context is provided.
 *
 * The PiUIContext interface mirrors pi's ExtensionContext.ui API
 * without requiring the full ExtensionContext import (which is not
 * exported as a public type from @earendil-works/pi-coding-agent).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { GatePresenter, GateInput, GateAnswer } from "../orchestrator/ports.ts";

// ============================================================================
// PiUIContext — mirrors pi's ExtensionContext.ui API
// ============================================================================

/**
 * Minimal interface matching pi's UI context (ExtensionContext.ui).
 *
 * When running inside a pi extension, the extension runtime provides
 * an object conforming to this interface. Only the methods used by
 * PiTuiGatePresenter are declared here.
 */
export interface PiUIContext {
  /** Show a select menu. Returns the chosen value or undefined on cancel. */
  select<T>(
    message: string,
    choices: Array<{
      label: string;
      description?: string;
      value: T;
    }>,
  ): Promise<T | undefined>;

  /** Show a text input prompt. Returns user input or undefined on cancel. */
  input(message: string): Promise<string | undefined>;

  /** Show a notification message. */
  notify(message: string, level?: "info" | "warn" | "error"): void;
}

// ============================================================================
// PiTuiGatePresenter
// ============================================================================

export class PiTuiGatePresenter implements GatePresenter {
  readonly name = "pi-tui";

  private uiContext: PiUIContext;

  /**
   * @param uiContext - The pi extension UI context (ExtensionContext.ui).
   *                    If not available, gates will use Inquirer.js as fallback.
   */
  constructor(uiContext: PiUIContext) {
    this.uiContext = uiContext;
  }

  async present(gate: GateInput, cwd: string): Promise<GateAnswer> {
    // ── Show preview as a notification ──────────────────────────
    if (gate.previewPath) {
      const fullPath = path.resolve(cwd, gate.previewPath);
      if (fs.existsSync(fullPath)) {
        const content = fs.readFileSync(fullPath, "utf-8");
        const truncated =
          content.length > 500
            ? content.slice(0, 497) + "..."
            : content;
        this.uiContext.notify(
          `Preview: ${path.basename(gate.previewPath)}\n${truncated}`,
          "info",
        );
      } else {
        this.uiContext.notify(
          `Preview file not found: ${gate.previewPath}`,
          "warn",
        );
      }
    }

    // ── Present gate options ────────────────────────────────────
    const chosen = await this.uiContext.select<
      GateInput["options"][number]
    >(
      gate.header,
      gate.options.map((opt) => ({
        label: opt.label,
        description: opt.description,
        value: opt,
      })),
    );

    // ── Handle Escape / cancel ──────────────────────────────────
    if (!chosen) {
      // User cancelled (Escape) → return abort answer
      const abortOpt = gate.options.find((o) => o.abort);
      if (abortOpt) {
        return {
          label: abortOpt.label,
          advance: false,
          abort: true,
        };
      }
      // Fallback: treat as selecting first advance option
      const approveOpt = gate.options.find((o) => o.advance);
      if (approveOpt) {
        return {
          label: approveOpt.label,
          advance: true,
        };
      }
      // Absolute last resort
      return {
        label: gate.options[0].label,
        advance: gate.options[0].advance,
        abort: gate.options[0].abort,
      };
    }

    // ── Collect feedback if the option requests it ──────────────
    let feedback: string | undefined;
    if (chosen.feedback) {
      const text = await this.uiContext.input(
        "What changes are needed?",
      );
      feedback = text?.trim() || undefined;

      // If feedback was requested but user provided none, re-present
      if (!feedback) {
        this.uiContext.notify(
          "No feedback provided. Re-presenting gate options...",
          "warn",
        );
        return this.present(gate, cwd);
      }
    }

    return {
      label: chosen.label,
      advance: chosen.advance,
      abort: chosen.abort,
      feedback,
    };
  }
}
