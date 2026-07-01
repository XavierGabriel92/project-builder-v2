# Project Builder v2

**Flow orchestration engine.** Pure TypeScript — the LLM never controls state transitions. Agents run via swappable backends. Gates are direct UI prompts. Resume from any crash point.

## Quick start

```bash
npm start
```

Prompts you for a feature name and description. Auto-detects in-progress workflows and offers to resume. Uses DeepSeek by default via pi SDK.

### Commands

| Command | What it does |
|---------|-------------|
| `npm start` | Interactive mode — pick flow, enter feature name, approve/reject gates |
| `npm run ci -- my-feature "Description"` | Unattended CI mode — auto-approves all gates |
| `npm run resume` | Resume most recent interrupted workflow (auto-approve gates) |
| `npm run interactive` | Full pi TUI — manually steer each step |
| `npm run list` | List available flows |
| `npm test` | Run 15 unit tests |

### CLI flags (when not using npm scripts)

```
--flow <id>       Pick a flow (default: feature-build)
--runner <name>   pi-sdk | pi-interactive | claude-code (default: pi-sdk)
--gate <name>     inquirer | auto-approve (default: inquirer)
--model <p/id>    Model override (e.g. anthropic/claude-sonnet-4-5)
--provider <p>    LLM provider for --api-key
--api-key <key>   Runtime API key (not persisted)
--resume          Resume most recent workflow
--yes, -y         Auto-approve all gates
--no-clear        Keep terminal history
```

### Auth

Priority: `--api-key` > `~/.pi/agent/auth.json` > env vars (`ANTHROPIC_API_KEY`, `DEEPSEEK_API_KEY`, etc.)

---

## Architecture

```
┌──────────────────────────────────────────────┐
│              FLOW ORCHESTRATOR               │
│              (orchestrator.ts)               │
│                                              │
│  iterate steps → run agent → verify outputs  │
│  → present gate → advance / retry / block    │
│                                              │
│  Pure TypeScript. Zero LLM in control path.  │
└──────┬──────────────┬──────────────┬─────────┘
       │              │              │
  AgentRunner    GatePresenter  OutputVerifier
  (interface)    (interface)    (interface)
       │              │              │
  ┌────┴────┐   ┌────┴────┐   ┌────┴────┐
  │ pi-sdk  │   │inquirer │   │filesystem│
  │ pi-tui  │   │auto-ok  │   │ glob     │
  │ claude  │   │ pi-tui  │   └─────────┘
  └─────────┘   └─────────┘
```

### Layers

| Layer | Role | Swappable |
|-------|------|-----------|
| **Engine** (`src/engine/`) | Types, state machine, persistence, agent loader, prompt builder | No (forked from v1) |
| **Orchestrator** (`src/orchestrator/`) | `runFlow()` — pure logic, depends only on interfaces | No |
| **AgentRunner** (`src/runners/`) | Invoke LLM session, return results | Yes |
| **GatePresenter** (`src/gates/`) | Show approval dialog, collect answer | Yes |
| **OutputVerifier** (`src/verifiers/`) | Check output files exist | Yes |
| **FlowProgress** (`src/progress/`) | Step-by-step spinner UI with timing | Yes |
| **Flows** (`src/flows/`) | Flow definitions, validation, discovery | Yes |
| **CLI** (`src/cli/`) | Args, config, interactive prompts, resume | Yes |

### Gate Questions

Agents can write a `gate-questions.json` file to the workflow output directory before completing. When present, the orchestrator reads the file and injects the questions into the approval gate dialog — rendered before the standard Approve/Reject/Exit options. The user answers via the "Request changes" feedback mechanism, and answers are fed back to the LLM on retry.

```json
{
  "questions": [
    { "question": "Which library for date formatting?", "context": "Found dayjs (used) and date-fns (imported/unused). Need a decision." },
    { "question": "Retry strategy for 429 errors?", "context": "Spec says 'handle graceful', no specifics." }
  ]
}
```

- **No new tools needed** — agents already have `write`
- **Backward compatible** — missing file = no questions, gate unchanged
- **Crash-safe** — file is on disk, resume re-reads it

### v1 → v2: what vanished

~800 lines of LLM-control machinery removed:

- `APPROVAL_INSTRUCTION` (200+ lines teaching LLM the gate protocol)
- `SUPPRESS_SUBAGENT_PROGRESS` (LLM subagent tool control)
- Gate nonce system (LLMs can't fabricate answers anymore)
- 9 `flow_*` pi custom tools
- `src/ui/` extension layer

### v1 → v2: what stayed

Engine layer forked verbatim from v1 with 3 import path fixes:

- `types.ts` — FlowDefinition, WorkflowState, AgentManifest
- `transitions.ts` — Pure state machine (createWorkflowState, startStep, applyStepResult, applyGateAnswer)
- `persistence.ts` — Atomic workflow.json I/O
- `agent-loader.ts` — Parse agents/*.md → manifest + prompt
- `agents/*.md` — 15 agent manifests (spec-write, plan, implement, review, lint, doc-sync, etc.)

### New in v2

- `prompt-builder.ts` — Extracted from v1's engine.ts, ~81 lines of LLM protocol stripped
- `orchestrator.ts` — `runFlow()` with retry, gate, fast-forward resume, non-strict output mode
- Swappable runners: pi-sdk (programmatic), pi-interactive (TUI), claude-code (CLI)
- Inquirer gate presenter with clickable file paths and feedback collection
- **Gate questions** — agents can write `gate-questions.json` to surface unresolved questions during approval; user answers via feedback
- ConsoleProgress: spinner animation, step timing, total duration
- Auto-resume: detects in-progress workflows, fast-forwards completed steps
- 5 built-in flows: feature-build, bug-fix, small-feature, quick-build, ci-build

---

## Files

```
src/
├── engine/          types, transitions, persistence, agent-loader, prompt-builder, frontmatter, project-rules
├── orchestrator/    ports.ts, orchestrator.ts
├── runners/         pi-sdk-runner, pi-interactive-runner, claude-code-runner, shared, config, registry
├── gates/           inquirer-gate, noop-gate, pi-tui-gate, resolver
├── verifiers/       filesystem (glob support, permission handling)
├── progress/        console (spinner, timing), noop
├── flows/           builtin (5 flows), validation, discovery
├── cli/             args, factory, config, interactive, resume
└── main.ts          entry point
agents/              15 agent .md manifests + subagents/
test/                16 prompt-builder unit tests
plans/               implementation plans
docs/                gate bug decision record
```

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | Flow completed |
| 1 | Usage error |
| 2 | Flow validation failed |
| 3 | Flow blocked (exhausted retries) |
| 4 | Flow abandoned (user aborted) |
| 5 | Runtime error |
