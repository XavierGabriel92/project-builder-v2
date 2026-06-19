/**
 * Pi SDK Agent Runner
 *
 * Invokes an agent via @earendil-works/pi-coding-agent's createAgentSession().
 * Streams output to stdout for observability. Programmatic — no TUI.
 *
 * Swap this file for pi-interactive-runner.ts, claude-code-runner.ts, etc.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getModel } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  AuthStorage,
  ModelRegistry,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import type { AgentRunner, AgentRunInput, AgentRunResult } from "../orchestrator/ports.ts";
import { extractSummary } from "./shared.ts";

/** Valid thinking levels for the Pi agent session. */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface PiSdkRunnerOptions {
  authStorage: ReturnType<typeof AuthStorage.create>;
  modelRegistry: ReturnType<typeof ModelRegistry.create>;
  /** Default model when no per-step override is specified (provider/id string, e.g. "anthropic/claude-sonnet-4-5"). */
  defaultModel?: string;
  /** Default thinking level for all agent sessions (off, minimal, low, medium, high, xhigh). */
  thinkingLevel?: ThinkingLevel;
  /** Whether to stream agent output to stdout. */
  stream?: boolean;
  /** Timeout in ms for the entire agent run. Default: no timeout. */
  timeout?: number;
}

export class PiSdkRunner implements AgentRunner {
  readonly name = "pi-sdk";

  private authStorage: ReturnType<typeof AuthStorage.create>;
  private modelRegistry: ReturnType<typeof ModelRegistry.create>;
  private defaultModel: string | undefined;
  private thinkingLevel: ThinkingLevel | undefined;
  private stream: boolean;
  private timeout: number | undefined;

  constructor(options: PiSdkRunnerOptions) {
    this.authStorage = options.authStorage;
    this.modelRegistry = options.modelRegistry;
    this.defaultModel = options.defaultModel;
    this.thinkingLevel = options.thinkingLevel;
    this.stream = options.stream ?? false;
    this.timeout = options.timeout;
  }

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    const dl = input.debugLog;
    const sessionStart = Date.now();

    // ── Resolve model ─────────────────────────────────────────
    const modelString = input.model ?? this.defaultModel;
    const model = modelString ? resolveModel(modelString, this.modelRegistry) : undefined;

    if (!model) {
      if (input.model) {
        return {
          success: false,
          summary: "Model not found",
          expectedOutputs: [],
          error: `Cannot resolve model "${input.model}"`,
        };
      }
      // No model specified at all — let createAgentSession pick its default
    }

    dl?.(`RUNNER CREATE SESSION start`);
    const createStart = Date.now();

    // ── Build prompt with context files ───────────────────────
    let finalPrompt = input.prompt;
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
        finalPrompt = contextContents + "\n\n" + finalPrompt;
      }
    }

    // ── Build resource loader with system prompt override ─────
    let resourceLoader: DefaultResourceLoader | undefined;
    if (input.systemPrompt) {
      resourceLoader = new DefaultResourceLoader({
        cwd: input.cwd,
        agentDir: getAgentDir(),
        systemPromptOverride: () => input.systemPrompt,
      });
      await resourceLoader.reload();
    }

    // ── Create session ────────────────────────────────────────
    const { session } = await createAgentSession({
      sessionManager: SessionManager.inMemory(),
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
      model,
      thinkingLevel: this.thinkingLevel,
      cwd: input.cwd,
      tools: input.tools,
      resourceLoader,
    });

    dl?.(`RUNNER CREATE SESSION end duration=${Date.now() - createStart}ms`);

    // ── Model info for display ────────────────────────────
    // Prefer the resolved model's display name + context window.
    // Fall back to the raw model string, then session.model.
    const resolvedModel = model ?? session.model;
    const modelInfo = resolvedModel
      ? `${resolvedModel.name} (${formatContextWindow(resolvedModel.contextWindow)})`
      : modelString
        ? modelString
        : undefined;
    const thinkingLevel = session.thinkingLevel || this.thinkingLevel;
    dl?.(`RUNNER MODEL ${modelInfo ?? "(unknown)"} thinkingLevel=${thinkingLevel ?? "(none)"}`);
    dl?.(`RUNNER PROMPT ${finalPrompt.length} chars`);

    // ── Track tool call timing ────────────────────────────
    let activeTool: { name: string; start: number } | null = null;
    let toolCallCount = 0;

    // ── Stream output + activity for observability ──────────
    session.subscribe((event) => {
      if (event.type === "message_update") {
        const detail = event.assistantMessageEvent;
        if (detail.type === "text_delta" && this.stream) {
          process.stdout.write(detail.delta);
        } else if (detail.type === "toolcall_start" || detail.type === "toolcall_delta") {
          // Tool call being streamed — report the tool name if available
          const toolName = (detail as Record<string, unknown>).toolName as string;
          if (toolName) {
            input.onActivity?.(`using ${toolName}`);
          }
        }
      } else if (event.type === "tool_execution_start") {
        // Top-level tool execution event (pi SDK programmatic mode)
        // Log completion of previous tool (if any)
        if (activeTool) {
          const prevDuration = Date.now() - activeTool.start;
          dl?.(`RUNNER TOOL END ${activeTool.name} duration=${prevDuration}ms`);
        }
        input.onActivity?.(`using ${event.toolName}`);
        const sessionElapsed = ((Date.now() - sessionStart) / 1000).toFixed(1);
        toolCallCount++;
        dl?.(`RUNNER TOOL START ${event.toolName} elapsed=${sessionElapsed}s toolCall=${toolCallCount}`);
        activeTool = { name: event.toolName, start: Date.now() };
      } else if (event.type === "turn_end") {
        // Log completion of the last tool before this turn ended
        if (activeTool) {
          const prevDuration = Date.now() - activeTool.start;
          dl?.(`RUNNER TOOL END ${activeTool.name} duration=${prevDuration}ms`);
          activeTool = null;
        }
        // Extract tool names from the completed turn message
        const msg = event.message;
        if (msg?.content && Array.isArray(msg.content)) {
          const toolCalls = msg.content.filter(
            (c: unknown) => typeof c === "object" && c !== null && (c as Record<string, unknown>).type === "tool_use"
          );
          if (toolCalls.length > 0) {
            const names = toolCalls.map((t: unknown) => (t as Record<string, unknown>).name).filter(Boolean);
            if (names.length > 0) {
              input.onActivity?.(`using ${names.join(", ")}`);
            }
          }
        }
        const turnElapsed = ((Date.now() - sessionStart) / 1000).toFixed(1);
        dl?.(`RUNNER TURN END elapsed=${turnElapsed}s`);
      }
    });

    // ── Timeout support ───────────────────────────────────────
    const controller = new AbortController();
    const timer = this.timeout
      ? setTimeout(() => controller.abort(), this.timeout)
      : null;

    try {
      // Pi SDK sessions don't natively accept AbortSignal on prompt().
      // If the timeout fires, we rely on session disposal for cleanup.
      await session.prompt(finalPrompt);

      const messages = session.agent.state.messages;
      const totalElapsed = ((Date.now() - sessionStart) / 1000).toFixed(1);
      dl?.(`RUNNER DONE totalElapsed=${totalElapsed}s toolCalls=${toolCallCount} success=true`);

      return {
        success: true,
        summary: extractSummary(messages),
        expectedOutputs: [],
        modelInfo,
        thinkingLevel,
        messages,
      };
    } catch (err) {
      const totalElapsed = ((Date.now() - sessionStart) / 1000).toFixed(1);
      if ((err as Error).name === "AbortError" || controller.signal.aborted) {
        dl?.(`RUNNER DONE totalElapsed=${totalElapsed}s toolCalls=${toolCallCount} success=false reason=timeout`);
        return {
          success: false,
          summary: `Agent timed out after ${this.timeout}ms`,
          expectedOutputs: [],
          error: `Timeout after ${this.timeout}ms`,
        };
      }
      dl?.(`RUNNER DONE totalElapsed=${totalElapsed}s toolCalls=${toolCallCount} success=false reason="${(err as Error).message.slice(0, 100)}"`);
      return {
        success: false,
        summary: "Agent execution failed",
        expectedOutputs: [],
        error: (err as Error).message,
      };
    } finally {
      if (timer) clearTimeout(timer);
      try { await session.dispose?.(); } catch { /* cleanup is best-effort */ }
    }
  }
}

// ============================================================================
// Internal helpers
// ============================================================================

/**
 * Resolve a "provider/modelId" string to a pi Model object.
 * Tries pi's built-in getModel() first, then falls back to ModelRegistry.find()
 * for custom providers configured in auth.json (e.g. DeepSeek, Moonshot).
 */
function resolveModel(
  modelString: string,
  modelRegistry: ReturnType<typeof ModelRegistry.create>,
) {
  const parts = modelString.split("/");
  if (parts.length === 2) {
    const [provider, id] = parts;
    // Built-in models (Anthropic, OpenAI, Google, etc.)
    const builtin = getModel(provider, id);
    if (builtin) return builtin;
    // Custom providers from auth.json (DeepSeek, Moonshot, etc.)
    return modelRegistry.find(provider, id) ?? undefined;
  }
  return undefined;
}

/** Format context window size to human-readable (e.g. 1000000 → "1.0M"). */
function formatContextWindow(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1)}M`;
  }
  if (tokens >= 1_000) {
    return `${Math.round(tokens / 1_000)}K`;
  }
  return String(tokens);
}


