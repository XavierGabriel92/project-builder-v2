/**
 * Runner environment configuration.
 *
 * Reads agent backend configuration from environment variables.
 * Each runner reads from this in its constructor to stay configurable
 * without hardcoded paths or credentials.
 */

export interface RunnerEnv {
  // ── Pi SDK ──────────────────────────────────────────────────
  /** Path to the pi agent directory (config files, auth, models). */
  PI_CODING_AGENT_DIR?: string;
  /** Anthropic API key (used by pi SDK for API authentication). */
  ANTHROPIC_API_KEY?: string;
  /** OpenAI API key (used by pi SDK for API authentication). */
  OPENAI_API_KEY?: string;

  // ── Claude Code ─────────────────────────────────────────────
  /** Path to the `claude` binary. Default: "claude" (resolved from PATH). */
  CLAUDE_CODE_PATH?: string;
  /** Timeout in milliseconds for Claude Code invocations. */
  CLAUDE_CODE_TIMEOUT_MS?: string;

  // ── General ─────────────────────────────────────────────────
  /** Default timeout in milliseconds for any agent runner. */
  AGENT_TIMEOUT_MS?: string;
}

/**
 * Load runner configuration from environment variables.
 *
 * Call once at startup. The returned object is a plain data bag —
 * runners destructure what they need.
 */
export function loadRunnerEnv(): RunnerEnv {
  return {
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    CLAUDE_CODE_PATH: process.env.CLAUDE_CODE_PATH,
    CLAUDE_CODE_TIMEOUT_MS: process.env.CLAUDE_CODE_TIMEOUT_MS,
    AGENT_TIMEOUT_MS: process.env.AGENT_TIMEOUT_MS,
  };
}
