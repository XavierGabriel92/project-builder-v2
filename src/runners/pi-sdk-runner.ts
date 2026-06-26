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
import { askUserQuestionTool } from "./ask-user-question-tool.ts";

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

  /**
   * Active agent sessions keyed by opaque session ID.
   * Sessions stay alive across retries of the same step so the agent
   * sees its full conversation history (tool calls, file reads, reasoning).
   */
  private activeSessions = new Map<string, {
    session: Awaited<ReturnType<typeof createAgentSession>>["session"];
    sessionFile?: string;
    modelInfo?: string;
    thinkingLevel?: string;
    unsubscribe: () => void;
    /** Whether this session is still valid (not yet disposed). */
    alive: boolean;
  }>();

  private sessionCounter = 0;

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

    // ── Restore session from file (resume-after-crash path) ───
    if (input.sessionFile && !input.sessionId) {
      dl?.(`RUNNER RESTORE FROM FILE sessionFile=${input.sessionFile}`);
      return this.runFromFile(input, sessionStart);
    }

    // ── Continue existing session (retry path) ────────────────
    if (input.sessionId) {
      const entry = this.activeSessions.get(input.sessionId);
      if (!entry || !entry.alive) {
        // Session expired from this process — try reloading from file
        if (entry?.sessionFile && fs.existsSync(entry.sessionFile)) {
          dl?.(`RUNNER RELOAD FROM FILE sessionFile=${entry.sessionFile}`);
          return this.runFromFile(input, sessionStart, entry.sessionFile);
        }
        return {
          success: false,
          summary: "Session expired",
          error: `Session "${input.sessionId}" expired or was disposed`,
        };
      }

      dl?.(`RUNNER CONTINUE SESSION sessionId=${input.sessionId}`);

      try {
        await entry.session.prompt(input.prompt);
        const messages = entry.session.agent.state.messages;
        const totalElapsed = ((Date.now() - sessionStart) / 1000).toFixed(1);
        dl?.(`RUNNER CONTINUE DONE totalElapsed=${totalElapsed}s success=true`);

        return {
          success: true,
          summary: extractSummary(messages),
          modelInfo: entry.modelInfo,
          thinkingLevel: entry.thinkingLevel,
          messages,
          sessionId: input.sessionId,
          sessionFile: entry.sessionFile,
        };
      } catch (err) {
        const totalElapsed = ((Date.now() - sessionStart) / 1000).toFixed(1);
        dl?.(`RUNNER CONTINUE DONE totalElapsed=${totalElapsed}s success=false reason="${(err as Error).message.slice(0, 100)}"`);
        return {
          success: false,
          summary: "Agent execution failed",
          error: (err as Error).message,
          sessionId: input.sessionId,
        };
      }
    }

    // ── Resolve model ─────────────────────────────────────────
    const modelString = input.model ?? this.defaultModel;
    const model = modelString ? resolveModel(modelString, this.modelRegistry) : undefined;

    if (!model) {
      if (input.model) {
        return {
          success: false,
          summary: "Model not found",
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

    // ── Replace ask_user_question with custom stdin/stdout tool ────
    // The pi SDK's built-in ask_user_question is a no-op in programmatic
    // mode. Replace it with a readline-based implementation that actually
    // presents questions to the user and collects answers from stdin.
    const hasAskUserQuestion = input.tools.includes("ask_user_question");
    const tools = hasAskUserQuestion
      ? input.tools.filter((t) => t !== "ask_user_question")
      : input.tools;
    const excludeTools = hasAskUserQuestion ? ["ask_user_question"] : undefined;
    const customTools = hasAskUserQuestion ? [askUserQuestionTool] : undefined;

    // ── Create session ────────────────────────────────────────
    // Use file-backed SessionManager so sessions survive process restarts.
    // Store in .temp/{featurePath}/.memory/ — co-located with workflow.json
    // so cleanup is automatic when the .temp/ directory is deleted.
    const memoryDir = input.workflowDir
      ? path.join(input.workflowDir, ".memory")
      : path.join(input.cwd, ".temp", ".memory");
    fs.mkdirSync(memoryDir, { recursive: true });
    const sessionManager = SessionManager.create(input.cwd, memoryDir);
    const sessionFile = sessionManager.getSessionFile();
    dl?.(`RUNNER SESSION FILE ${sessionFile ?? "(unknown)"}`);

    const { session } = await createAgentSession({
      sessionManager,
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
      model,
      thinkingLevel: this.thinkingLevel,
      cwd: input.cwd,
      tools,
      excludeTools,
      customTools,
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
    let activeTool: { name: string; start: number; subagentName?: string } | null = null;
    let toolCallCount = 0;

    // ── Timeout support ───────────────────────────────────────
    const controller = new AbortController();
    const timer = this.timeout
      ? setTimeout(() => controller.abort(), this.timeout)
      : null;

    // ── Generate session ID ───────────────────────────────────
    this.sessionCounter++;
    const sessionId = `pi-sdk-${this.sessionCounter}-${Date.now()}`;

    // ── Subscribe to session events (streaming + activity) ─────
    // Captured so disposeSession() can unsubscribe later.
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "message_update") {
        const detail = event.assistantMessageEvent;
        if (detail.type === "text_delta" && this.stream) {
          process.stdout.write(detail.delta);
        } else if (detail.type === "toolcall_start" || detail.type === "toolcall_delta") {
          const toolName = (detail as Record<string, unknown>).toolName as string;
          if (toolName) {
            input.onActivity?.(`using ${toolName}`);
          }
        }
      } else if (event.type === "tool_execution_start") {
        if (activeTool) {
          const prevDuration = Date.now() - activeTool.start;
          dl?.(`RUNNER TOOL END ${activeTool.name} duration=${prevDuration}ms`);
          input.onToolEnd?.(activeTool.name);
          if (activeTool.name === "subagent" && activeTool.subagentName) {
            input.onSubagentEnd?.(activeTool.subagentName);
          }
          activeTool = null;
        }
        input.onActivity?.(`using ${event.toolName}`);
        input.onToolStart?.(event.toolName, event.args as Record<string, unknown> | undefined);

        // Track subagent invocations
        let subagentName: string | undefined;
        if (event.toolName === "subagent" && event.args) {
          const subArgs = event.args as Record<string, unknown>;
          subagentName = typeof subArgs.agent === "string" ? subArgs.agent : undefined;
          if (subagentName) {
            // Extract task for display
            const task = typeof subArgs.task === "string" ? subArgs.task : undefined;
            input.onSubagentStart?.(subagentName, task);
          }
        }

        const sessionElapsed = ((Date.now() - sessionStart) / 1000).toFixed(1);
        toolCallCount++;
        const argDetail = describeToolArgs(event.toolName, event.args);
        dl?.(`RUNNER TOOL START ${event.toolName} ${argDetail}elapsed=${sessionElapsed}s toolCall=${toolCallCount}`);
        activeTool = { name: event.toolName, start: Date.now(), subagentName };

        // Emit structured activity for flow_step_update tool calls
        if (event.toolName === "flow_step_update" && input.onFlowStepUpdate) {
          const args = event.args as Record<string, unknown> | undefined;
          if (args) {
            input.onFlowStepUpdate({
              phase: typeof args.phase === "string" ? args.phase : undefined,
              message: typeof args.message === "string" ? args.message : undefined,
              currentPath: typeof args.current_path === "string" ? args.current_path : undefined,
              currentTool: typeof args.current_tool === "string" ? args.current_tool : undefined,
              status: (args.status === "working" || args.status === "blocked" || args.status === "needs_attention")
                ? args.status as "working" | "blocked" | "needs_attention"
                : undefined,
            });
          }
        }
      } else if (event.type === "tool_execution_update") {
        // Forward partial results from long-running tools (subagent, bash, etc.) as activity.
        // This captures subagent progress: the subagent tool calls onUpdate with status text
        // as the subagent works, giving us visibility into what the subagent is doing.
        if (event.partialResult && typeof event.partialResult === "object") {
          const pr = event.partialResult as Record<string, unknown>;
          // Try to extract text content from partial result
          const content = Array.isArray(pr.content) ? pr.content : undefined;
          if (content && content.length > 0) {
            const firstBlock = content[0] as Record<string, unknown> | undefined;
            if (firstBlock && typeof firstBlock.text === "string" && firstBlock.text.trim()) {
              input.onActivity?.(firstBlock.text.trim());
            }
          }
        }
        // Additionally, forward structured flow_step_update calls from within subagents
        if (event.toolName === "flow_step_update" && input.onFlowStepUpdate && event.args) {
          const args = event.args as Record<string, unknown> | undefined;
          if (args) {
            input.onFlowStepUpdate({
              phase: typeof args.phase === "string" ? args.phase : undefined,
              message: typeof args.message === "string" ? args.message : undefined,
              currentPath: typeof args.current_path === "string" ? args.current_path : undefined,
              currentTool: typeof args.current_tool === "string" ? args.current_tool : undefined,
              status: (args.status === "working" || args.status === "blocked" || args.status === "needs_attention")
                ? args.status as "working" | "blocked" | "needs_attention"
                : undefined,
            });
          }
        }
      } else if (event.type === "tool_execution_end") {
        if (activeTool) {
          const prevDuration = Date.now() - activeTool.start;
          dl?.(`RUNNER TOOL END ${activeTool.name} duration=${prevDuration}ms`);
          input.onToolEnd?.(activeTool.name);
          if (activeTool.name === "subagent" && activeTool.subagentName) {
            input.onSubagentEnd?.(activeTool.subagentName);
          }
          activeTool = null;
        }
      } else if (event.type === "turn_end") {
        if (activeTool) {
          const prevDuration = Date.now() - activeTool.start;
          dl?.(`RUNNER TOOL END ${activeTool.name} duration=${prevDuration}ms`);
          input.onToolEnd?.(activeTool.name);
          if (activeTool.name === "subagent" && activeTool.subagentName) {
            input.onSubagentEnd?.(activeTool.subagentName);
          }
          activeTool = null;
        }
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

    // Register the session BEFORE the first prompt — if prompt fails,
    // the caller must call disposeSession to clean up.
    this.activeSessions.set(sessionId, {
      session,
      sessionFile: sessionFile ?? undefined,
      modelInfo,
      thinkingLevel,
      unsubscribe,
      alive: true,
    });

    dl?.(`RUNNER SESSION REGISTERED sessionId=${sessionId}`);

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
        modelInfo,
        thinkingLevel,
        messages,
        sessionId,
        sessionFile: sessionFile ?? undefined,
      };
    } catch (err) {
      const totalElapsed = ((Date.now() - sessionStart) / 1000).toFixed(1);
      // Session is dead — mark it as such so disposeSession cleans up
      const entry = this.activeSessions.get(sessionId);
      if (entry) entry.alive = false;

      if ((err as Error).name === "AbortError" || controller.signal.aborted) {
        dl?.(`RUNNER DONE totalElapsed=${totalElapsed}s toolCalls=${toolCallCount} success=false reason=timeout`);
        return {
          success: false,
          summary: `Agent timed out after ${this.timeout}ms`,
          error: `Timeout after ${this.timeout}ms`,
          sessionId,
          sessionFile: sessionFile ?? undefined,
        };
      }
      dl?.(`RUNNER DONE totalElapsed=${totalElapsed}s toolCalls=${toolCallCount} success=false reason="${(err as Error).message.slice(0, 100)}"`);
      return {
        success: false,
        summary: "Agent execution failed",
        error: (err as Error).message,
        sessionId,
        sessionFile: sessionFile ?? undefined,
      };
    } finally {
      if (timer) clearTimeout(timer);
      // Do NOT dispose the session here — it stays alive for retries.
      // disposeSession() is called by the orchestrator when the step moves past retries.
    }
  }

  /**
   * Load a session from a persisted JSONL file (crash-resume path).
   * Creates a new agent session from the saved conversation history,
   * then prompts it with the current input.
   */
  private async runFromFile(
    input: AgentRunInput,
    sessionStart: number,
    explicitFile?: string,
  ): Promise<AgentRunResult> {
    const dl = input.debugLog;
    const sessionFile = explicitFile ?? input.sessionFile;
    if (!sessionFile || !fs.existsSync(sessionFile)) {
      return {
        success: false,
        summary: "Session file not found",
        error: `Session file not found: ${sessionFile ?? "(none)"}`,
      };
    }

    dl?.(`RUNNER LOADING FROM DISK sessionFile=${sessionFile}`);

    try {
      const sessionManager = SessionManager.open(sessionFile);

      // Resolve model (same logic as main run path)
      const modelString = input.model ?? this.defaultModel;
      const model = modelString ? resolveModel(modelString, this.modelRegistry) : undefined;

      // Build resource loader
      let resourceLoader: DefaultResourceLoader | undefined;
      if (input.systemPrompt) {
        resourceLoader = new DefaultResourceLoader({
          cwd: input.cwd,
          agentDir: getAgentDir(),
          systemPromptOverride: () => input.systemPrompt,
        });
        await resourceLoader.reload();
      }

      // Handle ask_user_question
      const hasAskUserQuestion = input.tools.includes("ask_user_question");
      const tools = hasAskUserQuestion
        ? input.tools.filter((t) => t !== "ask_user_question")
        : input.tools;
      const excludeTools = hasAskUserQuestion ? ["ask_user_question"] : undefined;
      const customTools = hasAskUserQuestion ? [askUserQuestionTool] : undefined;

      const { session } = await createAgentSession({
        sessionManager,
        authStorage: this.authStorage,
        modelRegistry: this.modelRegistry,
        model,
        thinkingLevel: this.thinkingLevel,
        cwd: input.cwd,
        tools,
        excludeTools,
        customTools,
        resourceLoader,
      });

      const modelInfo = model
        ? `${model.name} (${formatContextWindow(model.contextWindow)})`
        : undefined;
      const thinkingLevel = session.thinkingLevel || this.thinkingLevel;

      dl?.(`RUNNER RESTORE PROMPT sessionFile=${sessionFile}`);
      await session.prompt(input.prompt);

      const messages = session.agent.state.messages;
      const totalElapsed = ((Date.now() - sessionStart) / 1000).toFixed(1);
      dl?.(`RUNNER RESTORE DONE totalElapsed=${totalElapsed}s success=true`);

      // Register in active sessions for potential retries
      this.sessionCounter++;
      const newSessionId = `pi-sdk-${this.sessionCounter}-${Date.now()}`;
      const unsubscribe = session.subscribe(() => {}); // minimal; retry continuation handles the real subscription
      this.activeSessions.set(newSessionId, {
        session,
        sessionFile,
        modelInfo,
        thinkingLevel,
        unsubscribe,
        alive: true,
      });

      return {
        success: true,
        summary: extractSummary(messages),
        modelInfo,
        thinkingLevel,
        messages,
        sessionId: newSessionId,
        sessionFile,
      };
    } catch (err) {
      dl?.(`RUNNER RESTORE FAILED reason="${(err as Error).message.slice(0, 100)}"`);
      return {
        success: false,
        summary: "Failed to restore session from file",
        error: (err as Error).message,
      };
    }
  }

  /**
   * Release a session and its resources. Called by the orchestrator when
   * the step moves past retries (advance, block, or abandon).
   * Idempotent — safe to call multiple times for the same session ID.
   * Does NOT delete the session file — it stays on disk for potential
   * crash-resume until the workflow completes.
   */
  disposeSession(sessionId: string): void {
    const entry = this.activeSessions.get(sessionId);
    if (!entry) return;
    entry.alive = false;
    try { entry.unsubscribe(); } catch { /* best-effort */ }
    try { entry.session.dispose?.(); } catch { /* best-effort */ }
    this.activeSessions.delete(sessionId);
    // Session file intentionally kept for crash-resume.
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

/** Extract a short human-readable argument summary from a tool call. */
function describeToolArgs(toolName: string, args: any): string {
  if (!args || typeof args !== "object") return "";

  try {
    switch (toolName) {
      case "read":
        return `path=${truncateArg(String(args.path ?? "?"))} `;
      case "bash":
        return `cmd=${truncateArg(String(args.command ?? "?"))} `;
      case "write":
        return `path=${truncateArg(String(args.path ?? "?"))} `;
      case "edit":
        return `path=${truncateArg(String(args.path ?? "?"))} edits=${args.edits?.length ?? 0} `;
      case "grep":
        return `pattern=${truncateArg(String(args.pattern ?? "?"))} `;
      case "subagent":
        return `agent=${String(args.agent ?? "?")} `;
      case "web_search":
        if (args.queries) {
          return `queries=${args.queries.length} `;
        }
        return `query=${truncateArg(String(args.query ?? "?"))} `;
      case "flow_step_update":
        return `phase=${String(args.phase ?? "?")} `;
      case "fetch_content":
        if (args.urls) return `urls=${args.urls.length} `;
        return `url=${truncateArg(String(args.url ?? "?"))} `;
      case "get_search_content":
        return `responseId=${String(args.responseId ?? "?").slice(0, 12)} `;
      case "code_search":
        return `query=${truncateArg(String(args.query ?? "?"))} `;
      case "ask_user_question":
        return `questions=${args.questions?.length ?? 0} `;
      case "find":
        return `pattern=${truncateArg(String(args.pattern ?? "?"))} `;
      case "ls":
        return `path=${truncateArg(String(args.path ?? "."))} `;
      case "mcp":
        return `tool=${String(args.tool ?? args.action ?? args.server ?? args.search ?? args.describe ?? "?")} `;
      default:
        return "";
    }
  } catch {
    return "";
  }
}

function truncateArg(s: string, maxLen = 80): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 3) + "...";
}


