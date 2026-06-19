/**
 * YAML frontmatter parser for agent .md files.
 *
 * Parses flat key-value YAML between --- delimiters.
 * In v1, all frontmatter values are flat strings — arrays and nested objects
 * are represented as JSON strings in the value (e.g. '["read", "write"]').
 */

export interface ParsedFrontmatter {
  frontmatter: Record<string, string>;
  /** Everything after the closing --- */
  body: string;
}

/**
 * Parse frontmatter from a markdown string.
 *
 * Format:
 *   ---
 *   key1: value1
 *   key2: value2
 *   ---
 *   Body text here...
 *
 * Returns empty frontmatter if no --- delimiters are found.
 */
export function parseFrontmatter(content: string): ParsedFrontmatter {
  const frontmatter: Record<string, string> = {};
  const normalized = content.replace(/\r\n/g, "\n");

  if (!normalized.startsWith("---")) {
    return { frontmatter, body: normalized };
  }

  const endIndex = normalized.indexOf("\n---", 3);
  if (endIndex === -1) {
    // No closing delimiter — treat entire content as body
    return { frontmatter, body: normalized };
  }

  const frontmatterBlock = normalized.slice(4, endIndex);
  const body = normalized.slice(endIndex + 4).trim();

  for (const line of frontmatterBlock.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue; // skip empty lines

    const colonIndex = trimmed.indexOf(":");
    if (colonIndex === -1) continue; // skip lines without key: value

    const key = trimmed.slice(0, colonIndex).trim();
    let value = trimmed.slice(colonIndex + 1).trim();

    // Strip surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    frontmatter[key] = value;
  }

  return { frontmatter, body };
}

/**
 * Parse a JSON-encoded array value from frontmatter.
 * Returns the parsed array, or throws with a descriptive error.
 */
export function parseArrayValue(raw: string | undefined, key: string): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new Error(`"${key}" must be a JSON array, got: ${typeof parsed}`);
    }
    return parsed;
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new Error(`"${key}" is not valid JSON: ${raw}`);
    }
    throw err;
  }
}

/**
 * Parse a JSON-encoded object value from frontmatter.
 */
export function parseRecordValue(
  raw: string | undefined,
  key: string
): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || Array.isArray(parsed) || parsed === null) {
      throw new Error(`"${key}" must be a JSON object, got: ${typeof parsed}`);
    }
    return parsed as Record<string, string>;
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new Error(`"${key}" is not valid JSON: ${raw}`);
    }
    throw err;
  }
}
