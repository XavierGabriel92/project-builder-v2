/**
 * Shared utilities for AgentRunner implementations.
 *
 * Extracted to avoid duplication between PiSdkRunner and PiInteractiveRunner.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";

/**
 * Extract a human-readable summary from the agent's conversation messages.
 *
 * Looks for the last assistant message, extracts text content, and falls back
 * to listing tool names if no text is present.
 *
 * @param messages - Full conversation messages from the agent session.
 * @returns A summary string, truncated to 300 characters.
 */
export function extractSummary(messages: AgentMessage[]): string {
  const lastAssistant = [...messages].reverse().find(
    (m) => m.role === "assistant",
  );
  if (!lastAssistant) return "Agent completed (no response)";

  const content = lastAssistant.content;
  if (!Array.isArray(content)) return "Agent completed";

  // Prefer text content
  const textBlocks = content.filter(
    (c): c is { type: "text"; text: string } =>
      typeof c === "object" && c !== null && "type" in c && c.type === "text",
  );

  const combined = textBlocks.map((t) => t.text).join("\n").trim();
  if (combined) {
    return combined.length > 300
      ? combined.slice(0, 297) + "..."
      : combined;
  }

  // Fall back to listing tool names
  const toolBlocks = content.filter(
    (c): c is { type: "tool_use"; name: string } =>
      typeof c === "object" &&
      c !== null &&
      "type" in c &&
      c.type === "tool_use",
  );
  if (toolBlocks.length > 0) {
    return `Used tools: ${toolBlocks.map((t) => t.name).join(", ")}`;
  }

  return "Agent completed";
}
