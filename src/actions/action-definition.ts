/**
 * Layer 4 — Action Pipeline: definitions.
 *
 * An ActionDefinition is engine-registered content (like a rule handler in
 * Layer 5's pattern) — code, not event-log data. What DOES get logged per
 * game is the ActionContext (which action, who performed it, who/what it
 * targeted) plus the outcome; the definition itself is static config every
 * player's client and the server already agree on, so it never needs to
 * survive replay as a literal value.
 *
 * targetQuery is a function of the proposal, not a static BoolExpr,
 * because target legality is almost always relative to the proposal
 * itself ("any of the acting fixer's own contractors", "any contractor
 * NOT owned by the acting fixer") — BoolExpr's ops take literal ids (or
 * an EntityRef), so the concrete expression gets built per-proposal
 * from whatever the intent says.
 */

import type { EntityId } from "../core/id.ts";
import type { BoolExpr } from "../query/types.ts";

export type PerformerCapability = "preferred" | "weak" | "neutral";

export interface ActionContext {
  performerId: EntityId;
  actingFixerId: EntityId;
  targetIds: EntityId[];
  params?: Record<string, unknown>;
}

export interface ActionCost {
  /** Property deducted from the acting fixer, e.g. "resources". */
  prop: string;
  amount: number;
}

/** The BoolExpr that's always false — the "or" counterpart to phase-definition.ts's ALWAYS_TRUE_QUERY, via the same vacuous-quantifier trick (empty "or" = no disjunct satisfied = false). Useful as a deliberate "never legal" sentinel — e.g. buildActivateAction's targetQuery when no valid ability was named. */
export const NEVER_TRUE_QUERY: BoolExpr = { op: "or", exprs: [] };

export interface ActionDefinition {
  id: string;
  /**
   * Matched against the performer's pref:<category>/weak:<category>
   * tags for cost adjustment. A FUNCTION of ctx, same reasoning as
   * performerCondition/cost/minTargets/maxTargets: a generic "activate"
   * action dispatching to one of several abilities needs each ability's
   * own category, not one fixed category for every ability a card
   * could ever grant — this is what lets shakedown's existing
   * pref:coercion/weak:coercion cost adjustment keep working once it's
   * an ability rather than its own top-level ActionDefinition.
   */
  category: (ctx: ActionContext) => string;
  targetsOwn: boolean;
  targetsOthers: boolean;
  targetQuery(ctx: ActionContext): BoolExpr;
  /**
   * Extra legality condition evaluated against the performer entity
   * itself (e.g. "must be untapped"). A FUNCTION of ctx, not a static
   * BoolExpr — same reasoning as targetQuery, and the reason it needed
   * to change: a generic "activate" action (one ActionDefinition
   * dispatching to whichever ability a card's data names, via
   * ctx.params) needs to check something like `hasTag:
   * ability:${ctx.params.abilityId}` — a tag name that depends on the
   * proposal itself, which a static BoolExpr can never express.
   */
  performerCondition?: (ctx: ActionContext) => BoolExpr;
  /**
   * Constrains how many targets a proposal must supply. Both undefined
   * (the default, for an action/ability that doesn't set them) means
   * unrestricted, including zero. FUNCTIONS of ctx for the same reason
   * as performerCondition above — a generic "activate" dispatching to
   * one of several abilities needs each ability's own arity, not one
   * fixed number for every ability a card could ever grant.
   */
  minTargets?: (ctx: ActionContext) => number | undefined;
  maxTargets?: (ctx: ActionContext) => number | undefined;
  cost?: (ctx: ActionContext) => ActionCost | undefined;
  /**
   * Legality condition based on WHEN this action may be attempted —
   * active-turn-only, reactive-only, phase-gated, stack-state-gated,
   * etc. Evaluated against the performer as ambient subject, same
   * convention as performerCondition. OMITTED means no timing
   * restriction at all (always legal, subject to everything else) —
   * the engine has no built-in notion of "whose turn it is" (that's a
   * tag/property a GAME defines, e.g. cyberfixer's own "active-turn"
   * tag via its own syncActiveTurnTag), so there's no meaningful
   * engine-level default beyond "unrestricted." A reactive/instant-
   * speed action is simply one whose timingCondition doesn't require
   * active-turn at all — not a special engine concept, just a
   * different BoolExpr.
   */
  timingCondition?: (ctx: ActionContext) => BoolExpr;
  /** Name of the effect handler registered in EffectHandlerRegistry (see effect-handler.ts). */
  effect: string;
}

export class ActionRegistry {
  private definitions = new Map<string, ActionDefinition>();

  register(definition: ActionDefinition): void {
    this.definitions.set(definition.id, definition);
  }

  get(id: string): ActionDefinition | undefined {
    return this.definitions.get(id);
  }
}

/**
 * Default capability-matching policy. A contractor tagged `pref:<category>`
 * is preferred for actions in that category; `weak:<category>` is weak;
 * anything else is neutral. This is exactly the kind of number that will
 * get tuned once the actual game exists — it's a placeholder default, not
 * a rule handed down from the design doc.
 */
export function resolvePerformerCapability(
  performerTags: ReadonlySet<string>,
  category: string,
): PerformerCapability {
  if (performerTags.has(`pref:${category}`)) return "preferred";
  if (performerTags.has(`weak:${category}`)) return "weak";
  return "neutral";
}

/** Default cost adjustment for a given capability match. Same tuning caveat as above. */
export function adjustCostForCapability(baseAmount: number, capability: PerformerCapability): number {
  switch (capability) {
    case "preferred":
      return Math.floor(baseAmount / 2);
    case "weak":
      return Math.ceil(baseAmount * 1.5);
    case "neutral":
      return baseAmount;
  }
}
