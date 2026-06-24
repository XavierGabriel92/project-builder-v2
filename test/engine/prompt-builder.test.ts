/**
 * Unit tests for prompt-builder.ts
 *
 * Verifies that buildPrompt and buildSystemPrefix:
 * 1. Include workspace path instructions
 * 2. Include project rules when present
 * 3. Include feature context when present
 * 4. Include previous steps digest
 * 5. Include completion suffix with correct strictness message
 * 6. Do NOT include any v1 LLM-supervisor protocol instructions
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { buildPrompt, buildSystemPrefix } from "../../src/engine/prompt-builder.ts";
import type { WorkflowState, AgentManifest, FlowDefinition } from "../../src/engine/types.ts";
import type { LoadedAgent } from "../../src/engine/agent-loader.ts";

// ── Test helpers ─────────────────────────────────────────────

function makeState(overrides: Partial<WorkflowState> = {}): WorkflowState {
  const flowSnapshot: FlowDefinition = {
    id: "test-flow",
    version: 1,
    description: "test",
    steps: [
      { agent: "spec-write" },
      { agent: "plan" },
    ],
    strictOutputs: true,
    ...(overrides.flow_snapshot as Partial<FlowDefinition> | undefined),
  };

  return {
    schema_version: 1,
    feature: "test-feature",
    feature_path: "18-06-2026-test-feature",
    project_root: "/tmp/test",
    flow_id: "test-flow",
    flow_version: 1,
    flow_snapshot: flowSnapshot,
    current_step_index: 0,
    status: "in_progress",
    awaiting: null,
    steps: [],
    ...overrides,
    // Ensure flow_snapshot respects overrides
    flow_snapshot: {
      ...flowSnapshot,
      ...(overrides.flow_snapshot as Partial<FlowDefinition> | undefined),
    },
  };
}

function makeAgent(overrides: Partial<LoadedAgent> = {}): LoadedAgent {
  return {
    manifest: {
      id: "test-agent",
      version: 1,
      tools: ["read", "write"],
    } as AgentManifest,
    prompt: "",
    isSubagent: false,
    ...overrides,
  };
}

// ============================================================================
// buildSystemPrefix
// ============================================================================

describe("buildSystemPrefix", () => {
  it("includes workspace path instruction", () => {
    const state = makeState({ feature_path: "18-06-2026-user-auth" });
    const result = buildSystemPrefix(state);
    assert.match(result, /MUST be written to \/tmp\/test\/\.temp\/18-06-2026-user-auth/);
  });

  it("includes explicit output file names when outputs are provided", () => {
    const state = makeState({ feature_path: "18-06-2026-crud-using-express" });
    const result = buildSystemPrefix(state, ["spec.md"]);
    assert.match(result, /Specifically, you must write: \/tmp\/test\/\.temp\/18-06-2026-crud-using-express\/spec\.md/);
  });

  it("includes project rules when present", () => {
    const state = makeState({ project_rules_context: "## Rules\n\n- Use tabs" });
    const result = buildSystemPrefix(state);
    assert.match(result, /Project Rules/);
    assert.match(result, /Use tabs/);
  });

  it("includes feature context when present", () => {
    const state = makeState({ feature_context: "Build OAuth2 login" });
    const result = buildSystemPrefix(state);
    assert.match(result, /Feature Context/);
    assert.match(result, /OAuth2 login/);
  });

  it("does NOT include feature context section when absent", () => {
    const state = makeState({ feature_context: undefined });
    const result = buildSystemPrefix(state);
    assert.doesNotMatch(result, /Feature Context/);
  });

  it("does NOT include project rules section when absent", () => {
    const state = makeState({ project_rules_context: undefined });
    const result = buildSystemPrefix(state);
    assert.doesNotMatch(result, /Project Rules/);
  });
});

// ============================================================================
// buildPrompt
// ============================================================================

describe("buildPrompt", () => {
  it("includes agent prompt body", () => {
    const agent = makeAgent({ prompt: "# Spec Write\n\nYou are the spec-write agent." });
    const state = makeState({});
    const result = buildPrompt(agent, state);
    assert.match(result, /spec-write agent/);
  });

  it("includes previous steps digest when there are completed steps", () => {
    const state = makeState({
      steps: [
        {
          index: 0,
          id: "spec-write",
          agent: "plan",
          status: "completed",
          attempt: 1,
          activity: { message: "Plan created successfully", updated_at: "2026-06-18T00:00:00Z" },
        },
      ],
    });
    const agent = makeAgent({ prompt: "do stuff" });
    const result = buildPrompt(agent, state);
    assert.match(result, /Previous Steps/);
    assert.match(result, /plan.*completed.*Plan created successfully/);
  });

  it("omits previous steps digest when no completed steps", () => {
    const state = makeState({ steps: [] });
    const agent = makeAgent({ prompt: "do stuff" });
    const result = buildPrompt(agent, state);
    assert.doesNotMatch(result, /Previous Steps/);
  });

  it("truncates long step activity messages", () => {
    const longMsg = "a".repeat(500);
    const state = makeState({
      steps: [
        {
          index: 0,
          id: "spec-write",
          agent: "spec-write",
          status: "completed",
          attempt: 1,
          activity: { message: longMsg, updated_at: "2026-06-18T00:00:00Z" },
        },
      ],
    });
    const agent = makeAgent({ prompt: "do stuff" });
    const result = buildPrompt(agent, state);
    assert.match(result, /\.\.\./); // truncated marker
    // The truncated message should appear with "..." and be much shorter than original
    assert.ok(!result.includes(longMsg), "long message should not appear in full");
  });

  it("includes completion suffix with strict outputs message", () => {
    const state = makeState({ flow_snapshot: { id: "f", version: 1, description: "d", steps: [], strictOutputs: true } });
    const agent = makeAgent({ prompt: "do stuff" });
    const result = buildPrompt(agent, state);
    assert.match(result, /workflow will block/);
    assert.match(result, /do not ask what step comes next in the workflow/i);
  });

  it("includes completion suffix with non-strict message", () => {
    const state = makeState({ flow_snapshot: { id: "f", version: 1, description: "d", steps: [], strictOutputs: false } });
    const agent = makeAgent({ prompt: "do stuff" });
    const result = buildPrompt(agent, state);
    assert.match(result, /warnings will appear/);
  });

  // ── REMOVALS (regression checks) ───────────────────────────

  it("does NOT include APPROVAL_INSTRUCTION gate protocol text", () => {
    const state = makeState({});
    const agent = makeAgent({ prompt: "do stuff" });
    const result = buildPrompt(agent, state);
    assert.doesNotMatch(result, /flow_continue/);
    assert.doesNotMatch(result, /flow_record_gate/);
    assert.doesNotMatch(result, /gate nonce/);
    assert.doesNotMatch(result, /flow_step_complete/);
  });

  it("does NOT include SUPPRESS_SUBAGENT_PROGRESS", () => {
    const state = makeState({});
    const agent = makeAgent({ prompt: "do stuff" });
    const result = buildPrompt(agent, state);
    assert.doesNotMatch(result, /Subagent Behavior/);
    assert.doesNotMatch(result, /includeProgress: true/);
  });

  it("does NOT duplicate workspace prefix — it lives in buildSystemPrefix only", () => {
    const state = makeState({ feature_path: "18-06-2026-crud-using-express" });
    const agent = makeAgent({ prompt: "do stuff" });
    const result = buildPrompt(agent, state);
    assert.doesNotMatch(result, /MUST be written to .temp/);
    assert.doesNotMatch(result, /Always write .temp/);
  });

  it("does NOT include SUBAGENT_COMPLETION_SUFFIX", () => {
    const state = makeState({});
    const agent = makeAgent({ prompt: "do stuff" });
    const result = buildPrompt(agent, state);
    assert.doesNotMatch(result, /Return your results to the orchestrator/);
  });
});
