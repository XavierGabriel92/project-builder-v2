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
import { piTextInput } from "../cli/pi-text-input.ts";
import type { GatePresenter, GateInput, GateAnswer, QuestionAnswer } from "../orchestrator/ports.ts";

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
    // ── Phase 1: Answer gate questions (one open-text prompt each) ──
    let questionAnswers: QuestionAnswer[] | undefined;
    if (gate.questions && gate.questions.length > 0) {
      const result = await this.collectQuestionAnswers(gate, cwd);
      if (result === null) {
        // User cancelled during question answering — abort
        const abortOpt = gate.options.find(o => o.abort);
        return {
          label: abortOpt?.label ?? "Exit",
          advance: false,
          abort: true,
        };
      }
      questionAnswers = result;
    }

    // ── Phase 2: Show preview + standard approval dialog ──────
    let previewText = "";
    if (gate.previewPath) {
      const fullPath = path.resolve(cwd, gate.previewPath);
      if (fs.existsSync(fullPath)) {
        previewText = this.readPreview(fullPath);
      } else {
        previewText = `⚠ Preview file not found: ${gate.previewPath}`;
      }
    }

    // Present options
    const choice = await this.promptWithTimeout(
      () => this.presentOptions(gate.header, previewText, gate.options),
      gate,
    );

    // ── Phase 3: Collect feedback if the option requests it ──────
    let feedback: string | undefined;
    if (choice.feedback) {
      feedback = await this.collectFeedback(gate, cwd);
    }

    return {
      label: choice.label,
      advance: choice.advance,
      abort: choice.abort,
      feedback,
      questionAnswers,
    };
  }

  // ========================================================================
  // Preview
  // ========================================================================

  /**
   * Read preview file, return a clickable path reference.
   *
   * Wraps the path in an OSC 8 terminal hyperlink so the file remains
   * clickable even when the path text wraps across lines. Without the
   * hyperlink escape sequences, terminal emulators relying on text-based
   * path detection lose the click target at the line break.
   */
  private readPreview(filePath: string): string {
    const absPath = path.resolve(filePath);
    const stat = fs.statSync(absPath);
    const size = formatSize(stat.size);
    const lines = countLines(absPath);
    // Use OSC 8 hyperlink so the path remains clickable even when it wraps
    const label = `📄 ${absPath}  (${lines} lines, ${size})`;
    // Percent-encode the path for the file:// URI so terminals handle
    // paths with spaces, Unicode, or special characters correctly.
    const uri = "file://" + encodeURI(absPath);
    return osc8Hyperlink(uri, label);
  }

  // ========================================================================
  // Agent Questions
  // ========================================================================

  /**
   * Present each gate question one at a time with an open-text prompt.
   * Returns the answers, or null if the user cancelled (Esc/Ctrl+C).
   */
  private async collectQuestionAnswers(
    gate: GateInput,
    cwd: string,
  ): Promise<QuestionAnswer[] | null> {
    if (!gate.questions || gate.questions.length === 0) return [];

    const answers: QuestionAnswer[] = [];
    const divider = "─".repeat(50);

    for (let i = 0; i < gate.questions.length; i++) {
      const q = gate.questions[i];

      // Print the question with context
      console.log(`\n${divider}`);
      console.log(`❓ Question ${i + 1}/${gate.questions.length}: ${q.question}`);
      if (q.context) {
        console.log(`   🤔 ${q.context}`);
      }
      console.log(`${divider}\n`);

      // Collect open-text answer
      const answer = await piTextInput({
        prompt: "Your answer (Enter to submit, Esc to skip):",
        cwd,
      });

      // null → user cancelled (Ctrl+C / Ctrl+D on empty)
      if (answer === null) {
        console.log("\nQuestion answering cancelled. Aborting gate...\n");
        return null;
      }

      answers.push({
        question: q.question,
        answer: answer.trim() || "(no answer provided)",
        id: (q as Record<string, unknown>).id as string | undefined,
      });
    }

    // Blank line after all questions answered
    console.log("");
    return answers;
  }

  // ========================================================================
  // Options prompt
  // ========================================================================

  private async presentOptions(
    headerText: string,
    previewText: string,
    options: GateInput["options"],
  ): Promise<GateInput["options"][number]> {
    // Build the prompt message: clickable path above, gate header below
    const messageParts: string[] = [];
    if (previewText) {
      messageParts.push(previewText);
    }
    messageParts.push(headerText);
    const message = messageParts.join("\n\n");

    const { choice } = await inquirer.prompt<{
      choice: GateInput["options"][number];
    }>([
      {
        type: "list",
        name: "choice",
        message,
        choices: options.map((opt) => ({
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
    // PI-style multiline text input with @ file references, Shift+Enter, etc.
    // Uses the same Editor/TUI/autocomplete as pi interactive mode.
    const text = await piTextInput({
      prompt: "What changes are needed? (Enter to submit, Esc to skip)",
      cwd,
    });

    // null → user cancelled (Ctrl+C / Ctrl+D on empty)
    if (text === null) {
      console.log("Feedback skipped. Returning to gate options...\n");
      return this.present(gate, cwd).then((answer) => answer.feedback);
    }

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

// ============================================================================
// OSC 8 Terminal Hyperlinks
//
// Terminal emulators (iTerm2, Kitty, WezTerm, Windows Terminal, etc.) support
// the OSC 8 escape sequence for clickable hyperlinks. Unlike text-based path
// detection, OSC 8 links survive line wrapping because the terminal tracks
// the link by escape sequence boundaries, not by scanning text for patterns.
//
// Format: ESC ] 8 ; ; URI ST  LABEL ESC ] 8 ; ; ST
//   ESC ] = \x1b]   (OSC - Operating System Command)
//   ST    = \x1b\\   (String Terminator)
// ============================================================================

const OSC = "\x1b]";
const ST = "\x1b\\";

/**
 * Wrap label text in an OSC 8 hyperlink to the given URI.
 * The label is displayed to the user; the URI is opened on click.
 */
function osc8Hyperlink(uri: string, label: string): string {
  return `${OSC}8;;${uri}${ST}${label}${OSC}8;;${ST}`;
}
