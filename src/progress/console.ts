/**
 * Console Progress Reporter
 *
 * Logs flow progress to stdout with emoji indicators and step timing.
 * Swap for SlackProgress, WebhookProgress, or NoopProgress
 * without touching the orchestrator.
 */

import type { FlowProgress, AgentRunResult, GateInput } from "../orchestrator/ports.ts";

export class ConsoleProgress implements FlowProgress {
  private stepStartTimes = new Map<string, number>();
  private flowStartTime = 0;

  // ── Required lifecycle hooks ─────────────────────────────────

  onFlowStart(info: { flowId: string; feature: string; totalSteps: number }): void {
    this.flowStartTime = Date.now();
    console.log(`\n🚀 Flow: ${info.flowId} — ${info.feature}`);
    console.log(`   Steps: ${info.totalSteps}`);
  }

  onStepStart(step: { agent: string; index: number; attempt: number }): void {
    const retry = step.attempt > 1 ? ` (retry ${step.attempt})` : "";
    console.log(`\n▶ Step ${step.index + 1}: ${step.agent}${retry}`);
    this.stepStartTimes.set(step.agent + step.index, Date.now());
  }

  onStepEnd(step: { agent: string; index: number; result: AgentRunResult }): void {
    const key = step.agent + step.index;
    const start = this.stepStartTimes.get(key);
    const elapsed = start ? formatDuration(Date.now() - start) : "";
    this.stepStartTimes.delete(key);

    if (step.result.success) {
      const timing = elapsed ? ` (${elapsed})` : "";
      console.log(`  ✓ ${step.agent} completed${timing}`);
    } else {
      const errorMsg = step.result.error ?? "unknown";
      console.log(`  ✗ ${step.agent} failed (${elapsed})`);
      console.log(`    Error: ${errorMsg}`);
    }
  }

  onGate(gate: GateInput): void {
    console.log(`\n  🔒 Gate: ${gate.header}`);
  }

  onFlowComplete(): void {
    const total = formatDuration(Date.now() - this.flowStartTime);
    console.log(`\n✅ Flow complete (${total})`);
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
