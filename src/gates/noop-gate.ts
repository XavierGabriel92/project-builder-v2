/**
 * Auto-Approve Gate Presenter
 *
 * Approves every gate without human interaction.
 * Use for CI/CD pipelines, automated runs, or testing.
 */

import type { GatePresenter, GateInput, GateAnswer } from "../orchestrator/ports.ts";

export class AutoApproveGate implements GatePresenter {
  readonly name = "auto-approve";

  async present(gate: GateInput, _cwd: string): Promise<GateAnswer> {
    // Find the first option with advance: true
    const approveOption = gate.options.find(o => o.advance);

    if (!approveOption) {
      throw new Error(
        `Gate "${gate.header}" has no advance-true option — cannot auto-approve`
      );
    }

    return {
      label: approveOption.label,
      advance: true,
    };
  }
}
