# Project Builder v2

> Flow orchestration engine — run multi-step LLM agent pipelines with gates, retries, resume, and swappable backends.

## What it does

Runs a pipeline of agents (spec-write → plan → implement → review → lint → doc-sync) against your project. Each step invokes an LLM, verifies outputs, and presents approval gates. Pure TypeScript — the LLM never controls state transitions.

## Quick start

```bash
cd project-builder-v2
npm start
```

Auto-detects in-progress workflows and offers to resume. Prompts for feature name/description interactively.

## Commands

| Command | Purpose |
|---------|---------|
| `npm start` | Interactive — prompts for feature name, flow, gate approvals |
| `npm run ci -- name "desc"` | Unattended — auto-approves everything |
| `npm run resume` | Resume last interrupted workflow (auto-approve) |
| `npm run interactive` | Full pi TUI — steer each step manually |
| `npm run list` | List available flows (feature-build, bug-fix, etc.) |

## Configuration

`.pi/project-builder.json` in your project root:

```json
{
  "runner": "pi-sdk",
  "gate": "inquirer",
  "defaultFlow": "feature-build",
  "model": "deepseek/deepseek-v4-pro"
}
```

## Auth

Priority: `--api-key` > `~/.pi/agent/auth.json` > env vars (`ANTHROPIC_API_KEY`, `DEEPSEEK_API_KEY`, etc.)

## Architecture

```
Orchestrator (pure TS) → AgentRunner (swappable) → LLM
                       → GatePresenter (swappable) → User
                       → OutputVerifier → Filesystem
                       → FlowProgress → Spinner UI
```

- **15 agents** from v1 reused as-is (spec-write, plan, implement, review, lint, doc-sync, etc.)
- **5 flows** built-in + project-level discovery via `.pi/project-builder/flows/*.json`
- **3 runners**: pi-sdk (programmatic), pi-interactive (TUI), claude-code (CLI)
- **3 gate presenters**: inquirer (CLI), auto-approve (CI), pi-tui (TUI)
- **Resume**: detects in-progress workflows, fast-forwards completed steps

## Flows

| Flow | Steps |
|------|-------|
| `feature-build` | spec-write → plan → implement → review → lint → doc-sync |
| `bug-fix` | triage → reproduce → diagnose → fix → verify → doc-sync |
| `small-feature` | spec-write → implement → review → lint → doc-sync |
| `quick-build` | plan → implement → review → lint |
| `ci-build` | plan → implement → lint → doc-sync |

## Key files

```
src/engine/          Types, state machine, persistence, agent-loader, prompt-builder
src/orchestrator/    Ports (interfaces) + orchestrator (runFlow)
src/runners/         pi-sdk, pi-interactive, claude-code
src/gates/           inquirer, auto-approve, pi-tui
src/verifiers/       filesystem (glob, permissions)
src/progress/        console (spinner, step timing, total duration)
src/flows/           builtin flows, validation, discovery
src/cli/             args, factory, config, interactive, resume
agents/              15 agent .md manifests
test/                15 unit tests
```

## What changed vs v1

- ~800 lines of LLM-control machinery removed (gate protocol, subagent suppression, 9 custom tools)
- Engine forked verbatim from v1 (3 import path fixes)
- Prompt assembly extracted, stripped of LLM protocol instructions
- Swappable interfaces for runners, gates, verifiers, progress
