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
  private stepList: Array<{ agent: string; status: "completed" | "running" | "pending" | "failed"; maxAttempts: number; currentAttempt: number; hasGate?: boolean; phase?: string }> = [];
  private flowHeader = "";
  /** Latest activity message from the running agent (cleared on step end). */
  private currentActivity = "";
  /** Phase label from flow_step_update (e.g. "implementing"). */
  private currentPhase = "";
  /** File path from flow_step_update (e.g. "src/services/auth.ts"). */
  private currentPath = "";
  /** Current tool from flow_step_update (e.g. "write"). */
  private currentTool = "";
  /** Status from flow_step_update (working/blocked/needs_attention). */
  private currentStatus: "working" | "blocked" | "needs_attention" | "" = "";

  // ── Tool + Subagent tracking ──────────────────────────────
  /** Current tool being executed (name). */
  private activeToolName = "";
  /** Short human-readable detail for the current tool (e.g. "src/auth.ts"). */
  private activeToolDetail = "";
  /** Active subagents tracked by name → start timestamp. */
  private activeSubagents = new Map<string, number>();
  /** Accumulated step timing info keyed by step index (shown under completed steps). */
  private stepEndInfo = new Map<number, { elapsed: string; attempts: number }>();
  /** Model info from the most recent step result (e.g. "DeepSeek V4 Pro (1.0M)"). */
  private currentModelInfo = "";
  /** Thinking level from the most recent step result (e.g. "high"). */
  private currentThinkingLevel = "";
  /** Reason for the most recent retry (shown in spinner line). Cleared on step start. */
  private lastRetryReason: string | null = null;
  /** Token usage from the most recent step result (for footer). */
  private lastTokenUsage: { input: number; output: number } | null = null;
  /** Expected output file paths keyed by step index (for completion table). */
  private stepOutputs = new Map<number, string[]>();
  /** Cached step labels for rebuilding the pipeline diagram each frame. */
  private cachedLabels: string[] = [];
  /** Inner box width for the pipeline diagram (max label length). */
  private boxMaxLen = 0;
  /** One-line execution plan rendered at flow start. */
  private executionPlan = "";
  /** Whether the renderHeader call is the initial flow-start render (for execution plan). */
  private initialRender = true;

  // ── Required lifecycle hooks ─────────────────────────────────

  onFlowStart(info: {
    flowId: string;
    feature: string;
    totalSteps: number;
    steps?: Array<{ agent: string; status: "completed" | "running" | "pending"; maxAttempts: number; requestApproval?: boolean; phase?: string; startedAt?: string; completedAt?: string; attempt?: number }>;
  }): void {
    this.flowStartTime = Date.now();
    this.flowHeader = `🚀 ${info.flowId} — ${info.feature}  (${info.totalSteps} steps)`;
    this.stepList = (info.steps ?? []).map(s => ({
      agent: s.agent,
      status: s.status,
      maxAttempts: s.maxAttempts,
      currentAttempt: s.attempt ?? 0,
      hasGate: s.requestApproval ?? false,
      phase: s.phase,
    }));

    // ── Pre-populate elapsed times for already-completed steps ─
    // Uses completed_at - started_at from workflow state (covers resume + fresh).
    this.stepEndInfo = new Map();
    for (let i = 0; i < this.stepList.length; i++) {
      const s = this.stepList[i];
      const stepData = info.steps?.[i];
      if (s.status === "completed" && stepData?.startedAt && stepData?.completedAt) {
        const start = new Date(stepData.startedAt).getTime();
        const end = new Date(stepData.completedAt).getTime();
        if (start > 0 && end > start) {
          this.stepEndInfo.set(i, {
            elapsed: formatDuration(end - start),
            attempts: stepData.attempt ?? 1,
          });
        }
      }
    }

    // ── Phase 2: Pipeline diagram (cache labels) ───────────
    this.cachedLabels = this.stepList.map(s => s.agent);
    this.boxMaxLen = Math.max(...this.cachedLabels.map(l => l.length)) + 4;

    // ── Phase 2: Execution plan preview ─────────────────────
    this.executionPlan = this.cachedLabels.length > 0
      ? `Execution Plan: ${this.cachedLabels.map((label, i) => {
          const gate = this.stepList[i]?.hasGate ? " 🔒" : "";
          return `${label}${gate}`;
        }).join(" → ")}`
      : "";

    // Print the execution plan as a transient header line
    if (this.executionPlan) {
      console.log(this.executionPlan + "\n");
    }

    this.renderHeader();
  }

  onStepStart(step: { agent: string; index: number; attempt: number; maxAttempts: number }): void {
    const retry = step.attempt > 1 ? ` (retry ${step.attempt})` : "";
    this.currentStepLabel = `${step.agent}${retry}`;
    this.currentStepStart = Date.now();
    this.currentActivity = "";
    this.currentPhase = "";
    this.currentPath = "";
    this.currentTool = "";
    this.currentStatus = "";
    this.activeToolName = "";
    this.activeToolDetail = "";
    this.activeSubagents.clear();
    this.stepStartTimes.set(step.agent + step.index, Date.now());

    // Update step status in the list and re-render
    if (this.stepList[step.index]) {
      this.stepList[step.index] = { ...this.stepList[step.index], status: "running", currentAttempt: step.attempt, maxAttempts: step.maxAttempts };
    }

    // Animated spinner — clears + re-renders every frame.
    // CRITICAL: build the entire output as a single string and write atomically.
    // Splitting process.stdout.write(clear) + console.log(content) into separate
    // writes causes the terminal to interleave them, producing duplicated output.
    let frame = 0;
    if (this.spinnerInterval) clearInterval(this.spinnerInterval);

    const renderFrame = () => {
      const spinner = SPINNER_FRAMES[frame % SPINNER_FRAMES.length];
      frame++;

      // Build entire output as a single string for atomic write.
      const lines: string[] = [
        this.flowHeader,
        "",
      ];

      // ── Shared frame data ────────────────────────────────
      const runningIdx = this.stepList.findIndex(s => s.status === 'running');
      const nowElapsed = formatDuration(Date.now() - this.currentStepStart);

      // ── Pipeline diagram (animated border on active step) ─
      if (this.cachedLabels.length > 0) {
        const pipelineLines = buildPipelineDiagram(
          this.cachedLabels,
          runningIdx >= 0 ? runningIdx : undefined,
          Math.floor(frame / 2),
          this.stepList.map(s => s.status),
        );
        for (const pline of pipelineLines) {
          lines.push(`  ${pline}`);
        }
        // Status row: build from current step states
        const statusSteps = this.stepList.map((s, i) => {
          let stepElapsed: string | undefined;
          let stepAttempts: number | undefined;
          if (s.status === 'completed') {
            const info = this.stepEndInfo.get(i);
            stepElapsed = info?.elapsed;
            stepAttempts = info?.attempts;
          } else if (s.status === 'running') {
            stepElapsed = nowElapsed;
          }
          return {
            status: s.status,
            elapsed: stepElapsed,
            attempts: stepAttempts,
            hasGate: s.hasGate,
            spinner: s.status === 'running' ? spinner : undefined,
          };
        });
        lines.push(`  ${buildStatusRow(statusSteps, this.boxMaxLen)}`);
        lines.push("");
      }

      // ── Running step detail line ─────────────────────────
      if (runningIdx >= 0) {
        const s = this.stepList[runningIdx];
        let spinnerLine = `  ${spinner} ${s.agent} (${s.currentAttempt}/${s.maxAttempts}) — ${nowElapsed}`;
        if (this.lastRetryReason) {
          spinnerLine += ` · ${this.lastRetryReason}`;
        }
        if (this.currentPhase) {
          spinnerLine += ` · ${this.currentPhase}`;
        }
        lines.push(spinnerLine);

        // ── Rich activity panel (tool + subagent) ──────────
        const panelLines = buildActivityPanel(
          this.activeToolName,
          this.activeToolDetail,
          this.activeSubagents,
          this.currentPhase,
          this.currentPath,
          this.currentActivity,
        );
        for (const pl of panelLines) {
          lines.push(`  ${pl}`);
        }
        // Fallback: simple activity line if no structured data
        if (panelLines.length === 0 && this.currentActivity) {
          const maxActivityLen = 100;
          const truncated = this.currentActivity.length > maxActivityLen
            ? this.currentActivity.slice(0, maxActivityLen - 1) + "…"
            : this.currentActivity;
          lines.push(`       ${truncated}`);
        }
      }

      // Footer
      if (this.currentModelInfo) {
        lines.push(buildFooter(this.currentModelInfo, this.currentThinkingLevel, this.lastTokenUsage));
      }

      process.stdout.write('\x1b[3J\x1b[H\x1b[2J' + lines.join("\n") + "\n");
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
    this.currentActivity = "";
    this.currentPhase = "";
    this.currentPath = "";
    this.currentTool = "";
    this.currentStatus = "";
    this.activeToolName = "";
    this.activeToolDetail = "";
    this.activeSubagents.clear();

    const key = step.agent + step.index;
    const start = this.stepStartTimes.get(key);
    const elapsed = start ? formatDuration(Date.now() - start) : "";
    this.stepStartTimes.delete(key);

    // Update step status (will be rendered by next onStepStart)
    if (this.stepList[step.index]) {
      this.stepList[step.index] = {
        ...this.stepList[step.index],
        status: step.result.success ? "completed" : "failed",
      };
    }

    if (step.result.success) {
      // Clear retry reason on success
      this.lastRetryReason = null;
      // Store elapsed time + attempt count for compact display under completed steps
      const attempts = this.stepList[step.index]?.currentAttempt ?? 1;
      this.stepEndInfo.set(step.index, { elapsed, attempts });
      // Capture model info for footer display
      if (step.result.modelInfo) {
        this.currentModelInfo = step.result.modelInfo;
      }
      if (step.result.thinkingLevel) {
        this.currentThinkingLevel = step.result.thinkingLevel;
      }
      // Capture token usage for footer display
      if (step.result.tokenUsage) {
        this.lastTokenUsage = step.result.tokenUsage;
      }
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
    const lines: string[] = [
      `\n✅ Flow complete — ${total}\n`,
    ];

    // Build completion table
    const rows = this.stepList.map((s, i) => {
      const info = this.stepEndInfo.get(i);
      return {
        index: i + 1,
        agent: s.agent,
        time: info?.elapsed ?? "—",
        attempts: info?.attempts ?? s.currentAttempt,
        status: s.status,
      };
    });

    if (rows.length > 0) {
      const statusIcon = (s: string) => s === "completed" ? "✅" : s === "failed" ? "❌" : "⬜";
      const padAgent = Math.max(...rows.map(r => r.agent.length), 5);
      const padTime = Math.max(...rows.map(r => r.time.length), 4);

      lines.push(`  Step  ${'Agent'.padEnd(padAgent)}  ${'Time'.padEnd(padTime)}  Attempts  Status`);
      lines.push(`  ${'────'.padEnd(4)}  ${'─────'.padEnd(padAgent)}  ${'────'.padEnd(padTime)}  ${'────────'.padEnd(8)}  ──────`);
      for (const row of rows) {
        const stepNum = String(row.index).padEnd(4);
        const agent = row.agent.padEnd(padAgent);
        const time = row.time.padEnd(padTime);
        const attempts = String(row.attempts).padEnd(8);
        lines.push(`  ${stepNum}  ${agent}  ${time}  ${attempts}  ${statusIcon(row.status)}`);
      }
    }

    console.log(lines.join("\n") + "\n");
  }

  onFlowAbandoned(): void {
    console.log("\n⏹ Flow abandoned by user");
  }

  onFlowBlocked(error: string): void {
    // Mark the current (failed) step for display
    const failedIndex = this.stepList.findIndex(s => s.status === "running");
    if (failedIndex >= 0) {
      this.stepList[failedIndex].status = "failed";
    }
    this.renderHeader();

    // Structured block summary table
    const failedStep = failedIndex >= 0 ? this.stepList[failedIndex] : null;
    const rows = this.stepList.map((s, i) => ({
      index: i + 1,
      agent: s.agent,
      attempts: s.currentAttempt,
      maxAttempts: s.maxAttempts,
      status: s.status,
      error: i === failedIndex ? error : undefined,
    }));

    if (rows.length > 0) {
      const statusIcon = (s: string) => s === "completed" ? "✅" : s === "failed" ? "❌" : "⬜";
      const padAgent = Math.max(...rows.map(r => r.agent.length), 5);
      const lines: string[] = [];
      if (failedStep) {
        lines.push(`\n❌ Flow blocked at Step ${failedIndex + 1}: ${failedStep.agent}\n`);
      }
      lines.push(`  Step  ${'Agent'.padEnd(padAgent)}  Attempts   Status`);
      lines.push(`  ${'────'.padEnd(4)}  ${'─────'.padEnd(padAgent)}  ${'────────'.padEnd(8)}  ──────`);
      for (const row of rows) {
        const stepNum = String(row.index).padEnd(4);
        const agent = row.agent.padEnd(padAgent);
        const attempts = `${row.attempts}/${row.maxAttempts}`.padEnd(8);
        lines.push(`  ${stepNum}  ${agent}  ${attempts}  ${statusIcon(row.status)}`);
      }
      lines.push(`\n   Last error: ${error}`);
      console.log(lines.join("\n"));
    } else {
      console.log(`\n   Error: ${error}`);
    }
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
    this.lastRetryReason = reasonLabel[step.reason];
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

  /** Called when the agent reports current activity during execution.
   *  The activity string and optional phase/path/tool/status are picked up
   *  by the next spinner frame render. */
  onStepActivity(_step: { agent: string; index: number; message: string; phase?: string; path?: string; status?: "working" | "blocked" | "needs_attention"; currentTool?: string; toolStarted?: { name: string; args?: Record<string, unknown> }; toolEnded?: { name: string }; subagentStarted?: { name: string }; subagentEnded?: { name: string } }): void {
    this.currentActivity = _step.message;
    this.currentPhase = _step.phase ?? "";
    this.currentPath = _step.path ?? "";
    this.currentStatus = _step.status ?? "";
    this.currentTool = _step.currentTool ?? "";

    // ── Tool tracking ────────────────────────────────────────
    if (_step.toolStarted) {
      this.activeToolName = _step.toolStarted.name;
      this.activeToolDetail = describeToolDetail(_step.toolStarted.name, _step.toolStarted.args);
    }
    if (_step.toolEnded) {
      // Don't clear — keep showing the last completed tool.
      // It gets replaced when the next tool starts (via toolStarted above).
      // Only clear subagent tools when the subagent ends (handled below).
    }

    // ── Subagent tracking ────────────────────────────────────
    if (_step.subagentStarted) {
      this.activeSubagents.set(_step.subagentStarted.name, Date.now());
    }
    if (_step.subagentEnded) {
      this.activeSubagents.delete(_step.subagentEnded.name);
    }
  }

  /** Clear + render header with pipeline diagram and status row (no spinner).
   *  Builds entire output as a single string for atomic write — see onStepStart
   *  for the rationale (split writes cause terminal interleaving / duplication). */
  private renderHeader(): void {
    const lines: string[] = [
      this.flowHeader,
      "",
    ];

    // ── Pipeline diagram + status row ──────────────────────
    if (this.cachedLabels.length > 0) {
      const pipelineLines = buildPipelineDiagram(
        this.cachedLabels,
        undefined,
        undefined,
        this.stepList.map(s => s.status),
      );
      for (const pline of pipelineLines) {
        lines.push(`  ${pline}`);
      }
      // Build status row from current step states (no spinner; static render)
      const statusSteps = this.stepList.map((s, i) => {
        let stepElapsed: string | undefined;
        let stepAttempts: number | undefined;
        if (s.status === 'completed') {
          const info = this.stepEndInfo.get(i);
          stepElapsed = info?.elapsed;
          stepAttempts = info?.attempts;
        }
        return {
          status: s.status,
          elapsed: stepElapsed,
          attempts: stepAttempts,
          hasGate: s.hasGate,
        };
      });
      lines.push(`  ${buildStatusRow(statusSteps, this.boxMaxLen)}`);
      lines.push("");
    }

    // Footer: model + thinking level + token usage
    if (this.currentModelInfo) {
      lines.push(buildFooter(this.currentModelInfo, this.currentThinkingLevel, this.lastTokenUsage));
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
  onStepActivity?(): void {}
  onStepRetry?(): void {}
  onOutputVerification?(): void {}
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Build an ASCII box-drawing pipeline diagram from step agent labels.
 * Box width adapts to the longest label; arrows connect adjacent boxes.
 * When activeIndex + frame are provided, the active box gets an animated
 * "marching dots" border effect.
 *
 *   ┌───────────┐   ┌──────┐   ┌───────────┐
 *   │ spec-write │ → │ plan │ → │ implement │
 *   └───────────┘   └──────┘   └───────────┘
 */
function buildPipelineDiagram(
  labels: string[],
  activeIndex?: number,
  frame?: number,
  statuses?: string[],
): string[] {
  if (labels.length === 0) return [];

  const maxLen = Math.max(...labels.map(l => l.length));
  const padded = labels.map(l => l.padEnd(maxLen));

  const topLine = padded.map((_, i) => {
    const prefix = i === 0 ? '' : '   ';
    const animate = i === activeIndex && frame !== undefined;
    const box = animate ? animatedBoxTop(maxLen, frame!) : normalBoxTop(maxLen);
    return prefix + (statuses?.[i] === 'completed' ? green(box) : box);
  }).join('');

  const midLine = padded.map((label, i) => {
    const prefix = i === 0 ? '' : ' → ';
    const animate = i === activeIndex && frame !== undefined;
    const box = animate ? animatedBoxMid(label, maxLen, frame!) : normalBoxMid(label, maxLen);
    return prefix + (statuses?.[i] === 'completed' ? green(box) : box);
  }).join('');

  const botLine = padded.map((_, i) => {
    const prefix = i === 0 ? '' : '   ';
    const animate = i === activeIndex && frame !== undefined;
    const box = animate ? animatedBoxBot(maxLen, frame!) : normalBoxBot(maxLen);
    return prefix + (statuses?.[i] === 'completed' ? green(box) : box);
  }).join('');

  return [topLine, midLine, botLine];
}

// ── ANSI helpers ──────────────────────────────────────────

function green(text: string): string {
  return `\x1b[32m${text}\x1b[0m`;
}

// ── Static box builders (all output maxLen + 4 chars wide) ─

function normalBoxTop(w: number): string {
  return `┌${'─'.repeat(w + 2)}┐`;
}
function normalBoxMid(label: string, w: number): string {
  return `│ ${label.padEnd(w)} │`;
}
function normalBoxBot(w: number): string {
  return `└${'─'.repeat(w + 2)}┘`;
}

// ── Animated box builders (marching dots on border) ───────

/** Whether position (x,y) within the box shows a dot at the given frame. */
function isDot(x: number, y: number, frame: number): boolean {
  return (x + y + frame) % 2 === 0;
}

/** Box total width = w+4.  Edge chars at x=0 and x=w+3. */
function animatedBoxTop(w: number, frame: number): string {
  let line = '';
  for (let x = 0; x <= w + 3; x++) {
    const normal = x === 0 ? '┌' : x === w + 3 ? '┐' : '─';
    line += isDot(x, 0, frame) ? '.' : normal;
  }
  return line;
}

function animatedBoxMid(label: string, w: number, frame: number): string {
  const left = isDot(0, 1, frame) ? '.' : '│';
  const right = isDot(w + 3, 1, frame) ? '.' : '│';
  return `${left} ${label.padEnd(w)} ${right}`;
}

function animatedBoxBot(w: number, frame: number): string {
  let line = '';
  for (let x = 0; x <= w + 3; x++) {
    const normal = x === 0 ? '└' : x === w + 3 ? '┘' : '─';
    line += isDot(x, 2, frame) ? '.' : normal;
  }
  return line;
}

/**
 * Build a status row centered under each pipeline box.
 * Completed: X.Xs   Failed: ❌ failed
 * Pending+gated: 🔒  Other: empty
 */
function buildStatusRow(
  steps: Array<{ status: string; elapsed?: string; attempts?: number; hasGate?: boolean }>,
  boxWidth: number,
): string {
  return steps.map((s, i) => {
    let text = '';
    if (s.status === 'completed') {
      text = `${s.elapsed || '0s'}`;
    } else if (s.status === 'failed') {
      text = '❌ failed';
    } else if (s.hasGate) {
      text = '🔒';
    }
    // Center text within column, then add box separator gap
    const totalPad = boxWidth - text.length;
    const leftPad = Math.max(0, Math.floor(totalPad / 2));
    const centered = ' '.repeat(leftPad) + text.padEnd(boxWidth - leftPad);
    const prefix = i === 0 ? '' : '   ';
    return prefix + centered;
  }).join('');
}

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


/** Format token count to human-readable (e.g. 12500 → "12.5k"). */
function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return String(tokens);
}

/** Build the footer line showing model, thinking level, and optional token usage. */
function buildFooter(modelInfo: string, thinkingLevel: string, tokenUsage?: { input: number; output: number } | null): string {
  const model = `[${modelInfo}]`;
  let line = `\n  ${model}`;
  if (thinkingLevel) line += ` ${thinkingLevel}`;
  if (tokenUsage) {
    const total = tokenUsage.input + tokenUsage.output;
    const inStr = formatTokens(tokenUsage.input);
    const outStr = formatTokens(tokenUsage.output);
    const totalStr = formatTokens(total);
    line += ` · ${totalStr} tokens (${inStr} in · ${outStr} out)`;
  }
  return line;
}

// ============================================================================
// Activity Panel — tool + subagent display
// ============================================================================

/** Terminal width for panel sizing (fallback to 80 if stdout not available). */
function termWidth(): number {
  return process.stdout.columns ?? 80;
}

/** Icons for common tool names. */
const TOOL_ICONS: Record<string, string> = {
  read: "📖",
  write: "📝",
  edit: "✏️ ",
  bash: "⚡",
  grep: "🔎",
  find: "🔍",
  ls: "📂",
  web_search: "🌐",
  code_search: "💻",
  fetch_content: "📥",
  get_search_content: "📄",
  subagent: "🤖",
  ask_user_question: "❓",
  flow_step_update: "📊",
  mcp: "🔌",
};

/**
 * Extract a human-readable detail from tool arguments (file path, command, etc.).
 * Returns an empty string if no meaningful detail can be extracted.
 */
function describeToolDetail(toolName: string, args?: Record<string, unknown>): string {
  if (!args || typeof args !== "object") return "";

  switch (toolName) {
    case "read": {
      const p = typeof args.path === "string" ? args.path : "";
      return p ? basename(p) : "";
    }
    case "write": {
      const p = typeof args.path === "string" ? args.path : "";
      return p ? basename(p) : "";
    }
    case "edit": {
      const p = typeof args.path === "string" ? args.path : "";
      const edits = Array.isArray(args.edits) ? args.edits.length : 0;
      const base = p ? basename(p) : "";
      return edits > 0 ? `${base} (${edits} edit${edits !== 1 ? "s" : ""})` : base;
    }
    case "bash": {
      const cmd = typeof args.command === "string" ? args.command : "";
      if (!cmd) return "";
      // Truncate long commands
      return cmd.length > 60 ? cmd.slice(0, 57) + "..." : cmd;
    }
    case "grep": {
      const pattern = typeof args.pattern === "string" ? args.pattern : "";
      const gp = typeof args.path === "string" ? ` in ${basename(args.path)}` : "";
      return pattern ? `"${pattern}"${gp}` : "";
    }
    case "find": {
      const pattern = typeof args.pattern === "string" ? args.pattern : "";
      return pattern || "";
    }
    case "ls": {
      const p = typeof args.path === "string" ? args.path : ".";
      return p !== "." ? basename(p) : "";
    }
    case "subagent": {
      const agent = typeof args.agent === "string" ? args.agent : "";
      return agent || "";
    }
    case "web_search": {
      if (args.queries && Array.isArray(args.queries)) return `${args.queries.length} queries`;
      const q = typeof args.query === "string" ? args.query : "";
      return q ? (q.length > 50 ? q.slice(0, 47) + "..." : q) : "";
    }
    case "fetch_content": {
      if (args.urls && Array.isArray(args.urls)) return `${args.urls.length} urls`;
      const u = typeof args.url === "string" ? args.url : "";
      return u ? (u.length > 50 ? u.slice(0, 47) + "..." : u) : "";
    }
    case "ask_user_question": {
      const questions = Array.isArray(args.questions) ? args.questions.length : 0;
      return questions > 0 ? `${questions} question${questions !== 1 ? "s" : ""}` : "";
    }
    case "code_search": {
      const q = typeof args.query === "string" ? args.query : "";
      return q ? (q.length > 60 ? q.slice(0, 57) + "..." : q) : "";
    }
    default:
      return "";
  }
}

/** Extract the filename from a path. */
function basename(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] ?? p;
}

/**
 * Build a bordered activity panel showing the agent's current tool + active subagents.
 * Only renders when there's something to show (tool or subagents).
 * Returns empty array when nothing is active.
 */
function buildActivityPanel(
  toolName: string,
  toolDetail: string,
  activeSubagents: Map<string, number>,
  phase: string,
  path: string,
  activity: string,
): string[] {
  const rows: string[] = [];

  // ── Current tool (persists after completion, replaced by next tool) ─
  // Skip when the tool IS "subagent" — activeSubagents already shows it with elapsed.
  if (toolName && toolName !== "subagent") {
    const icon = TOOL_ICONS[toolName] ?? "🔧";
    const label = toolName === "flow_step_update" ? "phase update" : toolName;
    let line = `${icon} ${label}`;
    if (toolDetail) line += `: ${toolDetail}`;
    rows.push(line);
  }

  // ── Active subagents ─────────────────────────────────────
  const now = Date.now();
  activeSubagents.forEach((startTime, name) => {
    const elapsed = formatDuration(now - startTime);
    rows.push(`🤖 subagent: ${name} (${elapsed})`);
  });

  // ── Subagent progress (activity messages while a subagent is running) ─
  // Filter out generic tool-start/end messages — show only meaningful text.
  if (activeSubagents.size > 0 && activity) {
    const isGeneric = /^(using |done )/.test(activity);
    if (!isGeneric && activity.length > 0) {
      const truncated = activity.length > 80
        ? activity.slice(0, 77) + "..."
        : activity;
      rows.push(`   ↳ ${truncated}`);
    }
  }

  // ── Phase + path context ─────────────────────────────────
  if (phase && path) {
    rows.push(`📍 ${phase} · ${path}`);
  } else if (path) {
    rows.push(`📍 ${path}`);
  }

  if (rows.length === 0) return [];

  // ── Enclose in a single-line-width box ───────────────────
  // Panel width: longest content + padding, capped at terminal width - 2 indentation
  const maxContentLen = rows.reduce((max, r) => Math.max(max, visibleLen(r)), 0);
  const boxInner = Math.min(maxContentLen + 2, termWidth() - 4);

  const result: string[] = [];
  const topBar = `┌${'─'.repeat(boxInner)}┐`;
  result.push(topBar);

  for (const row of rows) {
    const truncated = truncateVisible(row, boxInner - 1);
    result.push(`│ ${truncated}${' '.repeat(Math.max(0, boxInner - visibleLen(row) - 1))}│`);
  }

  const botBar = `└${'─'.repeat(boxInner)}┘`;
  result.push(botBar);

  return result;
}

/** Get visible length of a string, stripping ANSI escape codes and accounting for
 *  wide characters (emoji, CJK) that occupy 2 terminal cells. */
function visibleLen(s: string): number {
  // Strip ANSI escape sequences: \x1b[...m
  const clean = s.replace(/\x1b\[[0-9;]*m/g, "");
  let len = 0;
  for (const ch of clean) {
    const cp = ch.codePointAt(0) ?? 0;
    // East Asian Wide + emoji-presentation characters take 2 cells
    // This is a heuristic — covers emoji (U+1F300-U+1FAFF), CJK, and common symbols
    if (
      cp > 0x1F000 ||                // Emoji & Symbols Extended
      (cp >= 0x1F300 && cp <= 0x1FAFF) || // Emoji & pictographs
      (cp >= 0x2600 && cp <= 0x27BF) ||   // Misc symbols (includes some emoji)
      (cp >= 0x2300 && cp <= 0x23FF) ||   // Misc technical (includes some emoji)
      (cp >= 0x2E80 && cp <= 0xA4CF)      // CJK
    ) {
      len += 2;
    } else {
      len += 1;
    }
  }
  return len;
}

/** Truncate a string to a visible length, preserving ANSI codes at the end for reset.
 *  Counts wide characters (emoji, CJK) as 2 cells. */
function truncateVisible(s: string, maxLen: number): string {
  let visible = 0;
  let result = "";
  let i = 0;
  while (i < s.length && visible < maxLen) {
    if (s[i] === "\x1b" && s[i + 1] === "[") {
      // Consume the entire ANSI sequence
      const end = s.indexOf("m", i);
      if (end !== -1) {
        result += s.slice(i, end + 1);
        i = end + 1;
        continue;
      }
    }
    // Check if this character takes 2 cells
    const cp = s.codePointAt(i) ?? s.charCodeAt(i);
    const charWidth = (
      cp > 0x1F000 ||
      (cp >= 0x1F300 && cp <= 0x1FAFF) ||
      (cp >= 0x2600 && cp <= 0x27BF) ||
      (cp >= 0x2300 && cp <= 0x23FF) ||
      (cp >= 0x2E80 && cp <= 0xA4CF)
    ) ? 2 : 1;
    if (visible + charWidth > maxLen) break;
    // Handle surrogate pairs
    const charLen = cp > 0xFFFF ? 2 : 1;
    result += s.slice(i, i + charLen);
    visible += charWidth;
    i += charLen;
    if (charLen === 2 && s[i - 1] === undefined) i = s.length; // safety
  }
  return result;
}
