/**
 * Console Progress Reporter
 *
 * Clean step-by-step UI with spinner animation during agent execution.
 * No raw agent output — just step name, elapsed time, and status.
 */

import type { FlowProgress, AgentRunResult, GateInput } from "../orchestrator/ports.ts";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export class ConsoleProgress implements FlowProgress {
  private stepStartTimes = new Map<string, number>();
  private flowStartTime = 0;
  private spinnerInterval: ReturnType<typeof setInterval> | null = null;
  private currentStepLabel = "";
  private currentStepStart = 0;
  private stepList: Array<{ agent: string; status: "completed" | "running" | "pending" }> = [];
  private flowHeader = "";
  private stepsRendered = false;

  // ── Required lifecycle hooks ─────────────────────────────────

  onFlowStart(info: {
    flowId: string;
    feature: string;
    totalSteps: number;
    steps?: Array<{ agent: string; status: "completed" | "running" | "pending" }>;
  }): void {
    this.flowStartTime = Date.now();
    this.flowHeader = `🚀 ${info.flowId} — ${info.feature}  (${info.totalSteps} steps)`;
    this.stepList = info.steps ?? [];
    this.renderHeader();
  }

  onStepStart(step: { agent: string; index: number; attempt: number }): void {
    const retry = step.attempt > 1 ? ` (retry ${step.attempt})` : "";
    this.currentStepLabel = `${step.agent}${retry}`;
    this.currentStepStart = Date.now();
    this.stepStartTimes.set(step.agent + step.index, Date.now());

    // Update step status in the list and re-render
    if (this.stepList[step.index]) {
      this.stepList[step.index] = { ...this.stepList[step.index], status: "running" };
    }

    // Animated spinner — clears + re-renders the full step list every frame
    // so the running step appears inline with spinner + elapsed time.
    // CRITICAL: build the entire output as a single string and write atomically.
    // Splitting process.stdout.write(clear) + console.log(content) into separate
    // writes causes the terminal to interleave them, producing duplicated output.
    let frame = 0;
    if (this.spinnerInterval) clearInterval(this.spinnerInterval);
    const renderFrame = () => {
      const elapsed = formatDuration(Date.now() - this.currentStepStart);
      const lines: string[] = [
        this.flowHeader,
        "",
      ];
      for (const s of this.stepList) {
        if (s.status === "completed") {
          lines.push(`  ✓ ${s.agent}`);
        } else if (s.status === "running") {
          lines.push(`  ${SPINNER_FRAMES[frame]} ${s.agent}  (${elapsed})`);
        } else {
          lines.push(`  ○ ${s.agent}`);
        }
      }
      process.stdout.write('\x1b[3J\x1b[H\x1b[2J' + lines.join("\n") + "\n");
      frame = (frame + 1) % SPINNER_FRAMES.length;
    };
    renderFrame(); // render immediately
    this.spinnerInterval = setInterval(renderFrame, 100);
  }

  onStepEnd(step: { agent: string; index: number; result: AgentRunResult }): void {
    // Stop spinner
    if (this.spinnerInterval) {
      clearInterval(this.spinnerInterval);
      this.spinnerInterval = null;
    }

    const key = step.agent + step.index;
    const start = this.stepStartTimes.get(key);
    const elapsed = start ? formatDuration(Date.now() - start) : "";
    this.stepStartTimes.delete(key);

    // Update step status (will be rendered by next onStepStart)
    if (this.stepList[step.index]) {
      this.stepList[step.index] = {
        ...this.stepList[step.index],
        status: step.result.success ? "completed" : "pending",
      };
    }

    if (step.result.success) {
      // Render final static state with the step marked completed
      this.renderHeader();
    } else {
      this.renderHeader();
      console.log(`    Error: ${step.result.error ?? "unknown"}`);
    }
  }

  onGate(gate: GateInput): void {
    console.log(`\n  🔒 Gate: ${gate.header}`);
  }

  onFlowComplete(): void {
    const total = formatDuration(Date.now() - this.flowStartTime);
    console.log(`\n✅ Done (${total})\n`);
  }

  onFlowAbandoned(): void {
    console.log("\n⏹ Flow abandoned by user");
  }

  onFlowBlocked(error: string): void {
    console.log(`\n❌ Flow blocked`);
    console.log(`   ${error}`);
  }

  // ── Optional hooks ───────────────────────────────────────────

  onStepRetry?(step: {
    agent: string;
    index: number;
    attempt: number;
    reason: "error" | "gate_rejected" | "missing_outputs";
  }): void {
    const reasonLabel: Record<typeof step.reason, string> = {
      error: "agent error",
      gate_rejected: "gate rejected",
      missing_outputs: "missing outputs",
    };
    console.log(
      `  ↻ Retrying ${step.agent} (attempt ${step.attempt}): ${reasonLabel[step.reason]}`,
    );
  }

  onOutputVerification?(result: {
    allExist: boolean;
    missing: string[];
    existing: string[];
  }): void {
    if (result.allExist) {
      console.log(`  ✓ Outputs verified (${result.existing.length} files)`);
    } else {
      console.log(`  ⚠ Missing outputs: ${result.missing.join(", ")}`);
    }
  }

  // ── Rendering ──────────────────────────────────────────────

  /** Clear + render header + static step list (no spinner).
   *  Builds entire output as a single string for atomic write — see onStepStart
   *  for the rationale (split writes cause terminal interleaving / duplication). */
  private renderHeader(): void {
    const lines: string[] = [
      this.flowHeader,
      "",
    ];
    for (const s of this.stepList) {
      if (s.status === "completed") {
        lines.push(`  ✓ ${s.agent}`);
      } else if (s.status === "running") {
        lines.push(`  ⠿ ${s.agent}`);
      } else {
        lines.push(`  ○ ${s.agent}`);
      }
    }
    process.stdout.write('\x1b[3J\x1b[H\x1b[2J' + lines.join("\n") + "\n");
  }
}

/**
 * No-op progress reporter. Silently swallows all progress events.
 * Implements all required and optional FlowProgress methods.
 */
export class NoopProgress implements FlowProgress {
  onFlowStart(): void {}
  onStepStart(): void {}
  onStepEnd(): void {}
  onGate(): void {}
  onFlowComplete(): void {}
  onFlowAbandoned(): void {}
  onFlowBlocked(): void {}
  onStepRetry?(): void {}
  onOutputVerification?(): void {}
}

// ============================================================================
// Helpers
// ============================================================================

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSecs = Math.round(seconds % 60);
  return remainingSecs > 0
    ? `${minutes}m ${remainingSecs}s`
    : `${minutes}m`;
}
