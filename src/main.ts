/**
 * Project Builder v2 — CLI Entry Point
 *
 * Wires the orchestrator to concrete implementations based on
 * CLI arguments, project config, and interactive prompts.
 *
 * Flow:
 *   parseArgs → loadConfig → mergeConfig → discoverFlows →
 *   handle --help / --list-flows →
 *   handle --resume OR select flow → get feature name →
 *   validateFlow → create dependencies → runFlow → exit
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

import { runFlow } from "./orchestrator/orchestrator.ts";
import { FilesystemVerifier } from "./verifiers/filesystem.ts";
import { ConsoleProgress, NoopProgress } from "./progress/console.ts";

import { validateFlow } from "./flows/validation.ts";
import { discoverFlows } from "./flows/discovery.ts";

import { parseArgs } from "./cli/args.ts";
import { loadConfig, mergeConfig } from "./cli/config.ts";
import { createAgentRunner, createGatePresenter } from "./cli/factory.ts";
import { selectFlow, promptFeatureName } from "./cli/interactive.ts";
import {
  findResumableWorkflows,
  resumeWorkflow,
} from "./cli/resume.ts";
import inquirer from "inquirer";

import type { AgentRunner, GatePresenter } from "./orchestrator/ports.ts";

// ============================================================================
// Exit codes
// ============================================================================

const ExitCode = {
  Success: 0,
  Usage: 1,
  Validation: 2,
  Blocked: 3,
  Abandoned: 4,
  Runtime: 5,
} as const;

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  // Clear npm preamble noise
  if (!process.argv.includes("--no-clear")) {
    process.stdout.write('\x1b[3J\x1b[H\x1b[2J');
  }

  // ── 1. Parse CLI arguments ────────────────────────────────────
  const parsed = parseArgs(process.argv.slice(2));
  if ("error" in parsed) {
    if (parsed.error) {
      console.error(parsed.error + "\n");
      console.error(parsed.help);
      process.exit(ExitCode.Usage);
    }
    // --help
    console.log(parsed.help);
    process.exit(ExitCode.Usage);
  }

  const args = parsed;

  // ── 2. Load project config ────────────────────────────────────
  const config = loadConfig(args.projectRoot);

  // Determine agents directory early (needed for validation)
  const defaultAgentsDir = path.resolve(__dirname, "../agents");
  const agentsDir = args.agentsDir ?? config.agentsDir ?? defaultAgentsDir;

  // ── 3. Discover flows ─────────────────────────────────────────
  const { flows: discoveredFlows, errors: discoveryErrors } =
    await discoverFlows(args.projectRoot);

  // ── 4. Handle --list-flows ────────────────────────────────────
  if (args.listFlows) {
    console.log("Available flows:\n");
    for (const df of discoveredFlows) {
      const tag = df.source === "project" ? " (project)" : "";
      console.log(`  ${df.flow.id}${tag}`);
      console.log(`    ${df.flow.description}`);
      console.log(`    ${df.flow.steps.length} steps, version ${df.flow.version}`);
      console.log();
    }
    if (discoveryErrors.length > 0) {
      console.log("Discovery errors:");
      for (const err of discoveryErrors) {
        console.log(`  ⚠ ${err}`);
      }
    }
    process.exit(ExitCode.Success);
  }

  // Report discovery errors but don't exit
  for (const err of discoveryErrors) {
    console.warn(`Warning: ${err}`);
  }

  // ── 5. Merge CLI + config ─────────────────────────────────────
  const merged = mergeConfig(
    {
      runner: args.runner,
      gate: args.gate,
      flowId: args.flowId,
      model: args.model,
      agentsDir: args.agentsDir,
    },
    config,
    defaultAgentsDir,
  );

  const runnerName = merged.runner;
  const gateName = args.yes ? "auto-approve" : merged.gate;

  // ── 6. Auto-detect resumable workflows ────────────────────────
  // If --resume wasn't explicitly passed, check for in-progress
  // workflows and offer to resume instead of starting fresh.
  if (!args.resume) {
    const pending = findResumableWorkflows(args.projectRoot);
    if (pending.length > 0) {
      const info = resumeWorkflow(pending[0]);
      const { resume: shouldResume } = await inquirer.prompt<{ resume: boolean }>([{
        type: "confirm",
        name: "resume",
        message: `Found in-progress workflow "${info.featureName}" (step ${info.currentStepIndex + 1}: ${info.currentStepAgent}). Resume?`,
        default: true,
      }]);
      if (shouldResume) {
        args.resume = true; // redirect to resume path below
      }
    }
  }

  // ── 6. Handle --resume ────────────────────────────────────────
  if (args.resume) {
    const workflows = findResumableWorkflows(args.projectRoot);

    if (workflows.length === 0) {
      console.log("No resumable workflows found.");
      process.exit(ExitCode.Usage);
    }

    // Auto-pick the most recent, or let user choose if multiple
    let workflow = workflows[0];
    if (workflows.length > 1) {
      const inquirer = await import("inquirer");
      const { choice } = await inquirer.default.prompt<{ choice: number }>([
        {
          type: "list",
          name: "choice",
          message: "Multiple resumable workflows found. Select one:",
          choices: workflows.map((w, i) => ({
            name: `${w.featurePath} — ${w.state.feature} (step ${w.state.current_step_index + 1}: ${resumeWorkflow(w).currentStepAgent})`,
            value: i,
          })),
        },
      ]);
      workflow = workflows[choice];
    }

    const info = resumeWorkflow(workflow);
    console.log(
      `Resuming ${info.featureName} from step ${info.currentStepIndex + 1}: ${info.currentStepAgent}`,
    );

    // Validate the flow against agents
    const flowDef = discoveredFlows.find(
      f => f.flow.id === info.flowId,
    )?.flow;
    if (!flowDef) {
      console.error(
        `Flow "${info.flowId}" not found. Was it removed?`,
      );
      process.exit(ExitCode.Validation);
    }

    const validationErrors = validateFlow(flowDef, agentsDir);
    if (validationErrors.length > 0) {
      console.error("Flow validation failed:");
      for (const err of validationErrors) {
        console.error(
          `  Step ${err.stepIndex} (${err.agent}): ${err.message}`,
        );
      }
      process.exit(ExitCode.Validation);
    }

    // Create dependencies
    const auth = AuthStorage.create();
    if (args.provider && args.apiKey) {
      auth.setRuntimeApiKey(args.provider, args.apiKey);
    }
    const registry = ModelRegistry.create(auth);
    const agentRunner = createAgentRunner(runnerName, auth, registry);
    const gatePresenter = createGatePresenter(gateName);

    console.clear();
    process.stdout.write('\x1b[3J\x1b[H\x1b[2J');
    const outcome = await runFlow({
      flow: flowDef,
      featureName: info.featureName,
      featureContext: info.featureContext,
      projectRoot: args.projectRoot,
      agentsDir,
      agentRunner,
      gatePresenter,
      outputVerifier: new FilesystemVerifier(),
      progress: new ConsoleProgress(),
      resumeFrom: workflow.state,
      serviceDirs: workflow.state.service_dirs,
      debug: args.debug,
    });

    return handleOutcome(outcome);
  }

  // ── 7. Select flow ────────────────────────────────────────────
  let selectedFlow;
  if (merged.flowId) {
    selectedFlow = discoveredFlows.find(
      f => f.flow.id === merged.flowId,
    );
    if (!selectedFlow) {
      console.error(
        `Flow "${merged.flowId}" not found. Use --list-flows to see available flows.`,
      );
      process.exit(ExitCode.Usage);
    }
  } else {
    // Interactive selection
    selectedFlow = await selectFlow(discoveredFlows);
  }

  // Apply --model flag as flow-level default model
  const flowDef = merged.model
    ? { ...selectedFlow.flow, defaultModel: merged.model }
    : selectedFlow.flow;

  // ── 8. Validate flow ──────────────────────────────────────────
  const validationErrors = validateFlow(flowDef, agentsDir);
  if (validationErrors.length > 0) {
    console.error("Flow validation failed:");
    for (const err of validationErrors) {
      console.error(
        `  Step ${err.stepIndex} (${err.agent}): ${err.message}`,
      );
    }
    process.exit(ExitCode.Validation);
  }

  // ── 9. Get feature name ───────────────────────────────────────
  let featureName = args.featureName;
  let featureContext = args.featureContext;

  // If using default feature name and not in CI/yes mode, prompt interactively
  if (featureName === "default-feature" && !args.yes) {
    const prompted = await promptFeatureName();
    featureName = prompted.name;
    featureContext = prompted.context || featureContext;
  }

  // ── 10. Create dependencies ───────────────────────────────────
  const auth = AuthStorage.create();

  // Runtime API key override (highest priority, not persisted)
  if (args.provider && args.apiKey) {
    auth.setRuntimeApiKey(args.provider, args.apiKey);
  }

  const registry = ModelRegistry.create(auth);
  const agentRunner = createAgentRunner(runnerName, auth, registry);
  const gatePresenter = createGatePresenter(gateName);

  // ── 11. Run flow ──────────────────────────────────────────────
  console.clear();
  process.stdout.write('\x1b[3J\x1b[H\x1b[2J');
  const outcome = await runFlow({
    flow: flowDef,
    featureName,
    featureContext,
    projectRoot: args.projectRoot,
    agentsDir,
    agentRunner,
    gatePresenter,
    outputVerifier: new FilesystemVerifier(),
    progress: new ConsoleProgress(),
    debug: args.debug,
  });

  handleOutcome(outcome);
}

// ============================================================================
// Outcome → exit code
// ============================================================================

function handleOutcome(outcome: {
  status: string;
  state: { build_status?: string };
}): never {
  switch (outcome.status) {
    case "done":
      process.exit(ExitCode.Success);
    case "blocked":
      process.exit(ExitCode.Blocked);
    case "abandoned":
      process.exit(ExitCode.Abandoned);
    default:
      process.exit(ExitCode.Success);
  }
}

// ============================================================================
// Entry
// ============================================================================

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(ExitCode.Runtime);
});
