/**
 * CLI Argument Parser
 *
 * Parses command-line arguments into a typed CliArgs object.
 * Supports flags (--flow, --runner, --gate, --resume, --yes, --help, etc.)
 * and positional arguments (projectRoot, featureName, featureContext).
 */

import * as path from "node:path";

// ============================================================================
// Types
// ============================================================================

export interface CliArgs {
  projectRoot: string;
  featureName: string;
  featureContext?: string;
  flowId?: string; // --flow <id>
  runner: string; // --runner <name>, default: "pi-interactive"
  gate: string; // --gate <name>, default: "inquirer"
  resume: boolean; // --resume
  listFlows: boolean; // --list-flows
  yes: boolean; // --yes / -y (auto-approve gates)
  help: boolean; // --help / -h
  debug: boolean; // --debug (write gate-debug.log)
  agentsDir?: string; // --agents-dir <path>
  model?: string; // --model <provider/id>
  provider?: string; // --provider <name> (e.g. anthropic, openai)
  apiKey?: string; // --api-key <key> (runtime override, not persisted)
}

// ============================================================================
// Usage
// ============================================================================

const USAGE = `
project-builder-v2 — execute multi-step agent pipelines

Usage:
  project-builder-v2 [options] [project-root] [feature-name] [feature-context]

Options:
  --flow <id>       Flow to run (default: feature-build)
                    Use --list-flows to see available flows
  --runner <name>   Agent backend (default: pi-sdk)
                    Built-in: pi-sdk, pi-interactive, claude-code
                    pi-sdk: programmatic, streams output, auto-returns
                    pi-interactive: full pi TUI (you must /exit after each step)
  --gate <name>     Gate presenter (default: inquirer)
                    Built-in: inquirer, auto-approve
  --resume          Resume most recent workflow in the project
  --list-flows      List available flows and exit
  --yes, -y         Auto-approve all gates (CI mode)
  --debug           Write gate-debug.log with step-by-step trace
  --model <id>      Default model for all steps (provider/model)
  --provider <name>  LLM provider (anthropic, openai, google, deepseek, etc.)
  --api-key <key>    API key for the provider (runtime only, not persisted)
  --agents-dir      Path to agents/ directory
  --help, -h        Show this help

Authentication:
  Priority: --api-key > auth.json > environment variables
  Env vars: ANTHROPIC_API_KEY, OPENAI_API_KEY, GOOGLE_API_KEY, DEEPSEEK_API_KEY, etc.

Examples:
  project-builder-v2 ./my-project user-auth "Add OAuth2 login"
  project-builder-v2 --flow bug-fix ./my-project fix-login-timeout
  project-builder-v2 --resume ./my-project
  project-builder-v2 --runner pi-sdk --gate auto-approve --yes ./my-project ci-deploy
`;

// ============================================================================
// Parser
// ============================================================================

export function parseArgs(raw: string[]): CliArgs | { error: string; help: string } {
  const args: CliArgs = {
    projectRoot: process.cwd(),
    featureName: "default-feature",
    runner: "pi-sdk",
    gate: "inquirer",
    resume: false,
    listFlows: false,
    yes: false,
    help: false,
    debug: false,
  };

  const positional: string[] = [];
  let i = 0;

  for (; i < raw.length; i++) {
    const arg = raw[i];
    switch (arg) {
      case "--help":
      case "-h":
        args.help = true;
        break;
      case "--list-flows":
        args.listFlows = true;
        break;
      case "--resume":
        args.resume = true;
        break;
      case "--yes":
      case "-y":
        args.yes = true;
        break;
      case "--debug":
        args.debug = true;
        break;
      case "--flow":
        args.flowId = raw[++i] ?? "";
        break;
      case "--runner":
        args.runner = raw[++i] ?? "";
        break;
      case "--gate":
        args.gate = raw[++i] ?? "";
        break;
      case "--model":
        args.model = raw[++i] ?? "";
        break;
      case "--provider":
        args.provider = raw[++i] ?? "";
        break;
      case "--api-key":
        args.apiKey = raw[++i] ?? "";
        break;
      case "--agents-dir":
        args.agentsDir = raw[++i] ?? "";
        break;
      default:
        if (!arg.startsWith("--")) {
          positional.push(arg);
        }
    }
  }

  // Positional args: projectRoot, featureName, featureContext
  if (positional.length > 0) args.projectRoot = path.resolve(positional[0].trim());
  if (positional.length > 1) args.featureName = positional[1].trim();
  if (positional.length > 2) args.featureContext = positional.slice(2).join(" ").trim();

  // Validate
  if (args.help) return { error: "", help: USAGE };

  if (args.flowId && args.resume) {
    return {
      error: "Cannot specify both --flow and --resume. Use one or the other.",
      help: USAGE,
    };
  }

  return args;
}
