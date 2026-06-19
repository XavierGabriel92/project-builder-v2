/**
 * Claude Code Agent Runner
 *
 * Invokes an agent via the `claude` CLI. Spawns a child process in print
 * mode (-p), passes the prompt via a temp file, captures stdout, and waits
 * for exit.
 *
 * Maps pi tool names to Claude Code tool names automatically.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentRunner, AgentRunInput, AgentRunResult } from "../orchestrator/ports.ts";

// ============================================================================
// Tool name mapping: pi → Claude Code
// ============================================================================

const TOOL_MAP: Record<string, string> = {
  "read": "Read",
  "write": "Write",
  "edit": "Edit",
  "bash": "Bash",
  "grep": "Grep",
  "find": "Glob",
  "ls": "LS",
  "web_search": "WebSearch",
  "web_fetch": "WebFetch",
};

/** Map pi tool names to Claude Code tool names. Unknown tools pass through. */
function mapTools(tools: string[]): string[] {
  return tools
    .map((t) => TOOL_MAP[t] ?? t)
    .filter(Boolean);
}

export interface ClaudeCodeRunnerOptions {
  /** Path to the claude binary. Default: "claude" (resolved from PATH). */
  claudePath?: string;
  /** Timeout in ms for the entire agent run. Default: no timeout. */
  timeout?: number;
}

export class ClaudeCodeRunner implements AgentRunner {
  readonly name = "claude-code";

  private claudePath: string;
  private timeout: number | undefined;

  constructor(options: ClaudeCodeRunnerOptions = {}) {
    this.claudePath = options.claudePath ?? "claude";
    this.timeout = options.timeout;
  }

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    return new Promise((resolve) => {
      // ── Build args ──────────────────────────────────────────
      const args: string[] = [
        "-p",                  // --print (non-interactive, prints result and exits)
        "--output-format", "text",
        "--verbose",           // Include tool outputs in the result
      ];

      // Allowed tools
      const allowedTools = mapTools(input.tools);
      if (allowedTools.length > 0) {
        args.push("--allowedTools", allowedTools.join(","));
      }

      // Model
      if (input.model) {
        args.push("--model", input.model);
      }

      // ── Write prompt to a temp file ─────────────────────────
      // Claude Code's -p flag accepts @file references. Temp files
      // handle long prompts safely (no shell escaping issues).
      let tmpFile: string | undefined;
      try {
        tmpFile = path.join(
          os.tmpdir(),
          `pb-agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.md`,
        );

        // Prepend context files if provided
        let prompt = input.prompt;
        if (input.contextFiles && input.contextFiles.length > 0) {
          const contextContents = input.contextFiles
            .map((f) => {
              const absPath = path.resolve(input.cwd, f);
              if (!fs.existsSync(absPath)) return null;
              const content = fs.readFileSync(absPath, "utf-8");
              return `\n<context file="${f}">\n${content}\n</context>`;
            })
            .filter(Boolean)
            .join("\n");

          if (contextContents) {
            prompt = contextContents + "\n\n" + prompt;
          }
        }

        // Prepend system prompt if provided
        if (input.systemPrompt) {
          prompt = `<system>\n${input.systemPrompt}\n</system>\n\n${prompt}`;
        }

        fs.writeFileSync(tmpFile, prompt, "utf-8");
        args.push(`@${tmpFile}`);
      } catch (err) {
        // If we can't write a temp file, fall back to stdin approach
        tmpFile = undefined;
      }

      // ── Spawn ───────────────────────────────────────────────
      const child = spawn(this.claudePath, args, {
        cwd: input.cwd,
        stdio: tmpFile ? ["ignore", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
        env: { ...process.env },
      });

      let stdout = "";
      let stderr = "";

      child.stdout?.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        stdout += text;
        process.stdout.write(text); // Stream for observability
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      // If no temp file was written, pipe prompt via stdin
      if (!tmpFile) {
        let fullPrompt = input.prompt;
        if (input.systemPrompt) {
          fullPrompt = `<system>\n${input.systemPrompt}\n</system>\n\n${fullPrompt}`;
        }
        child.stdin?.write(fullPrompt);
        child.stdin?.end();
      }

      // ── Timeout ─────────────────────────────────────────────
      let timedOut = false;
      const timer = this.timeout
        ? setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
          }, this.timeout)
        : null;

      // ── Result ──────────────────────────────────────────────
      child.on("close", (code) => {
        // Cleanup temp file
        if (tmpFile) {
          try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
        }
        if (timer) clearTimeout(timer);

        if (timedOut) {
          resolve({
            success: false,
            summary: `Claude Code timed out after ${this.timeout}ms`,
            expectedOutputs: [],
            error: `Timeout after ${this.timeout}ms`,
          });
          return;
        }

        if (code === 0) {
          const summary = extractOutputSummary(stdout);
          resolve({
            success: true,
            summary,
            expectedOutputs: [],
          });
        } else {
          resolve({
            success: false,
            summary: "Claude Code failed",
            expectedOutputs: [],
            error: stderr || `Exit code ${code}`,
          });
        }
      });

      child.on("error", (err) => {
        // Cleanup temp file on spawn failure
        if (tmpFile) {
          try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
        }
        if (timer) clearTimeout(timer);

        // Detect missing binary
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          resolve({
            success: false,
            summary: "Claude Code CLI not found",
            expectedOutputs: [],
            error: `Claude Code CLI not found at "${this.claudePath}". Install via: npm install -g @anthropic-ai/claude-code`,
          });
          return;
        }

        resolve({
          success: false,
          summary: "Claude Code process error",
          expectedOutputs: [],
          error: err.message,
        });
      });
    });
  }
}

// ============================================================================
// Internal helpers
// ============================================================================

/**
 * Extract a summary from Claude Code's stdout.
 * Uses the last non-empty line as the summary, truncated to 300 chars.
 */
function extractOutputSummary(stdout: string): string {
  const trimmed = stdout.trim();
  if (!trimmed) return "Claude Code completed (no output)";

  const lines = trimmed.split("\n");
  // Walk backwards to find the last substantial line
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.length > 0 && !line.startsWith("```")) {
      return line.length > 300
        ? line.slice(0, 297) + "..."
        : line;
    }
  }

  return `Claude Code completed (${trimmed.length} chars output)`;
}
