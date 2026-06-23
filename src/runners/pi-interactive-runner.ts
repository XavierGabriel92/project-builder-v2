/**
 * Pi Interactive Agent Runner
 *
 * Hands control to pi's full interactive TUI (InteractiveMode).
 * The human gets message queue, tree navigation, model switching,
 * compaction — the full pi experience. Blocks until the session ends.
 *
 * This is the runner to use when you want full human↔agent interactivity
 * during each step (steering, follow-up messages, model changes, etc.).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getModel } from "@earendil-works/pi-ai";
import {
  type CreateAgentSessionRuntimeFactory,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  InteractiveMode,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { AgentRunner, AgentRunInput, AgentRunResult } from "../orchestrator/ports.ts";
import { extractSummary } from "./shared.ts";

export class PiInteractiveRunner implements AgentRunner {
  readonly name = "pi-interactive";

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    const cwd = input.cwd;

    // ── Resolve model ─────────────────────────────────────────
    let model;
    if (input.model) {
      model = resolveModel(input.model);
    }

    // ── Create runtime services ───────────────────────────────
    const services = await createAgentSessionServices({ cwd });
    const sessionManager = SessionManager.create(cwd);

    const createRuntime: CreateAgentSessionRuntimeFactory = async ({
      cwd: runtimeCwd,
      sessionManager: runtimeSessionManager,
      sessionStartEvent,
    }) => {
      const result = await createAgentSessionFromServices({
        services,
        sessionManager: runtimeSessionManager,
        sessionStartEvent,
        model,
        tools: input.tools.length > 0 ? input.tools : undefined,
      });

      return {
        ...result,
        services,
        diagnostics: services.diagnostics,
      };
    };

    const runtime = await createAgentSessionRuntime(createRuntime, {
      cwd,
      agentDir: getAgentDir(),
      sessionManager,
    });

    // ── Build initial messages with system prompt ─────────────
    const initialMessages: string[] = [];
    if (input.systemPrompt) {
      initialMessages.push(`/system\n${input.systemPrompt}`);
    }

    // ── Build the main prompt (with context files if provided) ─
    let mainPrompt = input.prompt;
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
        mainPrompt = contextContents + "\n\n" + mainPrompt;
      }
    }

    // ── Hand control to pi's interactive TUI ──────────────────
    const mode = new InteractiveMode(runtime, {
      migratedProviders: [],
      modelFallbackMessage: undefined,
      initialMessage: mainPrompt,
      initialImages: [],
      initialMessages,
    });

    await mode.run();

    // ── Gather results from the completed session ─────────────
    const messages = runtime.session.agent.state.messages;

    // Detect user abort (Ctrl+C / empty session)
    if (messages.length === 0) {
      return {
        success: false,
        summary: "User aborted the session",
        error: "User aborted",
      };
    }

    return {
      success: true,
      summary: extractSummary(messages),
      messages,
    };
  }
}

// ============================================================================
// Internal helpers
// ============================================================================

/**
 * Resolve a "provider/modelId" string to a pi Model object.
 * Tries pi's built-in getModel() first, then falls back to ModelRegistry.find()
 * for custom providers configured in auth.json.
 */
function resolveModel(modelString: string) {
  const parts = modelString.split("/");
  if (parts.length === 2) {
    const [provider, id] = parts;
    return getModel(provider, id) ?? undefined;
  }
  return undefined;
}
