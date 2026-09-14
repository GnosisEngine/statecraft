/**
 * Layer 4 — Action Pipeline: activate.
 *
 * buildActivateAction constructs ONE generic "activate" ActionDefinition
 * that dispatches to whichever ability a card's own data names (via
 * ctx.params.abilityId), looked up in an AbilityRegistry — rather than
 * registering one bespoke ActionDefinition per ability. This is what
 * lets a game add a new ability (restore, cutoff, liquidate, whatever)
 * as CONTENT — a registered AbilityRegistry entry plus an `ability:<id>`
 * tag on whichever cards grant it — instead of a new engine concept
 * each time one is designed.
 *
 * An AbilityRegistry is just an ActionRegistry — the shape (targetQuery,
 * performerCondition, cost, minTargets/maxTargets, category, effect) is
 * identical to a top-level action's; the only difference is HOW it gets
 * reached (through "activate" + ctx.params.abilityId, not its own
 * top-level actionId). No new class needed for that; the alias exists
 * purely so a call site reading `abilities: AbilityRegistry` doesn't
 * have to know that fact to be readable.
 *
 * A card GRANTS an ability by carrying an `ability:<id>` tag — checked
 * in performerCondition, not trusted from the client: a proposal
 * claiming an abilityId a card doesn't actually have is rejected the
 * same way an illegal target already is, not silently allowed through.
 *
 * targetsOwn/targetsOthers stay permissive (true/true) on the
 * "activate" ActionDefinition itself, deliberately: the belt-and-
 * suspenders ownership check other actions get from those two static
 * flags doesn't generalize through this one shared entry point, since
 * ownership restrictions vary per-ability. Each ability's OWN
 * targetQuery remains the full source of truth for its own ownership
 * restrictions — exactly what shakedown's targetQuery already did
 * (explicitly excluding the acting fixer's own contractors) before it
 * became an ability rather than its own top-level action.
 */

import type { ActionDefinition, ActionContext } from "./action-definition.ts";
import { ActionRegistry, NEVER_TRUE_QUERY } from "./action-definition.ts";
import type { BoolExpr } from "../query/types.ts";
import type { EffectHandler, EffectHandlerRegistry } from "./effect-handler.ts";

/** An AbilityRegistry IS an ActionRegistry — see this file's header for why no new class is needed. */
export type AbilityRegistry = ActionRegistry;

export function createAbilityRegistry(): AbilityRegistry {
  return new ActionRegistry();
}

function resolveAbility(abilities: AbilityRegistry, ctx: ActionContext): ActionDefinition | undefined {
  const abilityId = ctx.params?.abilityId;
  return typeof abilityId === "string" ? abilities.get(abilityId) : undefined;
}

export function buildActivateAction(abilities: AbilityRegistry): ActionDefinition {
  return {
    id: "activate",
    category: (ctx) => resolveAbility(abilities, ctx)?.category(ctx) ?? "activate",
    targetsOwn: true,
    targetsOthers: true,
    targetQuery: (ctx) => resolveAbility(abilities, ctx)?.targetQuery(ctx) ?? NEVER_TRUE_QUERY,
    performerCondition: (ctx): BoolExpr => {
      const abilityId = ctx.params?.abilityId;
      if (typeof abilityId !== "string") return NEVER_TRUE_QUERY;
      const ability = abilities.get(abilityId);
      if (!ability) return NEVER_TRUE_QUERY;
      const grantsAbility: BoolExpr = { op: "hasTag", tag: `ability:${abilityId}` };
      const ownCondition: BoolExpr = ability.performerCondition ? ability.performerCondition(ctx) : { op: "and", exprs: [] };
      return { op: "and", exprs: [grantsAbility, ownCondition] };
    },
    minTargets: (ctx) => resolveAbility(abilities, ctx)?.minTargets?.(ctx),
    maxTargets: (ctx) => resolveAbility(abilities, ctx)?.maxTargets?.(ctx),
    cost: (ctx) => resolveAbility(abilities, ctx)?.cost?.(ctx),
    // Careful distinction here: an ability that EXISTS but sets no
    // timingCondition of its own means "no timing restriction at all"
    // (ActionDefinition's own documented default for an omitted
    // timingCondition) — that must NOT collapse into the same
    // NEVER_TRUE_QUERY used for "no such ability exists." Conflating
    // these was a real bug caught by activate.test.ts's own happy-path
    // test: it made EVERY ability without its own timing restriction
    // permanently unusable, since "no restriction" was being rejected
    // as if it meant "no ability."
    timingCondition: (ctx): BoolExpr => {
      const ability = resolveAbility(abilities, ctx);
      if (!ability) return NEVER_TRUE_QUERY;
      return ability.timingCondition ? ability.timingCondition(ctx) : { op: "and", exprs: [] };
    },
    effect: "activateEffect",
  };
}

/**
 * The effect handler for "activate" itself — looks up which ability was
 * invoked and dispatches straight to ITS registered effect handler.
 * Everything here is validation the pipeline has already enforced
 * before this ever runs (a legal abilityId, a performer that actually
 * grants it) — the throws below are "this should be unreachable," not
 * expected rejection paths; if one fires, something upstream let an
 * illegal activation through.
 */
export function buildActivateEffectHandler(abilities: AbilityRegistry, effectHandlers: EffectHandlerRegistry): EffectHandler {
  return (ctx, api) => {
    const abilityId = ctx.params?.abilityId;
    if (typeof abilityId !== "string") {
      throw new Error("activateEffect: no abilityId in params — validateAction should have rejected this already");
    }
    const ability = abilities.get(abilityId);
    if (!ability) {
      throw new Error(`activateEffect: no ability registered for "${abilityId}" — validateAction should have rejected this already`);
    }
    const handler = effectHandlers.get(ability.effect);
    if (!handler) {
      throw new Error(`activateEffect: no effect handler registered for ability "${abilityId}"'s effect "${ability.effect}"`);
    }
    handler(ctx, api);
  };
}
