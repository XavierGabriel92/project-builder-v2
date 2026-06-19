/**
 * Filesystem Output Verifier
 *
 * Checks that expected output files exist on disk.
 * Uses path.isAbsolute() + path.resolve() for cross-platform path resolution.
 * Handles permission errors (EACCES) gracefully.
 * Optional glob pattern expansion via expandGlobs constructor option.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { OutputVerifier } from "../orchestrator/ports.ts";

export interface FilesystemVerifierOptions {
  /**
   * Expand glob patterns (e.g. "*.md", "**\/*.json") to matching files.
   * Patterns with no matches are reported as missing with "(no files matched)".
   * Default: false.
   */
  expandGlobs?: boolean;
}

export class FilesystemVerifier implements OutputVerifier {
  private expandGlobs: boolean;

  constructor(options: FilesystemVerifierOptions = {}) {
    this.expandGlobs = options.expandGlobs ?? false;
  }

  verify(expectedOutputs: string[], cwd: string) {
    const missing: string[] = [];
    const existing: string[] = [];

    // Expand globs if enabled
    const outputs = this.expandGlobs
      ? expandGlobPatterns(expectedOutputs, cwd, missing)
      : expectedOutputs;

    for (const output of outputs) {
      const resolved = path.isAbsolute(output)
        ? output
        : path.resolve(cwd, output);

      if (fs.existsSync(resolved)) {
        // Confirm readability — existsSync can return true for
        // files that exist but are inaccessible.
        try {
          fs.accessSync(resolved, fs.constants.R_OK);
          existing.push(output);
        } catch (err: unknown) {
          const code = (err as NodeJS.ErrnoException)?.code;
          if (code === "EACCES" || code === "EPERM") {
            missing.push(`${output} (permission denied)`);
          } else {
            missing.push(
              `${output} (${(err as NodeJS.ErrnoException)?.message ?? "unreadable"})`,
            );
          }
        }
      } else {
        missing.push(output);
      }
    }

    return {
      allExist: missing.length === 0,
      missing,
      existing,
    };
  }
}

// ============================================================================
// Glob expansion (simple, no external dependencies)
// ============================================================================

function hasGlobChars(s: string): boolean {
  return /[*?[{]/.test(s);
}

/**
 * Expand glob patterns within expectedOutputs.
 * Patterns that match files are replaced with the matched paths.
 * Patterns that match nothing are added to `missing` in-place.
 */
function expandGlobPatterns(
  patterns: string[],
  cwd: string,
  missing: string[],
): string[] {
  const result: string[] = [];

  for (const p of patterns) {
    if (!hasGlobChars(p)) {
      result.push(p);
      continue;
    }

    const baseDir = path.isAbsolute(p) ? path.dirname(p) : cwd;
    const globPart = path.isAbsolute(p) ? path.basename(p) : p;
    const matches = expandSingleGlob(baseDir, globPart);

    if (matches.length === 0) {
      missing.push(`${p} (no files matched)`);
    } else {
      for (const m of matches) {
        result.push(path.isAbsolute(p) ? m : path.relative(cwd, m));
      }
    }
  }

  return result;
}

function expandSingleGlob(baseDir: string, glob: string): string[] {
  const results: string[] = [];
  const tokens = tokenizeGlob(glob);
  walkGlob(baseDir, "", tokens, 0, results);
  return results;
}

// Simplified tokenizer: splits on '/', preserves glob tokens.
function tokenizeGlob(glob: string): string[] {
  const tokens: string[] = [];
  let current = "";
  for (let i = 0; i < glob.length; i++) {
    if (glob[i] === "/") {
      if (current) tokens.push(current);
      current = "";
    } else {
      current += glob[i];
    }
  }
  if (current) tokens.push(current);
  return tokens;
}

function walkGlob(
  dir: string,
  relative: string,
  tokens: string[],
  idx: number,
  results: string[],
): void {
  if (idx >= tokens.length) {
    // All tokens consumed — check if the path is a file
    const fullPath = path.join(dir, relative);
    try {
      if (fs.statSync(fullPath).isFile()) {
        results.push(fullPath);
      }
    } catch {
      // stat failed — skip
    }
    return;
  }

  const token = tokens[idx];

  if (token === "**") {
    // ** matches zero or more directories
    // 1. Match zero directories: skip this token
    walkGlob(dir, relative, tokens, idx + 1, results);
    // 2. Match one or more: descend into each subdirectory
    const currentDir = relative ? path.join(dir, relative) : dir;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const childRel = relative
        ? path.join(relative, entry.name)
        : entry.name;
      // Recurse: ** can keep matching more directories
      walkGlob(dir, childRel, tokens, idx, results);
    }
  } else if (hasGlobChars(token)) {
    // Token contains * or ? — match in current directory
    const regex = globTokenToRegex(token);
    const currentDir = relative ? path.join(dir, relative) : dir;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!regex.test(entry.name)) continue;
      const childRel = relative
        ? path.join(relative, entry.name)
        : entry.name;
      if (idx === tokens.length - 1) {
        // Last token — must be a file
        if (entry.isFile()) {
          results.push(path.join(dir, childRel));
        }
      } else {
        // Not last token — must be a directory to descend
        if (entry.isDirectory()) {
          walkGlob(dir, childRel, tokens, idx + 1, results);
        }
      }
    }
  } else {
    // Literal directory name — descend
    const childRel = relative ? path.join(relative, token) : token;
    const fullPath = path.join(dir, childRel);
    try {
      if (!fs.statSync(fullPath).isDirectory()) return;
    } catch {
      return;
    }
    walkGlob(dir, childRel, tokens, idx + 1, results);
  }
}

function globTokenToRegex(token: string): RegExp {
  let pattern = "^";
  for (let i = 0; i < token.length; i++) {
    const ch = token[i];
    switch (ch) {
      case "*":
        pattern += ".*";
        break;
      case "?":
        pattern += ".";
        break;
      case ".":
      case "+":
      case "^":
      case "$":
      case "(":
      case ")":
      case "{":
      case "}":
      case "[":
      case "]":
      case "|":
      case "\\":
        pattern += "\\" + ch;
        break;
      default:
        pattern += ch;
    }
  }
  pattern += "$";
  return new RegExp(pattern);
}
