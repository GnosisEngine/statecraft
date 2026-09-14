/**
 * Layer 4 — Action Pipeline: priority window.
 *
 * Who gets a chance to respond before an action resolves, and in what
 * order. This is a HOOK POINT, not a feature: computing a meaningful
 * responder order needs turn order and seating (Layer 6), which don't
 * exist yet. The default resolver always returns an empty window, so
 * every action resolves immediately with nothing pausing on it — but the
 * pipeline already calls this at the right point (after validate, before
 * resolve), so wiring in a real implementation later is a substitution,
 * not a pipeline redesign.
 */

import type { EntityId } from "../core/id.ts";
import type { ActionContext } from "./action-definition.ts";

export interface PriorityWindow {
  /** Fixer ids who may respond, in the order they receive priority. */
  responderOrder: EntityId[];
}

export type PriorityWindowResolver = (ctx: ActionContext) => PriorityWindow;

export const noPriorityWindow: PriorityWindowResolver = () => ({ responderOrder: [] });

/**
 * A real resolver, now that Layer 6 provides seating order: every other
 * fixer gets a chance to respond, in turn order starting from whoever is
 * seated after the acting fixer. Takes a plain array (e.g. TurnCycle's
 * `.seating`) rather than a TurnCycle instance — this file doesn't need
 * to know TurnCycle exists, just the seating order it produces.
 */
export function turnOrderPriorityWindow(fixerOrder: readonly EntityId[]): PriorityWindowResolver {
  return (ctx) => {
    const actingIndex = fixerOrder.indexOf(ctx.actingFixerId);
    if (actingIndex === -1) return { responderOrder: [] };
    const responderOrder = [...fixerOrder.slice(actingIndex + 1), ...fixerOrder.slice(0, actingIndex)];
    return { responderOrder };
  };
}
