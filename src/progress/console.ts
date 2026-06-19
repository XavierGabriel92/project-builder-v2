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

  // ── Required lifecycle hooks ─────────────────────────────────

  onFlowStart(info: { flowId: string; feature: string; totalSteps: number }): void {
    this.flowStartTime = Date.now();
    console.clear();
    console.log(`🚀 ${info.flowId} — ${info.feature}  (${info.totalSteps} steps)\n`);
  }

  onStepStart(step: { agent: string; index: number; attempt: number }): void {
    const retry = step.attempt > 1 ? ` (retry ${step.attempt})` : "";
    this.currentStepLabel = `Step ${step.index + 1}: ${step.agent}${retry}`;
    this.currentStepStart = Date.now();
    this.stepStartTimes.set(step.agent + step.index, Date.now());

    // Start spinner animation
    let frame = 0;
    this.spinnerInterval = setInterval(() => {
      const elapsed = formatDuration(Date.now() - this.currentStepStart);
      process.stdout.write(`\r  ${SPINNER_FRAMES[frame]} ${this.currentStepLabel}  (${elapsed})`);
      frame = (frame + 1) % SPINNER_FRAMES.length;
    }, 80);
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

    if (step.result.success) {
      process.stdout.write(`\r  ✓ ${this.currentStepLabel}  (${elapsed})\n`);
    } else {
      process.stdout.write(`\r  ✗ ${this.currentStepLabel}  (${elapsed})\n`);
      const errorMsg = step.result.error ?? "unknown";
      console.log(`    Error: ${errorMsg}`);
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
