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

  async present(gate: GateInput, cwd: string, _retryCount = 0): Promise<GateAnswer> {
    // ── Retry guard: prevent infinite re-presentation loops ───
    const MAX_RETRIES = 3;

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
    const selectStart = Date.now();
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
    const selectElapsed = Date.now() - selectStart;

    // ── Timing guard: if select() resolved suspiciously fast, the ──
    // TUI likely auto-resolved without showing the gate. Re-present.
    if (selectElapsed < 200 && _retryCount < MAX_RETRIES) {
      this.uiContext.notify(
        `Gate resolved too quickly (${selectElapsed}ms) — re-presenting (attempt ${_retryCount + 1}/${MAX_RETRIES})...`,
        "warn",
      );
      return this.present(gate, cwd, _retryCount + 1);
    }

    // ── Handle Escape / cancel ──────────────────────────────────
    if (!chosen) {
      // User cancelled (Escape) → abort if possible
      const abortOpt = gate.options.find((o) => o.abort);
      if (abortOpt) {
        return {
          label: abortOpt.label,
          advance: false,
          abort: true,
        };
      }
      // No abort option and select was cancelled — re-present
      // rather than silently auto-approving or picking a random option.
      if (_retryCount < MAX_RETRIES) {
        this.uiContext.notify(
          `No option selected — re-presenting gate (attempt ${_retryCount + 1}/${MAX_RETRIES})...`,
          "warn",
        );
        return this.present(gate, cwd, _retryCount + 1);
      }
      // Exhausted retries — abort as last resort
      this.uiContext.notify(
        "Gate retries exhausted — aborting workflow.",
        "error",
      );
      return {
        label: gate.options[0]?.label ?? "Exit",
        advance: false,
        abort: true,
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
        if (_retryCount < MAX_RETRIES) {
          this.uiContext.notify(
            `No feedback provided — re-presenting gate (attempt ${_retryCount + 1}/${MAX_RETRIES})...`,
            "warn",
          );
          return this.present(gate, cwd, _retryCount + 1);
        }
        // Exhausted retries — treat as cancel (abort if possible)
        this.uiContext.notify(
          "Feedback retries exhausted — aborting.",
          "error",
        );
        const abortOpt = gate.options.find((o) => o.abort);
        return {
          label: abortOpt?.label ?? gate.options[0]?.label ?? "Exit",
          advance: false,
          abort: true,
        };
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
