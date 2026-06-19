/**
 * Inquirer Gate Presenter
 *
 * CLI-based approval gate using Inquirer.js.
 * Shows preview content inline above gate options (truncated if >80 lines),
 * collects optional feedback, and supports configurable timeout.
 */

import inquirer from "inquirer";
import * as fs from "node:fs";
import * as path from "node:path";
import type { GatePresenter, GateInput, GateAnswer } from "../orchestrator/ports.ts";

// ============================================================================
// Options
// ============================================================================

export interface InquirerGateOptions {
  /**
   * Timeout in milliseconds for gate prompts.
   * If exceeded, the gate auto-answers with the configured timeoutAction.
   * Default: no timeout.
   */
  timeout?: number;

  /**
   * What to do when the timeout fires.
   * - "approve": return the first option with advance: true
   * - "abort": return the first option with abort: true (falls back to first advance)
   * Default: "abort"
   */
  timeoutAction?: "approve" | "abort";
}

// ============================================================================
// Presenter
// ============================================================================

export class InquirerGatePresenter implements GatePresenter {
  readonly name = "inquirer";

  private options: InquirerGateOptions;

  constructor(options: InquirerGateOptions = {}) {
    this.options = options;
  }

  async present(gate: GateInput, cwd: string): Promise<GateAnswer> {
    // ── Show preview file if specified ──────────────────────────
    let previewText = "";
    if (gate.previewPath) {
      const fullPath = path.resolve(cwd, gate.previewPath);
      if (fs.existsSync(fullPath)) {
        previewText = this.readPreview(fullPath);
      } else {
        previewText = `⚠ Preview file not found: ${gate.previewPath}`;
      }
    }

    // ── Present options (with optional timeout) ─────────────────
    const choice = await this.promptWithTimeout(
      () => this.presentOptions(gate, previewText),
      gate,
    );

    // ── Collect feedback if the option requests it ──────────────
    let feedback: string | undefined;
    if (choice.feedback) {
      feedback = await this.collectFeedback(gate, cwd);
    }

    return {
      label: choice.label,
      advance: choice.advance,
      abort: choice.abort,
      feedback,
    };
  }

  // ========================================================================
  // Preview
  // ========================================================================

  /** Read preview file, return a clickable path reference. */
  private readPreview(filePath: string): string {
    const absPath = path.resolve(filePath);
    const stat = fs.statSync(absPath);
    const size = formatSize(stat.size);
    const lines = countLines(absPath);
    return `📄 ${absPath}  (${lines} lines, ${size})`;
  }

  // ========================================================================
  // Options prompt
  // ========================================================================

  private async presentOptions(
    gate: GateInput,
    previewText: string,
  ): Promise<GateInput["options"][number]> {
    // Build the prompt message: clickable path above, gate header below
    const messageParts: string[] = [];
    if (previewText) {
      messageParts.push(previewText);
    }
    messageParts.push(gate.header);
    const message = messageParts.join("\n\n");

    const { choice } = await inquirer.prompt<{
      choice: GateInput["options"][number];
    }>([
      {
        type: "list",
        name: "choice",
        message,
        choices: gate.options.map((opt) => ({
          name: `${opt.label} — ${opt.description}`,
          value: opt,
        })),
      },
    ]);

    return choice;
  }

  // ========================================================================
  // Feedback collection (with escape hatch)
  // ========================================================================

  private async collectFeedback(
    gate: GateInput,
    cwd: string,
  ): Promise<string | undefined> {
    const { text } = await inquirer.prompt<{ text: string }>([
      {
        type: "input",
        name: "text",
        message: "What changes are needed? (enter to skip feedback)",
        default: "",
      },
    ]);

    const trimmed = text.trim();

    // Empty feedback → re-present the gate from the top
    if (!trimmed) {
      console.log("No feedback provided. Returning to gate options...\n");
      return this.present(gate, cwd).then((answer) => answer.feedback);
    }

    return trimmed;
  }

  // ========================================================================
  // Timeout support
  // ========================================================================

  private async promptWithTimeout<T>(
    promptFn: () => Promise<T>,
    gate: GateInput,
  ): Promise<T> {
    const timeoutMs = this.options.timeout;
    if (!timeoutMs) return promptFn();

    let timer: ReturnType<typeof setTimeout> | null = null;

    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new TimeoutError(timeoutMs));
      }, timeoutMs);
    });

    try {
      const result = await Promise.race([promptFn(), timeoutPromise]);
      if (timer) clearTimeout(timer);
      return result;
    } catch (err) {
      if (err instanceof TimeoutError) {
        const answer = this.getTimeoutAnswer(gate);
        // We've already timed out on the options prompt, so return the
        // resolved answer. The caller will see choice.advance/abort.
        // We need to cast this back to T — it's a gate option object.
        if (timer) clearTimeout(timer);
        return answer as unknown as T;
      }
      throw err;
    }
  }

  private getTimeoutAnswer(
    gate: GateInput,
  ): GateInput["options"][number] {
    const action = this.options.timeoutAction ?? "abort";

    if (action === "approve") {
      const approveOpt = gate.options.find((o) => o.advance);
      if (approveOpt) return approveOpt;
      // Fallback to first option
      return gate.options[0];
    }

    // Abort: find first abort option
    const abortOpt = gate.options.find((o) => o.abort);
    if (abortOpt) return abortOpt;

    // No abort option — fall back to first advance option
    const approveOpt = gate.options.find((o) => o.advance);
    if (approveOpt) return approveOpt;

    return gate.options[0];
  }
}

// ============================================================================
// Internal
// ============================================================================

class TimeoutError extends Error {
  constructor(ms: number) {
    super(`Gate timed out after ${ms}ms`);
    this.name = "TimeoutError";
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function countLines(filePath: string): number {
  const content = fs.readFileSync(filePath, "utf-8");
  return content.split("\n").length;
}
