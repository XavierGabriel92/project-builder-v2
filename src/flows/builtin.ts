/**
 * Built-in Flow Definitions
 *
 * Reused from project-builder v1. Same flow structure, same agent references.
 * The orchestrator loads agent .md manifests at runtime — the flow only says
 * which agents run, in what order, with what retry/approval configuration.
 */

import type { FlowDefinition } from "../engine/types.ts";

/**
 * Full product feature build pipeline.
 *
 *   spec-write (gate) → plan →
 *   implement (2 attempts) → review (gate) → lint →
 *   doc-sync (2 attempts)
 */
export const FEATURE_BUILD_FLOW: FlowDefinition = {
  id: "feature-build",
  version: 6,
  description: "Full product feature build from analysis to completion docs",
  steps: [
    { agent: "spec-write", requestApproval: true },
    { agent: "plan" },
    { agent: "implement", attempts: 2 },
    { agent: "review", requestApproval: true },
    { agent: "lint" },
    { agent: "doc-sync", attempts: 2 },
  ],
};

/**
 * Bug fix pipeline: triage → reproduce → diagnose → fix → verify → doc-sync.
 *
 *   triage (gate) → reproduce → diagnose →
 *   fix (2 attempts) → verify (gate) → doc-sync
 */
export const BUG_FIX_FLOW: FlowDefinition = {
  id: "bug-fix",
  version: 1,
  description: "Bug fix pipeline from triage to verification and docs",
  steps: [
    { agent: "triage", requestApproval: true },
    { agent: "reproduce" },
    { agent: "diagnose" },
    { agent: "fix", attempts: 2 },
    { agent: "verify", requestApproval: true },
    { agent: "doc-sync" },
  ],
};

/**
 * Small feature: no triage, shorter pipeline for well-scoped changes.
 *
 *   spec-write (gate) → implement (2 attempts) →
 *   review (gate) → lint → doc-sync
 */
export const SMALL_FEATURE_FLOW: FlowDefinition = {
  id: "small-feature",
  version: 1,
  description: "Shorter pipeline for well-scoped features — no triage or reproduce",
  steps: [
    { agent: "spec-write", requestApproval: true },
    { agent: "implement", attempts: 2 },
    { agent: "review", requestApproval: true },
    { agent: "lint" },
    { agent: "doc-sync" },
  ],
};

/**
 * Quick feature: skip spec and doc-sync for small changes.
 *
 *   plan → implement (2 attempts) → review (gate) → lint
 */
export const QUICK_BUILD_FLOW: FlowDefinition = {
  id: "quick-build",
  version: 1,
  description: "Fast pipeline for small features — no spec, no doc-sync",
  steps: [
    { agent: "plan" },
    { agent: "implement", attempts: 2 },
    { agent: "review", requestApproval: true },
    { agent: "lint" },
  ],
};

/**
 * CI pipeline: no gates, auto-approve everything.
 *
 *   plan → implement (3 attempts) → lint → doc-sync (2 attempts)
 */
export const CI_BUILD_FLOW: FlowDefinition = {
  id: "ci-build",
  version: 1,
  description: "Fully automated CI pipeline — no human gates",
  steps: [
    { agent: "plan" },
    { agent: "implement", attempts: 3 },
    { agent: "lint" },
    { agent: "doc-sync", attempts: 2 },
  ],
};

// ============================================================================
// Registry
// ============================================================================

/** All built-in flow definitions. */
export const allFlows: FlowDefinition[] = [
  FEATURE_BUILD_FLOW,
  BUG_FIX_FLOW,
  SMALL_FEATURE_FLOW,
  QUICK_BUILD_FLOW,
  CI_BUILD_FLOW,
];

/** Look up a built-in flow by id. Returns undefined if not found. */
export function getFlow(id: string): FlowDefinition | undefined {
  return allFlows.find(f => f.id === id);
}
