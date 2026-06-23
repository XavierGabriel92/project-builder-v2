/**
 * Project Rules Discovery
 *
 * Auto-discovers project-level rule files (AGENTS.md, docs/, README.md)
 * and returns their content as injectable context for every agent step.
 *
 * This ensures agents always know the project's conventions, architecture,
 * and golden rules — no per-project customization needed.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** Max bytes to read from a single file (prevents huge files from bloating prompts) */
const MAX_FILE_BYTES = 12_000;

/** Max total bytes across all discovered rules */
const MAX_TOTAL_BYTES = 20_000;

/**
 * Discover and read project rule files from conventional locations.
 *
 * Discovery order:
 * 1. AGENTS.md at project root — read fully (up to MAX_FILE_BYTES)
 * 2. AGENTS.md one level deep (e.g. apps/NAME/AGENTS.md) — for monorepos
 * 3. README.md at project root — note its existence
 * 4. docs/ directory — list contents (file names only, not contents)
 *
 * Returns concatenated markdown suitable for injection into agent prompts,
 * or undefined if no rule files were found.
 */
export function discoverProjectRules(projectRoot: string): string | undefined {
  const sections: string[] = [];
  let totalBytes = 0;

  // 1. AGENTS.md — the standard agent guidance file
  let agentsMdPath = findAgentsMd(projectRoot);
  if (agentsMdPath) {
    try {
      const stat = fs.statSync(agentsMdPath);
      const readSize = Math.min(stat.size, MAX_FILE_BYTES);
      const content = readFileHead(agentsMdPath, readSize);
      const truncated = stat.size > MAX_FILE_BYTES;
      totalBytes += Math.min(stat.size, MAX_FILE_BYTES);

      const locationNote = agentsMdPath !== path.join(projectRoot, "AGENTS.md")
        ? ` (found at ${path.relative(projectRoot, agentsMdPath)})`
        : "";

      sections.push(
        "## Project Rules (AGENTS.md)\n\n" +
        `The project has an AGENTS.md file${locationNote} with agent-specific guidance. ` +
        "Read it fully for complete context.\n\n" +
        "```\n" +
        content +
        (truncated ? "\n\n[...truncated — read the full file for complete context]" : "") +
        "\n```"
      );
    } catch {
      // Silently skip unreadable files
    }
  }

  // 2. README.md — note its existence (don't read contents to avoid bloat)
  const readmeMd = path.join(projectRoot, "README.md");
  if (fs.existsSync(readmeMd)) {
    sections.push(
      "## Project README\n\n" +
      "A README.md exists at the project root with project overview, setup instructions, " +
      "and architecture references. Read it for full context."
    );
  }

  // 3. docs/ directory — list contents
  const docsDir = path.join(projectRoot, "docs");
  if (fs.existsSync(docsDir)) {
    try {
      const docStat = fs.statSync(docsDir);
      if (docStat.isDirectory()) {
        const files = listMdFiles(docsDir);
        if (files.length > 0) {
          sections.push(
            "## Project Documentation (docs/)\n\n" +
            "The following documentation files exist. Read relevant files for domain-specific rules:\n\n" +
            files.map((f) => `- \`docs/${f}\``).join("\n")
          );
        }
      }
    } catch {
      // Silently skip
    }
  }

  if (sections.length === 0) return undefined;

  // Truncate total output
  let result = sections.join("\n\n");
  if (Buffer.byteLength(result, "utf-8") > MAX_TOTAL_BYTES) {
    result = result.slice(0, MAX_TOTAL_BYTES) + "\n\n[...truncated]";
  }

  return result;
}

/**
 * Find AGENTS.md at project root, or one level deep (e.g. apps/NAME/AGENTS.md).
 * Returns the first match found, preferring the project root.
 */
function findAgentsMd(projectRoot: string): string | null {
  // 1. Project root first
  const rootPath = path.join(projectRoot, "AGENTS.md");
  if (fs.existsSync(rootPath)) return rootPath;

  // 2. Search one level deep (monorepo: apps/*/AGENTS.md, packages/*/AGENTS.md, etc.)
  try {
    const entries = fs.readdirSync(projectRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const subPath = path.join(projectRoot, entry.name, "AGENTS.md");
      if (fs.existsSync(subPath)) return subPath;
      // Also check one more level for deeply nested repos (e.g. apps/web/AGENTS.md)
      try {
        const subEntries = fs.readdirSync(path.join(projectRoot, entry.name), { withFileTypes: true });
        for (const subEntry of subEntries) {
          if (!subEntry.isDirectory() || subEntry.name.startsWith(".")) continue;
          const deepPath = path.join(projectRoot, entry.name, subEntry.name, "AGENTS.md");
          if (fs.existsSync(deepPath)) return deepPath;
        }
      } catch {
        // Skip unreadable subdirectories
      }
    }
  } catch {
    // Skip unreadable directories
  }

  return null;
}

/**
 * Read the first `bytes` bytes of a file as UTF-8.
 */
function readFileHead(filePath: string, bytes: number): string {
  const buf = Buffer.alloc(bytes);
  const fd = fs.openSync(filePath, "r");
  try {
    const read = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.toString("utf-8", 0, read);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Recursively list all .md files in a directory, relative to the directory root.
 * Max depth: 3 (docs/ → docs/sub/ → docs/sub/deep/).
 */
function listMdFiles(dir: string, prefix = "", depth = 0): string[] {
  if (depth > 3) return [];

  const results: string[] = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isFile() && entry.name.endsWith(".md")) {
        results.push(relativePath);
      } else if (entry.isDirectory() && !entry.name.startsWith(".")) {
        results.push(
          ...listMdFiles(path.join(dir, entry.name), relativePath, depth + 1)
        );
      }
    }
  } catch {
    // Silently skip
  }
  return results.sort();
}
