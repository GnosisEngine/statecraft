/**
 * Layer 6 — TurnCycle.
 *
 * Repeats a fixed phase list once per fixer, in seating order. Each
 * (phase, active-fixer) pairing gets its own PhaseRunner — a phase whose
 * gateSubject is "activeFixer" needs a different subject entity every
 * time the active fixer changes, which a single reused PhaseRunner
 * instance couldn't represent (its subjectId is fixed at construction).
 */

import type { EntityId } from "../core/id.ts";
import type { PhaseDefinition } from "./phase-definition.ts";
import { PhaseRunner, type PhaseRunnerDeps } from "./phase-runner.ts";

export class TurnCycle {
  private phaseIndex = 0;
  private fixerIndex = 0;
  private turnNumber = 1;
  private runner: PhaseRunner;

  constructor(
    private readonly phases: readonly PhaseDefinition[],
    private readonly fixerOrder: readonly EntityId[],
    private readonly tableId: EntityId,
    private readonly deps: PhaseRunnerDeps,
  ) {
    if (phases.length === 0) throw new Error("TurnCycle requires at least one phase");
    if (fixerOrder.length === 0) throw new Error("TurnCycle requires at least one fixer");
    this.runner = this.makeRunner();
  }

  private makeRunner(): PhaseRunner {
    const phase = this.phases[this.phaseIndex]!;
    const subjectId = phase.gateSubject === "table" ? this.tableId : this.fixerOrder[this.fixerIndex]!;
    return new PhaseRunner(phase, subjectId, this.deps);
  }

  get currentPhase(): PhaseDefinition {
    return this.phases[this.phaseIndex]!;
  }

  get activeFixerId(): EntityId {
    return this.fixerOrder[this.fixerIndex]!;
  }

  get turn(): number {
    return this.turnNumber;
  }

  get seating(): readonly EntityId[] {
    return this.fixerOrder;
  }

  /** Starts the first phase of the first fixer's first turn. */
  start(): void {
    this.runner.start();
  }

  canEndPhase(): boolean {
    return this.runner.canEnd();
  }

  /**
   * Ends the current phase (if its gate allows) and advances — to the
   * next phase for the same fixer, or, once the phase list is exhausted,
   * to the first phase of the next fixer's turn (turn number incrementing
   * only on that wrap).
   */
  tryAdvance(): { ok: true } | { ok: false; reason: string } {
    const result = this.runner.tryEnd();
    if (!result.ok) return result;

    this.phaseIndex++;
    if (this.phaseIndex >= this.phases.length) {
      this.phaseIndex = 0;
      this.fixerIndex = (this.fixerIndex + 1) % this.fixerOrder.length;
      this.turnNumber++;
    }
    this.runner = this.makeRunner();
    this.runner.start();
    return { ok: true };
  }
}
