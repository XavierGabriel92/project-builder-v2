# Implementation Plan — Verifiers & Progress Layers

## Context

Two layers of Project Builder v2 that live at the boundary between the orchestrator and the outside world:

- **OutputVerifier** — Called after agent completion, before gate presentation. Checks that declared output files exist. The orchestrator blocks or retries when outputs are missing (in strict mode).
- **FlowProgress** — Called at lifecycle hooks (step start, step end, gate, flow complete, flow blocked). Pure observability — return values are ignored.

Both are `interface`-based in `ports.ts`. The orchestrator calls them but never imports concrete implementations.

---

## PART 1: VERIFIERS

### 1.1 Current State

`FilesystemVerifier` in `src/verifiers/filesystem.ts`:

```typescript
verify(expectedOutputs: string[], cwd: string) {
  for (const output of expectedOutputs) {
    const resolved = output.startsWith("/") ? output : `${cwd}/${output}`;
    if (fs.existsSync(resolved)) { existing.push(output); }
    else { missing.push(output); }
  }
  return { allExist, missing, existing };
}
```

**How the orchestrator calls it** (from `orchestrator.ts:executeStep`):

```typescript
const outputs = agent.manifest.outputs ?? [];
const verification = outputVerifier.verify(
  outputs.map(o => path.join(workflowDir, o)),  // already resolved to absolute
  workflowDir,                                    // cwd = workflow dir
);
```

Key observation: the orchestrator **already resolves paths** via `path.join(workflowDir, o)` before calling `verify()`. So the `cwd` parameter is actually the workflow directory, and paths are already absolute. The verifier's internal path resolution is redundant for the orchestrator use case — but the interface should still handle relative paths for standalone use.

### 1.2 Tasks

#### Task 1: Harden FilesystemVerifier

**File:** `src/verifiers/filesystem.ts`

**What to change:**

1. **Normalize `cwd` usage.** The `cwd` parameter receives the workflow directory. Paths may already be absolute (from the orchestrator's `path.join`). Change the resolution logic to:

   ```
   resolved = path.isAbsolute(output) ? output : path.resolve(cwd, output)
   ```

   This is more robust than a `startsWith("/")` check (fails on Windows).

2. **Symlink handling.** `fs.existsSync` follows symlinks and returns `true` for broken symlinks only if the target exists. Test and document behavior:
   - Valid symlink → target exists → `true` (correct, file is accessible)
   - Broken symlink (dangling) → `false` (file not accessible — should be in `missing`, which is what `existsSync` returns)
   - No change needed, but add a test case to prove it.

3. **Permission errors.** If a file exists but is unreadable (EACCES on stat), `fs.existsSync` returns `false`. This is indistinguishable from "file does not exist." We need to distinguish these cases:
   - Add an `fs.accessSync(resolved, fs.constants.R_OK)` call inside a try/catch when `existsSync` returns true, to confirm readability.
   - If read fails with EACCES, add to `missing` with a descriptive message like `"path/to/file (permission denied)"`.
   - If read fails with any other error, add to `missing` with the error message.

4. **Glob pattern support.** Agent manifests declare outputs like `["spec.md", "plan.md"]`. But some agents might want to declare `["*.md", "reports/*.json"]`. The current code does string comparison — it won't expand globs.
   - Add optional glob support behind a constructor flag: `new FilesystemVerifier({ expandGlobs: true })`
   - Use `glob` npm package (already a common dep) or `node:fs` + `node:path` with a simple minimatch.
   - When `expandGlobs: true`:
     ```
     for each output pattern:
       if contains glob chars (*, ?, [...], {,}):
         expand → list of matching files
         if no matches → missing.push(pattern + " (no files matched)")
         else → check each match exists
       else:
         normal exists check
     ```
   - Default: `expandGlobs: false` (backward compatible).

5. **Return richer errors.** The return type is `{ allExist, missing, existing }`. Consider adding `errors: string[]` for non-existence issues (permission denied, symlink loop, etc.).

6. **Concurrency.** For many outputs (>50), use `Promise.all` with `fs.promises` for parallel stat calls.

#### Task 2: Ensure orchestrator integration is correct

**File:** `src/orchestrator/orchestrator.ts`

**What to check (not change necessarily, but verify):**

1. The orchestrator passes `workflowDir` as `cwd`. The verifier resolves paths relative to `cwd`. This is correct when paths are already absolute (`path.join(workflowDir, o)` produces an absolute path). Add a test to prove the round-trip: orchestrator calls verifier → verifier finds file.

2. Non-strict mode: when `strictOutputs` is `false` on the flow, the orchestrator should still call the verifier but only log warnings, not block. Currently the orchestrator skips verification entirely when `!strictOutputs`. **This is a gap** — even in non-strict mode, we want to know which outputs are missing. The orchestrator should always call `outputVerifier.verify()` but only block in strict mode. The `warnings` should be passed to `FlowProgress`.

#### Task 3: Future verifiers — GitDiffVerifier

**File:** `src/verifiers/git-diff.ts` (new, only if needed soon — otherwise deferred)

**Design:**

```typescript
export class GitDiffVerifier implements OutputVerifier {
  readonly name = "git-diff";
  
  verify(expectedOutputs: string[], cwd: string) {
    // Run `git diff --name-only` in cwd
    // For each expected output, check if it appears in the diff
    // If in diff → existing; if not → missing (agent didn't modify it)
    //
    // Important: this verifies CHANGES, not existence. A pre-existing
    // file that wasn't modified won't appear in git diff.
    // This makes sense for "implement" steps where the agent should
    // MODIFY files, not just create them.
  }
}
```

**When to use:** For `implement` step where the agent is expected to modify existing source files, not just create new ones. The agent manifest's `outputs` would list source files that should appear in `git diff`.

**Status:** Deferred. Not needed for MVP. Keep the design note.

#### Task 4: Future verifiers — ContentVerifier

**Design sketch (deferred):**

```typescript
// Verifies file contents match expectations, not just existence.
// Could check: contains a regex pattern, is valid JSON, matches a schema, 
// has expected line count, etc.
export class ContentVerifier implements OutputVerifier {
  // ...
}
```

**Status:** Deferred. Not needed for MVP.

#### Task 5: Future verifiers — CompositeVerifier

**Design sketch (deferred):**

```typescript
// Chains multiple verifiers. All must pass for allExist: true.
// Useful: FilesystemVerifier + GitDiffVerifier → file must exist AND appear in diff.
export class CompositeVerifier implements OutputVerifier {
  constructor(private verifiers: OutputVerifier[]) {}
  verify(outputs, cwd) {
    // Run all, combine results. allExist only if every verifier passes.
  }
}
```

**Status:** Deferred. Not needed for MVP.

#### Task 6: Testing strategy

**File:** `test/verifiers/filesystem.test.ts` (new)

**Test cases:**

| # | Test | Expected |
|---|------|----------|
| 1 | All files exist | `allExist: true`, `missing: []`, `existing: [all]` |
| 2 | Some files missing | `allExist: false`, `missing` contains missing paths |
| 3 | All files missing | `allExist: false`, `existing: []` |
| 4 | Empty outputs array | `allExist: true`, both arrays empty |
| 5 | Absolute path input | Works without double-resolving (cwd ignored for absolute paths) |
| 6 | Relative path input | Resolved correctly against cwd |
| 7 | Valid symlink to existing file | `existing` contains it |
| 8 | Broken symlink (dangling) | `missing` contains it |
| 9 | File exists but EACCES (unreadable) | `missing` contains it with error detail |
| 10 | Glob pattern with matches | `existing` contains matched files |
| 11 | Glob pattern with no matches | `missing` contains pattern with "no files matched" |
| 12 | Mixed glob and literal patterns | Both resolved correctly |
| 13 | Path with `..` traversal | Resolved and checked correctly (no escape from cwd) |
| 14 | Directory passed as output (not a file) | Documented behavior: `existsSync` returns true for dirs. Should we treat dirs as valid outputs? **Decision: yes** — some agents produce directories. |
| 15 | Concurrent verification of 100+ files | Completes in reasonable time, no failures |

**Test setup:** Use `fs.mkdirSync` / `fs.writeFileSync` to create test fixtures in a temp directory. Use `fs.symlinkSync` for symlink tests. Use `os.tmpdir()` and clean up after each test.

---

## PART 2: PROGRESS

### 2.1 Current State

`ConsoleProgress` in `src/progress/console.ts`:

```typescript
export class ConsoleProgress implements FlowProgress {
  onStepStart(step) { console.log(`\n▶ Step ${step.index + 1}: ${step.agent}${retry}`); }
  onStepEnd(step) { console.log(✓/✗ with result); }
  onGate(gate) { console.log(`\n  🔒 Gate: ${gate.header}`); }
  onFlowComplete() { console.log("\n✅ Flow complete"); }
  onFlowBlocked(error) { console.log(`\n❌ Flow blocked: ${error}`); }
}
```

`NoopProgress` — empty implementation.

### 2.2 Interface Design Review

The `FlowProgress` interface in `ports.ts`:

```typescript
export interface FlowProgress {
  onStepStart(step: { agent: string; index: number; attempt: number }): void;
  onStepEnd(step: { agent: string; index: number; result: AgentRunResult }): void;
  onGate(gate: GateInput): void;
  onFlowComplete(): void;
  onFlowBlocked(error: string): void;
}
```

**What's missing:**

| Missing event | Why needed | Priority |
|---------------|-----------|----------|
| `onFlowStart(flow, feature)` | Observability: when did the run begin? Slack reporter needs this to post an initial message. Console reporter could show flow name + feature name header. | High |
| `onStepRetry(step, attempt, reason)` | Distinguish retries from fresh starts. Currently `onStepStart` with `attempt > 1` implies retry, but no explicit "why" (error? gate rejection? missing outputs?). | Medium |
| `onOutputVerification(result)` | Show what the verifier found — which files exist, which are missing. Currently hidden. | Low |
| `onStepSkipped(step, reason)` | If a step is skipped (e.g., already completed on resume), report it. | Low |
| `onFlowAbandoned()` | Explicit abandon event (currently reported as `onFlowBlocked`? Actually not — `abandoned` returns silently). This is a gap — `runFlow` returns `{ status: "abandoned" }` but never calls progress. | High |

**Recommendation:** Add `onFlowStart`, `onFlowAbandoned`, and `onStepRetry` to the interface. Add `onOutputVerification` and `onStepSkipped` as optional (default no-op) via a base class or `?` methods on the interface.

### 2.3 Tasks

#### Task 7: Expand the FlowProgress interface

**File:** `src/orchestrator/ports.ts`

**Changes:**

```typescript
export interface FlowProgress {
  // ── Existing ──
  onStepStart(step: { agent: string; index: number; attempt: number }): void;
  onStepEnd(step: { agent: string; index: number; result: AgentRunResult }): void;
  onGate(gate: GateInput): void;
  onFlowComplete(): void;
  onFlowBlocked(error: string): void;

  // ── New (required) ──
  /** Called once at the start of the flow run. */
  onFlowStart(info: { flowId: string; feature: string; totalSteps: number }): void;
  /** Called when the user abandons the workflow via a gate abort option. */
  onFlowAbandoned(): void;

  // ── New (optional via ?) ──
  /** Called when a step is about to retry (error, gate rejection, or missing outputs). */
  onStepRetry?(step: { agent: string; index: number; attempt: number; reason: "error" | "gate_rejected" | "missing_outputs" }): void;
  /** Called after output verification, showing what was found. */
  onOutputVerification?(result: { allExist: boolean; missing: string[]; existing: string[] }): void;
}
```

**Impact on orchestrator:** The orchestrator must now call `onFlowStart` at the top of `runFlow`, `onFlowAbandoned` when `status === "abandoned"`, and `onStepRetry` inside the retry loop (with proper reason).

#### Task 8: Update orchestrator to call new progress hooks

**File:** `src/orchestrator/orchestrator.ts`

**Changes:**

1. At the top of `runFlow`, after writing initial state:
   ```typescript
   progress?.onFlowStart({ flowId: flow.id, feature: featureName, totalSteps: flow.steps.length });
   ```

2. In the retry logic (inside `executeStep`), before `continue`:
   ```typescript
   progress?.onStepRetry?.({ agent: flowStep.agent, index: state.current_step_index, attempt, reason: "error" });
   // ... or "gate_rejected" or "missing_outputs"
   ```

3. After output verification, whether strict or not:
   ```typescript
   progress?.onOutputVerification?.(verification);
   ```

4. When status is `"abandoned"`:
   ```typescript
   progress?.onFlowAbandoned();
   ```

5. Update `NoopProgress` to implement the new required methods.

#### Task 9: Enhance ConsoleProgress

**File:** `src/progress/console.ts`

**Changes:**

1. **Colors.** Use `chalk` or `picocolors` (zero-dep alternative) for:
   - Green for success (✓)
   - Red for errors (✗)
   - Yellow for warnings / retries
   - Cyan for flow/gate headers
   - Gray for secondary info (timing, attempt count)
   
   Install: `picocolors` (preferred — smaller, no deps) or `chalk`.

2. **Structured output format.** Add a constructor option:
   ```typescript
   new ConsoleProgress({ format: "pretty" | "json" | "minimal" })
   ```
   - `pretty` (default): colored, emoji, human-readable
   - `json`: one JSON object per event on its own line (machine-parseable)
   - `minimal`: one-liners only, no emoji

3. **Step timing.** Track step start times, report duration on `onStepEnd`:
   ```
   ✓ spec-write completed (42.3s)
   ```

4. **Error formatting.** When `onStepEnd` receives a failed result:
   - Show the error message in red
   - If `result.messages` is available, show the last assistant error
   - For `onFlowBlocked`: show which step blocked, the error, and whether retries remain

5. **New methods implementation:**
   - `onFlowStart`: show flow name, feature name, total steps
   - `onFlowAbandoned`: show abandon message
   - `onStepRetry`: show retry reason and attempt count
   - `onOutputVerification`: show missing files list in yellow

6. **Spinner/progress indicator (stretch goal).** Use `ora` or a simple spinner during agent execution. The spinner runs on `onStepStart` and stops on `onStepEnd`. This requires the progress reporter to know when the step "starts" (agent begins) vs "ends" (agent finishes) — which it already does.

#### Task 10: Future progress reporters — SlackProgress

**File:** `src/progress/slack.ts` (new, deferred)

**Design:**

```typescript
export class SlackProgress implements FlowProgress {
  constructor(private webhookUrl: string) {}

  // Posts a message on flow start, updates it with
  // thread replies for each step/gate/block.
  // Uses Slack Incoming Webhook API.
  // Stores messageTs returned by Slack to update the same message.
}
```

**Status:** Deferred. Not needed for MVP. The interface is ready for it — just implement the methods.

#### Task 11: Future progress reporters — FileProgress

**File:** `src/progress/file.ts` (new, deferred)

**Design:**

```typescript
export class FileProgress implements FlowProgress {
  constructor(private logPath: string) {}

  // Appends one JSON line per event to logPath.
  // Useful for post-run analysis, CI artifacts, audit.
  // Format matches ConsoleProgress "json" format.
}
```

**Status:** Deferred.

#### Task 12: Future progress reporters — WebSocketProgress

**File:** `src/progress/websocket.ts` (new, deferred)

**Design:**

```typescript
export class WebSocketProgress implements FlowProgress {
  constructor(private wsUrl: string) {}

  // Sends typed JSON messages over WebSocket.
  // Format: { type: "step_start" | "step_end" | "gate" | "flow_complete" | "flow_blocked", ... }
  // For real-time dashboards.
}
```

**Status:** Deferred.

#### Task 13: Testing strategy

**File:** `test/progress/console.test.ts` (new)

**Test cases:**

| # | Test | Expected |
|---|------|----------|
| 1 | `pretty` format output contains emoji and step names | Console output includes `▶`, `✓`, agent name |
| 2 | `json` format output is valid JSON per line | `JSON.parse` each line succeeds |
| 3 | `minimal` format has no emoji | Output contains no `▶ ✓ ✗ ✅ ❌ 🔒` chars |
| 4 | Step timing appears in output | Duration like `(42.3s)` in output |
| 5 | Retry step shows attempt count | `(retry 2)` in output |
| 6 | New `onFlowStart` outputs flow info | Flow ID and feature name visible |
| 7 | New `onStepRetry` shows retry reason | "retrying: error", "retrying: gate_rejected", "retrying: missing_outputs" |
| 8 | New `onOutputVerification` shows missing files | Missing paths listed in output |
| 9 | New `onFlowAbandoned` shows abandon | "abandoned" in output |

**File:** `test/progress/noop.test.ts` (new)

| # | Test | Expected |
|---|------|----------|
| 1 | All methods called without error | No throws |
| 2 | Implements all required interface methods | TypeScript compilation passes |

**File:** `test/orchestrator/progress-integration.test.ts` (new)

| # | Test | Expected |
|---|------|----------|
| 1 | Mock progress receives `onFlowStart` with correct flow info | Called with flowId, feature, totalSteps |
| 2 | Mock progress receives `onStepStart` and `onStepEnd` for each step | Called in order |
| 3 | Mock progress receives `onStepRetry` when agent fails then retries | Called with reason "error" |
| 4 | Mock progress receives `onOutputVerification` after verification | Called with verification result |
| 5 | Mock progress receives `onGate` when gate step completes | Called with gate input |
| 6 | Mock progress receives `onFlowComplete` when flow finishes | Called once |
| 7 | Mock progress receives `onFlowAbandoned` when user aborts via gate | Called once |
| 8 | Mock progress receives `onFlowBlocked` when step fails all retries | Called with error |
| 9 | No progress (undefined) does not crash the orchestrator | `progress?.onStepStart(...)` safe |

---

## Prioritized Task List

### Phase 1: MVP (must do — ship the minimal working thing)

| # | Task | Layer | Effort |
|---|------|-------|--------|
| 1 | Harden FilesystemVerifier (path resolution, permission errors) | Verifier | 1h |
| 2 | Expand FlowProgress interface (add onFlowStart, onFlowAbandoned, onStepRetry?) | Progress | 30m |
| 3 | Update orchestrator to call new progress hooks | Orchestrator | 30m |
| 4 | Update NoopProgress for new interface methods | Progress | 15m |
| 5 | Enhance ConsoleProgress (colors, timing, error formatting) | Progress | 1.5h |
| 6 | Unit tests: FilesystemVerifier (tests 1-9, 14-15) | Verifier | 1h |
| 7 | Unit tests: ConsoleProgress (tests 1-8) | Progress | 45m |
| 8 | Integration tests: orchestrator progress hooks (tests 1-9) | Orchestrator | 1h |

### Phase 2: Nice to have

| # | Task | Layer | Effort |
|---|------|-------|--------|
| 9 | Glob pattern support in FilesystemVerifier | Verifier | 1h |
| 10 | Unit tests: glob patterns (tests 10-13) | Verifier | 30m |
| 11 | ConsoleProgress JSON format | Progress | 30m |
| 12 | Fix non-strict mode to still verify and report warnings | Orchestrator | 30m |

### Phase 3: Deferred

| # | Task | Layer |
|---|------|-------|
| 13 | GitDiffVerifier | Verifier |
| 14 | ContentVerifier | Verifier |
| 15 | CompositeVerifier | Verifier |
| 16 | SlackProgress | Progress |
| 17 | FileProgress | Progress |
| 18 | WebSocketProgress | Progress |
| 19 | Spinner/progress indicator (ora) | Progress |

---

## Risks and Open Questions

1. **Glob dependency.** Adding glob support requires a package like `glob`, `fast-glob`, or `minimatch`. These are well-maintained but add to bundle size. If this is a CLI tool, that's fine. If it's a library consumed by others, consider making `expandGlobs` an opt-in feature that lazily imports the glob package.

2. **Symlink behavior.** `fs.existsSync` on a symlink to a file on a network mount (NFS, etc.) may hang. This is a filesystem-level issue, not something the verifier can fix. Document the behavior: "if your project is on a network filesystem, verification may be slow."

3. **ConsoleProgress JSON format.** The JSON format writes one JSON object per event per line (JSONL). This is machine-readable but loses the human-readable formatting. Consider: should we support BOTH formats simultaneously (pretty to stdout, JSON to a file)? This could be done with a `TeeProgress` that wraps two reporters.

4. **FlowProgress interface stability.** Adding methods to the interface breaks all implementations. With TypeScript, if we use optional methods (`?`), old implementations compile fine. The question is whether `onStepRetry` and `onOutputVerification` should be optional or required. Recommendation: make them optional (`?`) to avoid breaking existing implementations. `onFlowStart` and `onFlowAbandoned` are important enough to be required.

5. **Verifier cwd parameter is ambiguous.** The orchestrator passes `workflowDir` as `cwd`, but the interface says "project root." The `FilesystemVerifier` uses it as the base path for relative resolution. This is correct for the current usage but confusing. Recommendation: rename the parameter to `basePath` or add a JSDoc clarifying that it's the base directory for relative path resolution.
