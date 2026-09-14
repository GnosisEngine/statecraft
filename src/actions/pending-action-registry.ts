/**
 * Layer 4 — Action Pipeline: PendingActionRegistry.
 *
 * The piece that makes "push a proposal onto Stack, wait for priority,
 * resolve it later" actually work: a pending stack item is just an
 * EntityId to Stack — it has no way to carry "which action, targeting
 * what, proposed by whom, at what already-computed capability/cost."
 * Properties are numbers-only and tags are boolean-only, so neither can
 * hold an ActionContext or an ActionDefinition reference directly — this
 * registry is the out-of-band memory that closes that gap, keyed by the
 * same EntityId Stack itself uses for the pending item.
 *
 * This is deliberately NOT queryable via BoolExpr/NumExpr, and that's
 * intentional, not a limitation to fix later: a card's own effects
 * (which ability, which targets) are content the query engine needs to
 * see, and those already live as ordinary tags/properties on real
 * entities (ability:<id>, ownership, pushedAtSequence) — see activate.ts
 * and stack.ts's own docs. What THIS registry stores is pipeline
 * bookkeeping (the ActionDefinition object itself, the exact
 * ActionContext used to propose it) that only the room's own resolution
 * step ever needs to read, not something any card's own query should
 * ever need to reach into.
 *
 * SERIALIZATION ("Ghost in the Machine"): PendingAction.definition is a
 * LIVE ActionDefinition object with function fields (targetQuery,
 * performerCondition, cost, timingCondition, category) — these cannot
 * round-trip through JSON, so serialize() never tries to. Instead it
 * stores `actionId` (which the game already knows at propose time,
 * e.g. room.ts's own message.actionId) and drops `definition` entirely;
 * loadRaw re-derives the live ActionDefinition reference by asking the
 * CALLER to look it up by that id. The lookup function is generic
 * (`(actionId) => ActionDefinition | undefined`), not a specific
 * content object — each game has its own action registry, and this
 * class has no business knowing what shape that takes. `intent`,
 * `capability`, and `adjustedCost` are all plain data and serialize
 * trivially; only `definition` ever needed this treatment.
 */

import type { EntityId } from "../core/id.ts";
import type { ActionContext, ActionDefinition, PerformerCapability } from "./action-definition.ts";

export interface PendingAction {
  intent: ActionContext;
  /** Which action this is (e.g. "activate") — the game's own action registry, looked up by this id, is what serialize/loadRaw use to avoid ever trying to persist `definition` itself. */
  actionId: string;
  definition: ActionDefinition;
  /** Both already computed by whatever proposeAction call created this entry — resolveEffect never recomputes them, so resolution reflects the state of the world at PROPOSAL time, not whatever it happens to be when it finally resolves. */
  capability: PerformerCapability;
  adjustedCost: number;
}

/** Wire/snapshot format for one pending entry — everything EXCEPT the live `definition`, which loadRaw re-derives via its lookup function instead of ever trying to store. */
export interface SerializedPendingAction {
  itemId: EntityId;
  actionId: string;
  intent: ActionContext;
  capability: PerformerCapability;
  adjustedCost: number;
}

export class PendingActionRegistry {
  private pending = new Map<EntityId, PendingAction>();

  set(itemId: EntityId, action: PendingAction): void {
    this.pending.set(itemId, action);
  }

  get(itemId: EntityId): PendingAction | undefined {
    return this.pending.get(itemId);
  }

  has(itemId: EntityId): boolean {
    return this.pending.has(itemId);
  }

  /** Call once an item has actually resolved or been countered — leaving a stale entry around risks a future id collision resolving against the wrong stored action. */
  delete(itemId: EntityId): void {
    this.pending.delete(itemId);
  }

  /** Every currently pending entry, in the wire format described above — used by Snapshot (Layer 7). */
  serialize(): SerializedPendingAction[] {
    return [...this.pending.entries()].map(([itemId, action]) => ({
      itemId,
      actionId: action.actionId,
      intent: action.intent,
      capability: action.capability,
      adjustedCost: action.adjustedCost,
    }));
  }

  /**
   * Restores every entry from a snapshot, re-deriving each one's live
   * `definition` via `lookupAction` rather than expecting it to have
   * survived serialization. Fires no events — reconstructing prior
   * state isn't a live mutation, same principle as EntityStore/
   * Hierarchy/Stack's own loadRaw. Throws immediately, naming both the
   * missing actionId and the affected pending item, if `lookupAction`
   * can't find a definition for some entry — this is exactly what would
   * happen if the game's own action registry changed shape between
   * when a snapshot was taken and when it's being restored (a
   * redeploy with different registered content, say), and it should
   * fail loudly right here rather than leave a half-restored registry
   * that fails confusingly later, the first time that specific item
   * tries to resolve.
   */
  loadRaw(data: readonly SerializedPendingAction[], lookupAction: (actionId: string) => ActionDefinition | undefined): void {
    const restored = new Map<EntityId, PendingAction>();
    for (const entry of data) {
      const definition = lookupAction(entry.actionId);
      if (!definition) {
        throw new Error(
          `PendingActionRegistry.loadRaw: no action registered for "${entry.actionId}" (pending item "${entry.itemId}") — ` +
            `the game's own action registry may have changed since this snapshot was taken.`,
        );
      }
      restored.set(entry.itemId, { intent: entry.intent, actionId: entry.actionId, definition, capability: entry.capability, adjustedCost: entry.adjustedCost });
    }
    this.pending = restored;
  }
}
