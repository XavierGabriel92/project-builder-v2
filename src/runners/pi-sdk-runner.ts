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

export interface PiSdkRunnerOptions {
  authStorage: ReturnType<typeof AuthStorage.create>;
  modelRegistry: ReturnType<typeof ModelRegistry.create>;
  /** Default model when no per-step override is specified (provider/id string, e.g. "anthropic/claude-sonnet-4-5"). */
  defaultModel?: string;
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
  private stream: boolean;
  private timeout: number | undefined;

  constructor(options: PiSdkRunnerOptions) {
    this.authStorage = options.authStorage;
    this.modelRegistry = options.modelRegistry;
    this.defaultModel = options.defaultModel;
    this.stream = options.stream ?? false;
    this.timeout = options.timeout;
  }

  async run(input: AgentRunInput): Promise<AgentRunResult> {
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
      cwd: input.cwd,
      tools: input.tools,
      resourceLoader,
    });

    // ── Stream output for observability ───────────────────────
    if (this.stream) {
      session.subscribe((event) => {
        if (
          event.type === "message_update" &&
          event.assistantMessageEvent.type === "text_delta"
        ) {
          process.stdout.write(event.assistantMessageEvent.delta);
        }
      });
    }

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

      return {
        success: true,
        summary: extractSummary(messages),
        expectedOutputs: [],
        messages,
      };
    } catch (err) {
      if ((err as Error).name === "AbortError" || controller.signal.aborted) {
        return {
          success: false,
          summary: `Agent timed out after ${this.timeout}ms`,
          expectedOutputs: [],
          error: `Timeout after ${this.timeout}ms`,
        };
      }
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


