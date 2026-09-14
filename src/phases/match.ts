/**
 * Layer 6 — Match.
 *
 * Composes pregame -> playing -> postgame as three sequential stages.
 * Pregame (draft/pick) and postgame are each just a PhaseDefinition run
 * directly through PhaseRunner, the same mechanism TurnCycle uses for
 * every in-turn phase — they are not folded into TurnCycle's repeating
 * phase list, since they run exactly once and aren't per-fixer.
 *
 * "playing" doesn't end on its own — TurnCycle has no built-in concept
 * of a win condition, since that's game-specific content (Layer 10).
 * endPlayingStage() is the seam: a rule (Layer 5) reacting to a defeat
 * condition, or any other game logic, calls it to move the match into
 * postgame.
 */

import type { EntityId } from "../core/id.ts";
import type { PhaseDefinition } from "./phase-definition.ts";
import { PhaseRunner, type PhaseRunnerDeps } from "./phase-runner.ts";
import type { TurnCycle } from "./turn-cycle.ts";

export type MatchStage = "pregame" | "playing" | "postgame" | "complete";

export class Match {
  stage: MatchStage = "pregame";
  private readonly pregameRunner: PhaseRunner;
  private postgameRunner: PhaseRunner | null = null;

  constructor(
    private readonly pregame: PhaseDefinition,
    private readonly postgame: PhaseDefinition,
    private readonly turnCycle: TurnCycle,
    private readonly tableId: EntityId,
    private readonly deps: PhaseRunnerDeps,
  ) {
    this.pregameRunner = new PhaseRunner(pregame, tableId, deps);
  }

  start(): void {
    this.pregameRunner.start();
  }

  canAdvance(): boolean {
    switch (this.stage) {
      case "pregame":
        return this.pregameRunner.canEnd();
      case "playing":
        return this.turnCycle.canEndPhase();
      case "postgame":
        return this.postgameRunner?.canEnd() ?? false;
      case "complete":
        return false;
    }
  }

  /**
   * Advances within the current stage. Note this only ever steps through
   * TurnCycle's phases while "playing" — it never transitions out of
   * "playing" on its own, since only game-specific logic knows when the
   * match is actually over. See endPlayingStage().
   */
  tryAdvance(): { ok: true } | { ok: false; reason: string } {
    switch (this.stage) {
      case "pregame": {
        const result = this.pregameRunner.tryEnd();
        if (!result.ok) return result;
        this.stage = "playing";
        this.turnCycle.start();
        return { ok: true };
      }
      case "playing":
        return this.turnCycle.tryAdvance();
      case "postgame": {
        const result = this.postgameRunner!.tryEnd();
        if (!result.ok) return result;
        this.stage = "complete";
        return { ok: true };
      }
      case "complete":
        return { ok: false, reason: "match already complete" };
    }
  }

  /** Called by game-specific logic to end the playing stage early and move to postgame (e.g. on a "last fixer standing" condition). */
  endPlayingStage(): void {
    if (this.stage !== "playing") return;
    this.stage = "postgame";
    this.postgameRunner = new PhaseRunner(this.postgame, this.tableId, this.deps);
    this.postgameRunner.start();
  }
}
