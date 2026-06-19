/**
 * Shared utilities for AgentRunner implementations.
 *
 * Extracted to avoid duplication between PiSdkRunner and PiInteractiveRunner.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";

/** Maximum characters for a summary line in the console. */
const MAX_SUMMARY_LEN = 240;

/** Fluff prefixes the agent often emits that we strip from summaries. */
const FLUFF_PATTERNS = [
  /^Let me provide a quick summary[.:]?\s*/i,
  /^Here'?s?( a)? (quick )?summary[.:]?\s*/i,
  /^Summary[.:]?\s*/i,
  /^\*\*Summary\*\*[.:]?\s*/i,
  /^##\s+Summary\s*/i,
  /^##\s+Implementation Complete\s*✅?\s*/i,
  /^All tasks are complete[.!]?\s*/i,
  /^All files are in place[.!]?\s*/i,
];

/**
 * Extract a human-readable summary from the agent's conversation messages.
 *
 * Looks for the last assistant message, extracts text content, strips
 * markdown, removes common fluff, and truncates to a readable length.
 *
 * @param messages - Full conversation messages from the agent session.
 * @returns A clean, single-line summary string.
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

  let combined = textBlocks.map((t) => t.text).join("\n").trim();
  if (combined) {
    // Strip markdown formatting
    combined = stripMarkdown(combined);
    // Strip common fluff prefixes
    for (const pattern of FLUFF_PATTERNS) {
      combined = combined.replace(pattern, "");
    }
    // Collapse whitespace to a clean single line
    combined = combined.replace(/\s+/g, " ").trim();
    // Truncate
    if (combined.length > MAX_SUMMARY_LEN) {
      combined = combined.slice(0, MAX_SUMMARY_LEN - 3) + "...";
    }
    return combined || "Agent completed";
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

/** Strip common markdown formatting from text for plain display. */
function stripMarkdown(text: string): string {
  return text
    // Headings
    .replace(/^#{1,6}\s+/gm, "")
    // Bold / italic
    .replace(/\*{1,3}([^*]+)\*{1,3}/g, "$1")
    .replace(/_{1,3}([^_]+)_{1,3}/g, "$1")
    // Inline code
    .replace(/`([^`]+)`/g, "$1")
    // Links: keep text, drop URL
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    // Blockquotes
    .replace(/^>\s?/gm, "")
    // Horizontal rules
    .replace(/^[-*_]{3,}\s*$/gm, "")
    // List markers
    .replace(/^[\s]*[-*+]\s/gm, "")
    .replace(/^\d+\.\s/gm, "")
    // Emoji (basic)
    .replace(/✅|❌|⚠️|📁|🔒|🚀|💡|📝|🔧|✓|✗/g, "")
    .trim();
}
