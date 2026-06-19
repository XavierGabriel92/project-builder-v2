# Implementation Plan: FLOWS Layer + ENTRY POINT (main.ts)

Date: 2026-06-18
Architecture reference: `/Users/gabrielxavier/Documents/project-builder-v2/README.md`

---

## Goal

Implement a production-ready flow registry with validation, discovery, and composition for Project Builder v2, plus a CLI entry point that handles argument parsing, dependency injection, flow selection, resume support, and error reporting.

---

## PART 1 — FLOWS LAYER

### Task 1: Reconcile v1 ↔ v2 flow definitions

**Current state:** v2 has `src/flows/builtin.ts` with 3 flows (FEATURE_BUILD_FLOW, QUICK_BUILD_FLOW, CI_BUILD_FLOW). v1 has `flows/index.ts` with 3 different flows (FEATURE_BUILD_FLOW v6 6-step, BUG_FIX_FLOW 6-step, SMALL_FEATURE_FLOW 5-step). Also v1 has `allFlows: FlowDefinition[]`.

**Action:** Merge both into a single authoritative file. Keep v1's FEATURE_BUILD_FLOW (version 6) instead of v2's simplified version (version 6), port BUG_FIX_FLOW and SMALL_FEATURE_FLOW from v1, and add QUICK_BUILD_FLOW and CI_BUILD_FLOW as new entries.

**File:** `src/flows/builtin.ts`

**Changes:**
- Replace current FEATURE_BUILD_FLOW with v1's version (6 steps with version 6, correct description)
- Add BUG_FIX_FLOW (6 steps: triage(gate) → reproduce → diagnose → fix(2 attempts) → verify(gate) → doc-sync)
- Add SMALL_FEATURE_FLOW (5 steps: spec-write(gate) → implement(2) → review(gate) → lint → doc-sync)
- Keep QUICK_BUILD_FLOW (4 steps: plan → implement(2) → review(gate) → lint)
- Keep CI_BUILD_FLOW (4 steps: plan → implement(3) → lint → doc-sync(2))
- Export `allFlows: FlowDefinition[]` array for discovery
- Add `getFlow(id: string): FlowDefinition | undefined` lookup function

**Acceptance:** `allFlows.length === 5`, each flow has valid step agents, `getFlow("bug-fix")` returns the BUG_FIX_FLOW.

**Dependencies:** Requires `src/engine/types.ts` to be present (FlowDefinition, FlowStep types). These would be copied from v1 as stubs if not yet ported.

---

### Task 2: FlowDefinition — type design review

**Current type** (from v1 `src/shared/types.ts:37`):
```typescript
interface FlowDefinition {
  id: string;
  version: number;
  description: string;
  steps: FlowStep[];
  strictOutputs?: boolean;
}

interface FlowStep {
  id?: string;
  agent: string;
  requestApproval?: boolean;
  attempts?: number;
  model?: string;
}
```

**Decision:** This is sufficient for v2.0. No additions needed.

**Reasoning against each proposed extension:**
| Proposal | Verdict | Rationale |
|----------|---------|-----------|
| pre/post step hooks | **Defer to v2.1** | Swappable AgentRunner/GatePresenter already enables wrapping. A hook system is useful but adds complexity without a clear use case yet. |
| Conditional steps (`if`/`branch`) | **Defer to v2.2** | This is a full DSL. The orchestrator would need a condition evaluator. Let users compose flows for now. If a step fails, retry/block handles it — no need for conditional branching in v2.0. |
| Dynamic step generation | **Defer** | Too complex for v2.0. Users can write a custom flow definition in code. |
| `description` as markdown | **Keep as-is** | A single string is fine. The description appears in flow selection menus. |
| Step-level `timeout` | **Defer** | AgentRunner implementations handle their own timeouts (pi SDK has it built in, Claude Code has `--timeout`). Not needed on the FlowStep type. |

**No changes to FlowDefinition or FlowStep types.** The existing types are the right level of abstraction for v2.0.

---

### Task 3: Flow validation

**Current state:** v1 has `validateFlows(flows, agentsDir)` in `src/engine/engine.ts` that:
1. Calls `loadFlowAgents()` to verify all referenced agent .md files exist
2. Calls `validateFlowApproval()` to verify gates have approval manifests

**Action:** Extract this into a dedicated `src/flows/validation.ts` that the orchestrator calls at `runFlow()` start time.

**File:** `src/flows/validation.ts`

**Implementation:**
```typescript
// src/flows/validation.ts
import { type FlowDefinition } from "../engine/types.ts";
import { loadAgent } from "../engine/agent-loader.ts";

export interface ValidationError {
  flowId: string;
  stepIndex: number;
  agent: string;
  message: string;
}

export function validateFlow(flow: FlowDefinition, agentsDir: string): ValidationError[] {
  const errors: ValidationError[] = [];

  for (let i = 0; i < flow.steps.length; i++) {
    const step = flow.steps[i];

    // 1. Agent .md exists
    let agent;
    try {
      agent = loadAgent(agentsDir, step.agent);
    } catch (err) {
      errors.push({
        flowId: flow.id,
        stepIndex: i,
        agent: step.agent,
        message: `Agent "${step.agent}" not found: ${(err as Error).message}`
      });
      continue; // skip further validation for missing agent
    }

    // 2. Gate step must have approval manifest
    if (step.requestApproval && !agent.manifest.approval) {
      errors.push({
        flowId: flow.id,
        stepIndex: i,
        agent: step.agent,
        message: `Step requires approval but agent "${step.agent}" has no approval block`
      });
    }

    // 3. Subagents referenced in parallel config must exist
    if (agent.manifest.parallel?.subagent && agent.manifest.subagents) {
      const subagentPath = agent.manifest.subagents[agent.manifest.parallel.subagent];
      if (!subagentPath) {
        errors.push({
          flowId: flow.id,
          stepIndex: i,
          agent: step.agent,
          message: `parallel_subagent "${agent.manifest.parallel.subagent}" not found in subagents`
        });
      } else {
        try {
          loadAgent(agentsDir, subagentPath, true);
        } catch {
          errors.push({
            flowId: flow.id,
            stepIndex: i,
            agent: step.agent,
            message: `Subagent "${subagentPath}" file not found`
          });
        }
      }
    }
  }

  return errors;
}

export function validateFlows(flows: FlowDefinition[], agentsDir: string): ValidationError[] {
  return flows.flatMap(f => validateFlow(f, agentsDir));
}
```

**Acceptance:** Unit test with: valid flow yields 0 errors, missing agent yields error, gate without approval yields error, missing subagent yields error.

**Integration point:** `src/main.ts` calls `validateFlow(selectedFlow, agentsDir)` before `runFlow()`. If errors exist, print them and exit(1).

---

### Task 4: Flow discovery from user projects

**Goal:** Users can define custom flows in their project at `.pi/project-builder/flows/` (or a configured path). The CLI auto-discovers them alongside built-in flows.

**File:** `src/flows/discovery.ts`

**Implementation:**
```typescript
// src/flows/discovery.ts
import * as fs from "node:fs";
import * as path from "node:path";
import type { FlowDefinition } from "../engine/types.ts";

export interface DiscoveredFlow {
  flow: FlowDefinition;
  source: "builtin" | "project";
  filePath?: string; // only for project flows
}

export async function discoverFlows(
  projectRoot: string
): Promise<{ flows: DiscoveredFlow[]; errors: string[] }> {
  // 1. Built-in flows
  const { allFlows } = await import("./builtin.ts");
  const builtin: DiscoveredFlow[] = allFlows.map(flow => ({
    flow,
    source: "builtin" as const,
  }));

  // 2. Project flows (.pi/project-builder/flows/*.json or *.ts)
  const projectFlowsDir = path.join(projectRoot, ".pi", "project-builder", "flows");
  const discovered: DiscoveredFlow[] = [...builtin];
  const errors: string[] = [];

  if (fs.existsSync(projectFlowsDir)) {
    for (const entry of fs.readdirSync(projectFlowsDir)) {
      if (entry.endsWith(".json")) {
        try {
          const raw = fs.readFileSync(path.join(projectFlowsDir, entry), "utf-8");
          const flow = JSON.parse(raw) as FlowDefinition;
          // Basic validation
          if (!flow.id || !Array.isArray(flow.steps)) {
            errors.push(`${entry}: missing id or steps array`);
            continue;
          }
          discovered.push({ flow, source: "project", filePath: entry });
        } catch (err) {
          errors.push(`${entry}: ${(err as Error).message}`);
        }
      }
    }
  }

  // 3. Deduplicate: project flows with same id override builtin
  const byId = new Map<string, DiscoveredFlow>();
  for (const d of discovered) {
    if (d.source === "project" || !byId.has(d.flow.id)) {
      byId.set(d.flow.id, d);
    }
  }

  return {
    flows: [...byId.values()].sort((a, b) =>
      a.flow.id.localeCompare(b.flow.id)
    ),
    errors,
  };
}
```

**Acceptance:** Unit test with mock filesystem: no project dir returns only builtin flows, project with valid JSON adds to list, project with invalid JSON includes error, project flow overrides builtin with same id.

---

### Task 5: Flow composition (flow references another flow)

**Decision for v2.0:** NOT implemented. Track as a deferred feature.

**Rationale:** Flow composition (e.g., `"ci-build" → "deploy-to-prod"`) requires:
- A `FlowReference` step type (vs `FlowStep`)
- The orchestrator to handle nested flow execution
- Workflow state nesting (sub-workflow.json per composed flow)
- Rollback semantics if a composed flow partially completes

This is a significant feature. For v2.0, users compose flows by writing a custom `FlowDefinition` with all desired steps inline, or by writing a script that calls `runFlow()` twice in sequence. Defer composition to v2.1.

---

### Task 6: Flow-specific model configuration

**Problem:** The BUG_FIX_FLOW might benefit from an Opus-level model, while CI_BUILD_FLOW should use Haiku for cost. Currently model is per-step only (`FlowStep.model`).

**Decision:** Add `defaultModel?: string` to `FlowDefinition` (optional, backward-compatible). If a step has no `model`, fall back to `flow.defaultModel`, then to the runner's default.

**File:** `src/engine/types.ts` — add field to `FlowDefinition`.

**Change:**
```typescript
export interface FlowDefinition {
  // ...existing fields...
  /** Default model for all steps (overridden by per-step model). */
  defaultModel?: string;
}
```

**Orchestrator change:** In `executeStep()`, resolve model as:
```typescript
const model = flowStep.model
  ?? state.flow_snapshot.defaultModel
  ?? undefined; // runner default
```

**Acceptance:** FEATURE_BUILD_FLOW with `defaultModel: "claude-sonnet-4-5"` passes that model to AgentRunner when no per-step model is set.

---

### FLOWS layer: prioritized task list

| Priority | Task | Effort | Depends on |
|----------|------|--------|------------|
| P0 | Task 1: Reconcile v1↔v2 flow definitions | S | engine/types.ts stub |
| P0 | Task 3: Flow validation | M | agent-loader.ts stub |
| P0 | Task 2: Type design review (no-op — confirm sufficiency) | XS | none |
| P1 | Task 4: Flow discovery from user projects | M | Task 1 |
| P1 | Task 6: Flow-level defaultModel | S | Task 1, orchestrator |
| P2 | Task 5: Flow composition | DEFERRED to v2.1 | — |

---

## PART 2 — ENTRY POINT (main.ts)

### Task 7: CLI argument parsing

**Current state:** `main.ts` uses raw `process.argv[2..4]` for projectRoot, featureName, featureContext. No flags, no help, no validation.

**Goal:** Robust CLI with `--flow`, `--runner`, `--gate`, `--resume`, `--help`, `--list-flows`, `--yes` (auto-approve all gates), and positional args.

**File:** `src/cli/args.ts`

**Implementation:**
```typescript
// src/cli/args.ts
import * as path from "node:path";

export interface CliArgs {
  projectRoot: string;
  featureName: string;
  featureContext?: string;
  flowId?: string;         // --flow <id>
  runner: string;          // --runner <name>, default: "pi-interactive"
  gate: string;            // --gate <name>, default: "inquirer"
  resume: boolean;         // --resume
  listFlows: boolean;      // --list-flows
  yes: boolean;            // --yes (auto-approve gates)
  help: boolean;           // --help
  agentsDir?: string;      // --agents-dir <path>
  model?: string;          // --model <provider/id>
}

const USAGE = `
project-builder-v2 — execute multi-step agent pipelines

Usage:
  project-builder-v2 [options] [project-root] [feature-name] [feature-context]

Options:
  --flow <id>       Flow to run (default: feature-build)
                    Use --list-flows to see available flows
  --runner <name>   Agent backend (default: pi-interactive)
                    Built-in: pi-sdk, pi-interactive, claude-code
  --gate <name>     Gate presenter (default: inquirer)
                    Built-in: inquirer, auto-approve
  --resume          Resume most recent workflow in the project
  --list-flows      List available flows and exit
  --yes, -y         Auto-approve all gates (CI mode)
  --model <id>      Default model for all steps
  --agents-dir      Path to agents/ directory
  --help, -h        Show this help

Examples:
  project-builder-v2 ./my-project user-auth "Add OAuth2 login"
  project-builder-v2 --flow bug-fix ./my-project fix-login-timeout
  project-builder-v2 --resume ./my-project
  project-builder-v2 --runner pi-sdk --gate auto-approve --yes ./my-project ci-deploy
`;

export function parseArgs(raw: string[]): CliArgs | { error: string; help: string } {
  const args: CliArgs = {
    projectRoot: process.cwd(),
    featureName: "default-feature",
    runner: "pi-interactive",
    gate: "inquirer",
    resume: false,
    listFlows: false,
    yes: false,
    help: false,
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
  if (positional.length > 0) args.projectRoot = path.resolve(positional[0]);
  if (positional.length > 1) args.featureName = positional[1];
  if (positional.length > 2) args.featureContext = positional.slice(2).join(" ");

  // Validate
  if (args.help) return { error: "", help: USAGE };

  if (args.flowId && args.resume) {
    return { error: "Cannot specify both --flow and --resume. Use one or the other.", help: USAGE };
  }

  if (!args.resume && !args.listFlows && positional.length === 0 && !args.flowId) {
    // OK — defaults apply. But featureName will be "default-feature" unless overridden.
  }

  return args;
}
```

**Acceptance:** `--help` prints usage, `--flow bug-fix` sets flowId, `--list-flows` sets flag, `--runner pi-sdk --gate auto-approve` sets both, positional args populate projectRoot/featureName/featureContext.

---

### Task 8: Dependency injection — constructing AgentRunner and GatePresenter

**Current state:** main.ts imports concrete classes directly at the top of the file. No runtime selection.

**Goal:** A factory function that resolves runner/gate names to instances, with proper dependency injection for pi SDK runners (AuthStorage, ModelRegistry).

**File:** `src/cli/factory.ts`

**Implementation:**
```typescript
// src/cli/factory.ts
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { AgentRunner, GatePresenter } from "../orchestrator/ports.ts";
import { PiSdkRunner } from "../runners/pi-sdk-runner.ts";
import { PiInteractiveRunner } from "../runners/pi-interactive-runner.ts";
import { ClaudeCodeRunner } from "../runners/claude-code-runner.ts";
import { InquirerGatePresenter } from "../gates/inquirer-gate.ts";
import { AutoApproveGate } from "../gates/noop-gate.ts";

export function createAgentRunner(
  name: string,
  authStorage: AuthStorage,
  modelRegistry: ModelRegistry,
): AgentRunner {
  switch (name) {
    case "pi-sdk":
      return new PiSdkRunner({ authStorage, modelRegistry });
    case "pi-interactive":
      return new PiInteractiveRunner();
    case "claude-code":
      return new ClaudeCodeRunner();
    default:
      throw new Error(
        `Unknown runner "${name}". Available: pi-sdk, pi-interactive, claude-code`
      );
  }
}

export function createGatePresenter(name: string): GatePresenter {
  switch (name) {
    case "inquirer":
      return new InquirerGatePresenter();
    case "auto-approve":
      return new AutoApproveGate();
    default:
      throw new Error(
        `Unknown gate presenter "${name}". Available: inquirer, auto-approve`
      );
  }
}
```

**Acceptance:** `createAgentRunner("pi-interactive")` returns PiInteractiveRunner. `createAgentRunner("nonexistent")` throws with helpful message listing available options.

---

### Task 9: Configuration file support

**Goal:** Read `.pi/project-builder.json` from the project root for per-project defaults (preferred runner, preferred gate, default flow, custom agents directory).

**File:** `src/cli/config.ts`

**Implementation:**
```typescript
// src/cli/config.ts
import * as fs from "node:fs";
import * as path from "node:path";

export interface ProjectBuilderConfig {
  /** Default agent backend. */
  runner?: string;
  /** Default gate presenter. */
  gate?: string;
  /** Default flow to run when none specified. */
  defaultFlow?: string;
  /** Custom agents directory (relative to project root or absolute). */
  agentsDir?: string;
  /** Default model. */
  model?: string;
}

const CONFIG_FILE = ".pi/project-builder.json";

export function loadConfig(projectRoot: string): ProjectBuilderConfig {
  const configPath = path.join(projectRoot, CONFIG_FILE);
  if (!fs.existsSync(configPath)) return {};

  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw);
    return {
      runner: parsed.runner,
      gate: parsed.gate,
      defaultFlow: parsed.defaultFlow,
      agentsDir: parsed.agentsDir,
      model: parsed.model,
    };
  } catch (err) {
    console.warn(`Warning: could not parse ${CONFIG_FILE}: ${(err as Error).message}`);
    return {};
  }
}

export function mergeConfig(cli: { runner: string; gate: string; flowId?: string; model?: string; agentsDir?: string }, config: ProjectBuilderConfig): {
  runner: string;
  gate: string;
  flowId: string;
  model?: string;
  agentsDir: string;
} {
  return {
    runner: cli.runner !== "pi-interactive" ? cli.runner : (config.runner ?? "pi-interactive"),
    gate: cli.gate !== "inquirer" ? cli.gate : (config.gate ?? "inquirer"),
    flowId: cli.flowId ?? config.defaultFlow ?? "feature-build",
    model: cli.model ?? config.model,
    agentsDir: cli.agentsDir ?? config.agentsDir ?? path.resolve(__dirname, "../../agents"),
  };
}
```

**Acceptance:** Project with `.pi/project-builder.json` containing `{"defaultFlow": "quick-build"}` and no `--flow` flag runs quick-build. CLI flag `--flow bug-fix` overrides config.

---

### Task 10: Interactive flow selection

**Goal:** When no `--flow` flag and no `config.defaultFlow`, show an interactive menu (similar to v1's `/project-builder` slash command). Use Inquirer.js (already a dependency).

**File:** `src/cli/interactive.ts`

**Implementation:**
```typescript
// src/cli/interactive.ts
import inquirer from "inquirer";
import type { DiscoveredFlow } from "../flows/discovery.ts";

export async function selectFlow(flows: DiscoveredFlow[]): Promise<DiscoveredFlow> {
  if (flows.length === 1) return flows[0];

  const { flowId } = await inquirer.prompt<{ flowId: string }>([{
    type: "list",
    name: "flowId",
    message: "Select a workflow:",
    choices: flows.map(f => ({
      name: `${f.flow.id}${f.source === "project" ? " (project)" : ""} — ${f.flow.description}`,
      value: f.flow.id,
    })),
    pageSize: 15,
  }]);

  return flows.find(f => f.flow.id === flowId)!;
}

export async function promptFeatureName(): Promise<{ name: string; context?: string }> {
  const { name } = await inquirer.prompt<{ name: string }>([{
    type: "input",
    name: "name",
    message: "Feature name (used for workflow directory):",
    validate: (val: string) =>
      val.trim().length > 0 ? true : "Feature name is required",
  }]);

  const { context } = await inquirer.prompt<{ context: string }>([{
    type: "input",
    name: "context",
    message: "What do you want to build? (optional description):",
  }]);

  return { name: name.trim(), context: context.trim() || undefined };
}
```

**Acceptance:** Interactive mode shows all discovered flows with descriptions, allows selection, prompts for feature name and context. Exits cleanly on Ctrl+C (returns undefined, main.ts handles graceful exit).

---

### Task 11: Resume support

**Goal:** `--resume` detects the most recent `workflow.json` in `.temp/` directories and resumes execution from the current step. Or if there's only one in-progress workflow, auto-resume it.

**File:** `src/cli/resume.ts`

**Implementation:**
```typescript
// src/cli/resume.ts
import * as fs from "node:fs";
import * as path from "node:path";
import { readWorkflow, getWorkflowDir } from "../engine/persistence.ts";
import { resolveFeaturePath } from "../engine/persistence.ts";
import type { WorkflowState } from "../engine/types.ts";
import { currentStep } from "../engine/transitions.ts";

export interface ResumableWorkflow {
  featurePath: string;
  state: WorkflowState;
  mtime: number;
}

export function findResumableWorkflows(projectRoot: string): ResumableWorkflow[] {
  const tempDir = path.join(projectRoot, ".temp");
  if (!fs.existsSync(tempDir)) return [];

  const results: ResumableWorkflow[] = [];

  for (const entry of fs.readdirSync(tempDir)) {
    const dirPath = path.join(tempDir, entry);
    const wfPath = path.join(dirPath, "workflow.json");
    if (!fs.existsSync(wfPath)) continue;

    try {
      const state = readWorkflow(projectRoot, entry);
      if (!state) continue;

      // Only in-progress and awaiting_user workflows are resumable
      if (state.status !== "in_progress" && state.status !== "awaiting_user") continue;

      const stat = fs.statSync(wfPath);
      results.push({ featurePath: entry, state, mtime: stat.mtimeMs });
    } catch {
      // Corrupt workflow, skip
    }
  }

  // Sort by most recently modified first
  return results.sort((a, b) => b.mtime - a.mtime);
}

export function resumeWorkflow(workflow: ResumableWorkflow): {
  flowId: string;
  featureName: string;
  featureContext?: string;
  currentStepIndex: number;
  currentStepAgent: string;
} {
  const step = currentStep(workflow.state);
  return {
    flowId: workflow.state.flow_id,
    featureName: workflow.state.feature,
    featureContext: workflow.state.feature_context,
    currentStepIndex: workflow.state.current_step_index,
    currentStepAgent: step?.agent ?? "(done)",
  };
}
```

**Orchestrator change:** `runFlow()` needs a `resumeFrom?: WorkflowState` option. If provided, it skips `createWorkflowState()` and uses the existing state:

```typescript
// In orchestrator.ts:
export interface OrchestratorOptions {
  // ...existing fields...
  /** Resume from an existing workflow state (for --resume). */
  resumeFrom?: WorkflowState;
}
```

**Acceptance:** Project with in-progress workflow in `.temp/12-06-2026-user-auth/workflow.json` → `--resume` detects it, prints "Resuming user-auth from step 3: implement", and continues.

---

### Task 12: Error reporting and exit codes

**Goal:** Consistent exit codes for CI integration.

**File:** `src/main.ts` (extend)

| Exit code | Meaning |
|-----------|---------|
| 0 | Flow completed successfully |
| 1 | Usage error (bad args, --help) |
| 2 | Flow validation failed (missing agent, bad flow) |
| 3 | Flow blocked (step exhausted retries) |
| 4 | Flow abandoned (user aborted via gate) |
| 5 | Runtime error (unexpected exception) |

**Implementation:** Wrap `runFlow()` in try/catch in main.ts, map outcomes to exit codes.

---

### Task 13: Rewrite main.ts

**File:** `src/main.ts` — full rewrite integrating all components above.

**Flow:**
```
parseArgs()
  ├── --help → print usage, exit(1)
  ├── --list-flows → discoverFlows(), print list, exit(0)
  │
  ├── loadConfig()
  ├── mergeConfig(cli, config)
  ├── discoverFlows()
  │
  ├── --resume?
  │   ├── findResumableWorkflows()
  │   ├── show selection if multiple, or auto-pick
  │   └── use resumeFrom.state
  │
  ├── Determine flow:
  │   ├── --flow flag → use it
  │   ├── config.defaultFlow → use it
  │   └── else → selectFlow() interactive
  │
  ├── Determine feature name:
  │   ├── --resume → from workflow state
  │   ├── positional arg → use it
  │   └── else → promptFeatureName()
  │
  ├── validateFlow(selectedFlow, agentsDir)
  │   └── errors → print, exit(2)
  │
  ├── Create dependencies:
  │   ├── createAgentRunner(runner, auth, registry)
  │   ├── createGatePresenter(gate)
  │   │   └── --yes → override to AutoApproveGate
  │   ├── new FilesystemVerifier()
  │   └── new ConsoleProgress()
  │
  └── runFlow({...})
      ├── success → exit(0)
      ├── blocked → exit(3)
      └── abandoned → exit(4)
```

**Acceptance:** Full integration test: `--help` prints usage, `--flow bug-fix ./proj my-bug "description"` runs bug-fix flow, `--resume ./proj` resumes existing workflow, invalid flow exits with code 2.

---

### Task 14: AgentRunner model resolution from FlowDefinition.defaultModel

**File:** `src/orchestrator/orchestrator.ts` — small change to `executeStep()`.

**Change:** Resolve model as:
```typescript
const model = flowStep.model
  ?? state.flow_snapshot.defaultModel
  ?? undefined;
```

This allows flows to specify a default model (`FlowDefinition.defaultModel`) that applies to all steps unless overridden at the step level.

**Acceptance:** CI_BUILD_FLOW with `defaultModel: "claude-haiku-4-5"` passes that model to AgentRunner for every step.

---

### ENTRY POINT: prioritized task list

| Priority | Task | Effort | Depends on |
|----------|------|--------|------------|
| P0 | Task 7: CLI argument parsing | M | none |
| P0 | Task 8: Dependency injection factory | S | PiSdkRunner, PiInteractiveRunner stubs |
| P0 | Task 9: Configuration file support | S | none |
| P0 | Task 13: Rewrite main.ts | L | Tasks 7-12 |
| P1 | Task 10: Interactive flow selection | M | Task 4 (flow discovery) |
| P1 | Task 11: Resume support | M | engine/persistence.ts |
| P1 | Task 12: Exit codes | XS | Task 13 |
| P1 | Task 14: Flow-level defaultModel | XS | Task 6, orchestrator |

---

## Cross-cutting concerns

### Engine imports (types.ts, transitions.ts, persistence.ts, agent-loader.ts)

The orchestrator and flows import from `../engine/*`. These files need stub implementations before this plan can be tested end-to-end. Minimum required:

- `engine/types.ts`: FlowDefinition, FlowStep, WorkflowState, WorkflowStatus, StepStatus, WorkflowStep, StepResult, GateAnswer
- `engine/transitions.ts`: createWorkflowState, startStep, applyStepResult, applyGateAnswer, currentStep, currentWorkflowStep, cloneState
- `engine/persistence.ts`: resolveFeaturePath, resolveWorkflowDir, writeWorkflow, readWorkflow, listWorkflows, getWorkflowDir
- `engine/agent-loader.ts`: loadAgent, buildPrompt, buildSystemPrefix, LoadedAgent

See the [engine plan](./01-engine.md) for details.

### Testing strategy

| What | How |
|------|-----|
| `validateFlow()` | Unit test with mock agentsDir — valid flow, missing agent, missing approval, missing subagent |
| `discoverFlows()` | Unit test with temp dirs — no project dir, valid JSON, invalid JSON, override builtin |
| `parseArgs()` | Unit test with string arrays — every flag combination |
| `mergeConfig()` | Unit test — CLI overrides config, config provides defaults |
| `findResumableWorkflows()` | Integration test with temp .temp/ dir |
| `main.ts` flow | Integration test with mock AgentRunner (returns fake success) |

### Risks

1. **agent-loader.ts must exist before anything compiles.** The engine module is the foundation. If the engine plan is done in parallel, coordinate the types.

2. **Inquirer.js is a heavy dependency.** If you later want a zero-dependency CLI, you'd need to swap it. But Inquirer is already in the v2 package.json, so it's fine for now.

3. **Interactive mode + `--yes` conflict.** If someone runs `--runner pi-interactive --yes`, the GatePresenter is auto-approve but the AgentRunner shows a full TUI. That's intentional — `--yes` only affects gates, not runner interactivity. But document it clearly.

4. **Resume may skip past a broken step.** If the engine state has a step marked "running" but the process crashed, resuming will re-run that step (the orchestrator calls `startStep` which resets it). Verify this behavior in testing.

5. **Flow discovery from JSON files is fragile.** JSON FlowDefinitions can't reference the FlowDefinition TypeScript type at runtime. Consider adding a JSON schema for validation, or supporting `.ts` project flows loaded via dynamic import.
