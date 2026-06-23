/**
 * Custom ask_user_question tool for programmatic (pi-sdk) runner mode.
 *
 * The pi SDK's built-in ask_user_question is designed for interactive TUI
 * mode. In programmatic createAgentSession + SessionManager.inMemory() mode
 * it executes as a no-op (returns in ~3ms with no user interaction).
 *
 * This custom replacement uses Node.js readline to present questions via
 * stdout and collect answers from stdin, matching the same parameter schema
 * as the built-in tool so the agent's prompt contract is unchanged.
 */

import * as readline from "node:readline";
import { Object, String, Array, Boolean, Optional } from "typebox";
import type { Static } from "typebox";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";

// ── Schema (matches the built-in ask_user_question parameter shape) ────────

const questionOptionSchema = Object({
  label: String(),
  description: String(),
});

const questionSchema = Object({
  question: String(),
  header: String(),
  options: Array(questionOptionSchema),
  multiSelect: Optional(Boolean()),
});

const askUserQuestionSchema = Object({
  questions: Array(questionSchema),
});

type AskUserQuestionParams = Static<typeof askUserQuestionSchema>;

// ── Execute ────────────────────────────────────────────────────────────────

async function execute(
  _toolCallId: string,
  params: AskUserQuestionParams,
  _signal: AbortSignal | undefined,
  _onUpdate: unknown,
  _ctx: unknown,
): Promise<AgentToolResult<{ answers: Array<{ question: string; header: string; answer: string }> }>> {
  // ── Non-TTY guard (CI / piped stdin) ────────────────────────────────────
  if (!process.stdin.isTTY) {
    return {
      content: [
        {
          type: "text",
          text:
            "Cannot ask questions in non-interactive mode (stdin is not a TTY). " +
            "This tool requires a human at the terminal. If you are running in CI " +
            "or automated mode, skip the grilling phases and note that user answers " +
            "were not available.",
        },
      ],
      details: { answers: [] },
    };
  }

  // ── Present questions and collect answers ───────────────────────────────
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const answers: Array<{ question: string; header: string; answer: string }> = [];

  try {
    for (let qi = 0; qi < params.questions.length; qi++) {
      const q = params.questions[qi];

      // Print the question with clear formatting
      process.stdout.write(`\n${"=".repeat(60)}\n`);
      process.stdout.write(`${q.header}: ${q.question}\n`);
      process.stdout.write(`${"=".repeat(60)}\n\n`);

      for (let i = 0; i < q.options.length; i++) {
        process.stdout.write(`  ${i + 1}. ${q.options[i].label} — ${q.options[i].description}\n`);
      }

      process.stdout.write("\n");

      const answer = await new Promise<string>((resolve, reject) => {
        rl.question("Your answer (number, label, or free text): ", (input) => {
          resolve(input.trim());
        });
        // Handle Ctrl+C during readline — reject so the finally block cleans up
        rl.on("SIGINT", () => {
          reject(new Error("User cancelled (SIGINT)"));
        });
      });

      answers.push({ question: q.question, header: q.header, answer });
    }
  } finally {
    rl.close();
    // Restore a clean newline after readline
    process.stdout.write("\n");
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          answers.map((a) => ({ question: a.question, answer: a.answer })),
          null,
          2,
        ),
      },
    ],
    details: { answers },
  };
}

// ── Tool definition ────────────────────────────────────────────────────────

export const askUserQuestionTool: ToolDefinition<
  typeof askUserQuestionSchema,
  { answers: Array<{ question: string; header: string; answer: string }> }
> = {
  name: "ask_user_question",
  label: "Ask User Question",
  description:
    "Ask the user one or more structured questions and wait for their answers. " +
    "Each question has a header, text, and a list of options. Answers are " +
    "collected interactively via the terminal and returned as structured JSON.",
  parameters: askUserQuestionSchema,
  execute,
};
