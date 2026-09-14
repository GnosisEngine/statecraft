/**
 * Layer 6 — Phases & Turn Cycle: PhaseDefinition.
 *
 * completionGate is the SAME primitive for both resolution modes
 * discussed while designing this: a forced phase ("retire contractors
 * until outflow <= inflow") uses a real BoolExpr; a voluntary phase (a
 * free-form main phase the player ends by choice) uses ALWAYS_TRUE_QUERY.
 * Whether a phase can end is always "is completionGate satisfied against
 * the subject" — the expression itself is what makes a phase forced or
 * voluntary, not a separate code path.
 */

import type { ActionApi } from "../actions/effect-handler.ts";
import type { BoolExpr } from "../query/types.ts";

/** Vacuously true (an "and" of zero conditions) — for voluntary phases, or anywhere "always allowed to proceed" is needed. */
export const ALWAYS_TRUE_QUERY: BoolExpr = { op: "and", exprs: [] };

export interface PhaseDefinition {
  id: string;
  /** Which entity the completionGate (and onChange watching) evaluates against. */
  gateSubject: "table" | "activeFixer";
  completionGate: BoolExpr;
  onStart?: string;
  onChange?: string;
  onEnd?: string;
}

export interface PhaseContext {
  phaseId: string;
  /** The entity the gate was evaluated against for this phase instance. */
  subjectId: string;
}

export type PhaseHandler = (ctx: PhaseContext, api: ActionApi) => void;

export class PhaseHandlerRegistry {
  private handlers = new Map<string, PhaseHandler>();

  register(name: string, handler: PhaseHandler): void {
    this.handlers.set(name, handler);
  }

  get(name: string): PhaseHandler | undefined {
    return this.handlers.get(name);
  }
}
