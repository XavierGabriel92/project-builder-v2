# Implementation Plan: GATES Layer

Date: 2026-06-18
Architecture reference: `/Users/gabrielxavier/Documents/project-builder-v2/README.md`

---

## Goal

Implement concrete `GatePresenter` implementations that render approval dialogs and collect user answers — all conforming to the `GatePresenter` interface in `ports.ts`.

---

## Current state

Two stubs exist:
- `src/gates/inquirer-gate.ts` — CLI-based gate using Inquirer.js. Complete but basic.
- `src/gates/noop-gate.ts` — Auto-approve for CI. Complete and simple.

Missing:
- `src/gates/pi-tui-gate.ts` — Gate presented inside pi's TUI (for `PiInteractiveRunner`)
- Gate answer validation improvements
- Preview file rendering with syntax highlighting
- Timeout support for unattended gates

---

## Task 1: Enhance InquirerGatePresenter

**Current issues:**
1. Preview file is shown as raw text — no syntax highlighting, no pagination for large files
2. No "go back" or "cancel" on the feedback prompt (you're stuck if you change your mind)
3. No timeout (hanging CI if nobody answers)
4. No keyboard shortcut display (e.g., "Press Enter to select")

**File:** `src/gates/inquirer-gate.ts`

### 1a. Preview file with pagination
```typescript
async present(gate: GateInput, cwd: string): Promise<GateAnswer> {
  if (gate.previewPath) {
    const fullPath = path.resolve(cwd, gate.previewPath);
    if (fs.existsSync(fullPath)) {
      await this.showPreview(fullPath);
    }
  }
  // ...
}

private async showPreview(filePath: string): Promise<void> {
  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.split("\n");

  if (lines.length <= 40) {
    // Short enough to show inline
    console.log("\n" + "─".repeat(60));
    console.log(content);
    console.log("─".repeat(60) + "\n");
    return;
  }

  // Paginate with a pager (less-like experience)
  // Use Inquirer's built-in or a simple approach
  const { action } = await inquirer.prompt([{
    type: "list",
    name: "action",
    message: `Preview: ${path.basename(filePath)} (${lines.length} lines)`,
    choices: [
      { name: "View first 30 lines", value: "head" },
      { name: "View last 30 lines", value: "tail" },
      { name: "Skip preview", value: "skip" },
    ],
  }]);

  if (action === "head") {
    console.log("\n" + lines.slice(0, 30).join("\n"));
    if (lines.length > 30) console.log(`\n... ${lines.length - 30} more lines ...`);
  } else if (action === "tail") {
    console.log("\n... first ${lines.length - 30} lines ...\n");
    console.log(lines.slice(-30).join("\n"));
  }
}
```

### 1b. Allow escape from feedback prompt
```typescript
if (choice.feedback) {
  const { text, cancelled } = await inquirer.prompt([
    {
      type: "input",
      name: "text",
      message: "What changes are needed? (enter to skip, 'cancel' to go back)",
    },
    // Wrap with ability to detect "cancel"
  ]);
  // If user types "cancel" or empty, go back to option selection
}
```

Actually, Inquirer.js doesn't support going back easily. A simpler approach: allow empty feedback (skip), and show the gate options again if feedback is blank but required:

```typescript
if (choice.feedback) {
  const { text } = await inquirer.prompt([{
    type: "input",
    name: "text",
    message: "What changes are needed?",
    default: "",
  }]);
  feedback = text.trim() || undefined;
  if (!feedback) {
    console.log("No feedback provided. Returning to gate options...\n");
    return this.present(gate, cwd); // Re-present the gate
  }
}
```

### 1c. Timeout support
```typescript
export interface InquirerGateOptions {
  /** Timeout in ms. If exceeded, returns a configurable default. Default: no timeout. */
  timeout?: number;
  /** Default answer when timeout is hit. Default: first abort option, or first advance option. */
  timeoutAction?: "approve" | "abort";
}

// In the prompt:
const { choice } = await withTimeout(
  inquirer.prompt([...]),
  this.options.timeout,
  () => this.getTimeoutAnswer(gate),
);
```

**Acceptance:** Large preview files show pagination options. Empty feedback returns to gate. Timeout triggers default action.

---

## Task 2: Pi TUI Gate Presenter

**Goal:** When running inside pi's TUI (via `PiInteractiveRunner` or as a pi extension), present gates using pi's native UI components (`ctx.ui.select`, `ctx.ui.input`) instead of Inquirer.js.

**File:** `src/gates/pi-tui-gate.ts` (NEW)

```typescript
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GatePresenter, GateInput, GateAnswer } from "../orchestrator/ports.ts";

export class PiTuiGatePresenter implements GatePresenter {
  readonly name = "pi-tui";

  constructor(private ctx: ExtensionContext) {}

  async present(gate: GateInput, cwd: string): Promise<GateAnswer> {
    // Show preview as a notification or widget
    if (gate.previewPath) {
      const fullPath = path.resolve(cwd, gate.previewPath);
      if (fs.existsSync(fullPath)) {
        const content = fs.readFileSync(fullPath, "utf-8");
        // Show as notification (truncated) or as a temporary widget
        this.ctx.ui.notify(
          `Preview: ${path.basename(gate.previewPath)}\n${content.slice(0, 500)}${content.length > 500 ? "..." : ""}`,
          "info"
        );
      }
    }

    // Present gate options
    const answer = await this.ctx.ui.select(
      gate.header,
      gate.options.map(opt => ({
        label: opt.label,
        description: opt.description,
        value: opt,
      })),
    );

    if (!answer) {
      // User cancelled (Escape) → default to abort
      const abortOpt = gate.options.find(o => o.abort);
      if (abortOpt) {
        return { label: abortOpt.label, advance: false, abort: true };
      }
      // Fallback to first advance option
      const approveOpt = gate.options.find(o => o.advance)!;
      return { label: approveOpt.label, advance: true };
    }

    let feedback: string | undefined;
    if (answer.feedback) {
      const text = await this.ctx.ui.input("What changes are needed?");
      feedback = text || undefined;
    }

    return {
      label: answer.label,
      advance: answer.advance,
      abort: answer.abort,
      feedback,
    };
  }
}
```

**Integration:** When `PiInteractiveRunner` runs, it creates a `PiTuiGatePresenter` and passes it to the orchestrator. The orchestrator's `gatePresenter.present()` then renders inside the pi TUI.

**Acceptance:** Running `--runner pi-interactive` shows gates as pi TUI select menus instead of Inquirer.js prompts. Escape on a gate returns an abort answer.

---

## Task 3: Gate presenter selection strategy

**Problem:** The right gate presenter depends on the runner. `PiInteractiveRunner` works best with `PiTuiGatePresenter`. `PiSdkRunner` and `ClaudeCodeRunner` work with `InquirerGatePresenter`. `--yes` always uses `AutoApproveGate`.

**Decision:** The CLI factory (`src/cli/factory.ts`) should pick the gate presenter based on the runner, with the `--gate` flag as an override:

```typescript
export function resolveGatePresenter(
  runnerName: string,
  cliGate: string,
  cliYes: boolean,
): GatePresenter {
  if (cliYes) return new AutoApproveGate();

  if (cliGate !== "inquirer") {
    // Explicit override
    return createGatePresenter(cliGate);
  }

  // Auto-detect based on runner
  switch (runnerName) {
    case "pi-interactive":
      // PiInteractiveRunner will inject its own PiTuiGatePresenter
      // For now, fall back to Inquirer (PiTuiGatePresenter needs an ExtensionContext)
      // TODO: wire PiTuiGatePresenter through PiInteractiveRunner
      return new InquirerGatePresenter();
    default:
      return new InquirerGatePresenter();
  }
}
```

**Acceptance:** `--runner pi-sdk` uses Inquirer gates. `--runner pi-sdk --gate auto-approve` uses auto-approve. `--yes` always uses auto-approve regardless of runner.

---

## Task 4: Gate testing

**File:** `test/gates.test.ts`

| Test | What it verifies |
|------|-----------------|
| InquirerGate with no preview | Shows options, returns chosen answer |
| InquirerGate with preview file | Shows preview, then options |
| InquirerGate with feedback option | Shows feedback prompt, returns feedback |
| InquirerGate with abort option | Returns abort answer |
| AutoApproveGate | Returns first advance option |
| AutoApproveGate with no advance option | Throws |
| PiTuiGatePresenter (mock ctx) | Calls ctx.ui.select with correct options |

**Mock strategy for InquirerGatePresenter:**
Inquirer.js is hard to mock. Instead, use an environment variable (`PB_TEST=1`) to bypass Inquirer and use a test harness:

```typescript
// In constructor:
this.testAnswers = process.env.PB_TEST_GATE_ANSWERS
  ? JSON.parse(process.env.PB_TEST_GATE_ANSWERS)
  : undefined;

// In present():
if (this.testAnswers) {
  const answer = this.testAnswers.shift();
  if (!answer) throw new Error("No more test answers");
  return answer;
}
```

**Acceptance:** `PB_TEST=1 PB_TEST_GATE_ANSWERS='[{"label":"Approve","advance":true}]' npm test` — gate tests pass without requiring human interaction.

---

## Task 5: Web gate presenter (P2, deferred)

**Stub:** `src/gates/web-gate.ts`

For future web dashboard integration. POSTs gate to a web endpoint, waits for a response via polling or WebSocket. Not needed for v2.0.

---

## Prioritized task list

| Priority | Task | Effort | Depends on |
|----------|------|--------|------------|
| P0 | Task 1: Enhance InquirerGatePresenter | M | Inquirer.js |
| P1 | Task 2: Pi TUI Gate Presenter | M | pi SDK ExtensionContext type |
| P1 | Task 3: Gate presenter selection strategy | S | Task 2, runners |
| P1 | Task 4: Gate testing | M | Task 1 |
| P2 | Task 5: Web gate presenter | DEFERRED | — |

## Risks

1. **PiTuiGatePresenter needs an ExtensionContext.** `ctx.ui.select` only works inside an active pi extension session. If the orchestrator runs standalone (not inside a pi TUI), PiTuiGatePresenter will fail. The CLI factory must only create it when running inside `PiInteractiveRunner`.

2. **Inquirer.js pagination for large previews is basic.** If previews are regularly >100 lines, consider integrating with a proper pager (like `less`) or using Inquirer's `editor` type to open the file in the user's editor.

3. **Gate timeouts in CI.** If the gate times out with `timeoutAction: "approve"` but the step actually produced bad output, the flow will advance with bad output. CI flows should use `AutoApproveGate` directly, not `InquirerGatePresenter` with a timeout.
