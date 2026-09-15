/**
 * Layer 4 — Action Pipeline: propose -> validate -> performer-capability
 * match -> resolve -> emit.
 *
 * validateAction is exported standalone so legality can be checked (e.g.
 * for UI affordances — "can this contractor legally do this?") without
 * side effects. performAction runs the full pipeline: validate, emit
 * proposed/rejected/resolved on the bus, deduct cost, invoke the effect
 * handler, entirely through EntityStore/ModifierStore so every mutation
 * stays observable.
 */

import { currentOwner } from "../core/entity.ts";
import type { EntityStore } from "../events/entity-store.ts";
import type { EventBus } from "../events/bus.ts";
import type { ModifierStore } from "../properties/modifier-store.ts";
import type { PropertyResolver } from "../properties/property-resolver.ts";
import type { SeededRandom } from "../persistence/seeded-random.ts";
import { makeRandomFor, type RandomRegistry } from "../persistence/random-registry.ts";
import { evaluateBoolExpr, selectEntities } from "../query/interpreter.ts";
import {
  adjustCostForCapability,
  resolvePerformerCapability,
  type ActionContext,
  type ActionDefinition,
  type PerformerCapability,
} from "./action-definition.ts";
import type { EffectHandlerRegistry, ResolvedActionContext } from "./effect-handler.ts";
import type { PendingActionRegistry } from "./pending-action-registry.ts";
import { noPriorityWindow, type PriorityWindowResolver } from "./priority-window.ts";

export type ActionResult =
  | { ok: true; adjustedCost: number; capability: PerformerCapability }
  | { ok: false; reason: string };

export interface ValidateDeps {
  entities: EntityStore;
  resolver: PropertyResolver;
}

export function validateAction(intent: ActionContext, definition: ActionDefinition, deps: ValidateDeps): ActionResult {
  const performer = deps.entities.get(intent.performerId);
  if (!performer) {
    return { ok: false, reason: `unknown performer: ${intent.performerId}` };
  }

  if (definition.timingCondition && !evaluateBoolExpr(definition.timingCondition(intent), intent.performerId, deps.resolver)) {
    return { ok: false, reason: "timing condition not met" };
  }

  if (definition.performerCondition && !evaluateBoolExpr(definition.performerCondition(intent), performer.id, deps.resolver)) {
    return { ok: false, reason: "performer condition not met" };
  }

  const minTargets = definition.minTargets?.(intent);
  const maxTargets = definition.maxTargets?.(intent);
  const targetCount = intent.targetIds.length;
  if (minTargets !== undefined && targetCount < minTargets) {
    return { ok: false, reason: `action "${definition.id}" requires at least ${minTargets} target(s), got ${targetCount}` };
  }
  if (maxTargets !== undefined && targetCount > maxTargets) {
    return { ok: false, reason: `action "${definition.id}" allows at most ${maxTargets} target(s), got ${targetCount}` };
  }

  const legalTargets = selectEntities(definition.targetQuery(intent), deps.resolver);
  const legalIds = new Set(legalTargets.map((e) => e.id));

  for (const targetId of intent.targetIds) {
    if (!legalIds.has(targetId)) {
      return { ok: false, reason: `illegal target: ${targetId}` };
    }
    // Ownership check is independent of whatever targetQuery encodes — a
    // belt-and-suspenders check against targetsOwn/targetsOthers, per the
    // "action capability" flags design (see action-definition.ts).
    const targetEntity = deps.entities.get(targetId);
    const owner = targetEntity ? currentOwner(targetEntity) : undefined;
    if (owner !== undefined) {
      if (owner === intent.actingFixerId && !definition.targetsOwn) {
        return { ok: false, reason: `action "${definition.id}" cannot target the performer's own entities` };
      }
      if (owner !== intent.actingFixerId && !definition.targetsOthers) {
        return { ok: false, reason: `action "${definition.id}" cannot target another fixer's entities` };
      }
    }
  }

  const capability = resolvePerformerCapability(performer.tags, definition.category(intent));

  let adjustedCost = 0;
  const cost = definition.cost?.(intent);
  if (cost) {
    adjustedCost = adjustCostForCapability(cost.amount, capability);
    const available = deps.resolver.getProperty(intent.actingFixerId, cost.prop) ?? 0;
    if (available < adjustedCost) {
      return {
        ok: false,
        reason: `insufficient ${cost.prop}: need ${adjustedCost}, have ${available}`,
      };
    }
  }

  return { ok: true, adjustedCost, capability };
}

export interface PerformActionDeps extends ValidateDeps {
  modifiers: ModifierStore;
  random: SeededRandom;
  /** Only needed if an effect handler calls api.randomFor(domain) — see RandomRegistry. */
  randomRegistry?: RandomRegistry;
  handlers: EffectHandlerRegistry;
  bus: EventBus;
  priorityWindowResolver?: PriorityWindowResolver;
  /** Only needed if an effect handler reads api.pendingActions — see ActionApi's own docs for what that's for and why it's deliberately narrow. Optional here (unlike Snapshot's own required-nullable pendingActionRegistry param) because PerformActionDeps is constructed in dozens of test rigs that have nothing to do with interactive, propose-now-resolve-later play at all — forcing every one of them to pass null would be pure boilerplate, not a meaningful safety improvement the way it is for Snapshot's own, much narrower set of call sites. */
  pendingActions?: PendingActionRegistry;
}

/**
 * Validates and, if legal, pays the cost — but does NOT run the effect
 * handler. This is the "propose" half of the pipeline, split out
 * specifically so a game can push the result onto a Stack and wait for
 * priority before actually resolving it (see resolveEffect below),
 * rather than always resolving synchronously in one call the way
 * performAction still does for anything that doesn't need to wait.
 * Cost is paid HERE, at proposal time, not at resolution — matching the
 * standard convention that a countered/never-resolved proposal doesn't
 * refund what it cost to make.
 */
export function proposeAction(intent: ActionContext, definition: ActionDefinition, deps: PerformActionDeps): ActionResult {
  deps.bus.emit({
    type: "action:proposed",
    actionId: definition.id,
    performerId: intent.performerId,
    actingFixerId: intent.actingFixerId,
    targetIds: intent.targetIds,
    params: intent.params,
  });

  const result = validateAction(intent, definition, deps);

  if (!result.ok) {
    deps.bus.emit({
      type: "action:rejected",
      actionId: definition.id,
      performerId: intent.performerId,
      actingFixerId: intent.actingFixerId,
      reason: result.reason,
    });
    return result;
  }

  // Hook point for Layer 6: once turn order/seating exist, a real resolver
  // here would return live responders and the pipeline would pause for
  // reactions before continuing. Nothing to pause on yet, so this is
  // computed but discarded — see priority-window.ts.
  (deps.priorityWindowResolver ?? noPriorityWindow)(intent);

  const cost = definition.cost?.(intent);
  if (cost) {
    const current = deps.resolver.getProperty(intent.actingFixerId, cost.prop) ?? 0;
    deps.entities.setProperty(intent.actingFixerId, cost.prop, current - result.adjustedCost);
  }

  return result;
}

/**
 * Runs the effect handler for an ALREADY-PAID-FOR proposal — the
 * "resolve" half. `capability`/`adjustedCost` come from whatever
 * proposeAction returned; cost is never re-charged, so it's safe to
 * call arbitrarily later than the original proposal (e.g. after a
 * priority round finishes), including after other, unrelated
 * mutations have happened in between.
 *
 * RE-VALIDATION ("Protection"): unlike cost, LEGALITY *is* re-checked
 * here, immediately before the handler runs — timingCondition,
 * performerCondition, and targetQuery/ownership for every target, the
 * same checks proposeAction ran, evaluated fresh against CURRENT state
 * rather than trusted from propose time. If any of them no longer
 * hold — a target lost the tag that made it legal, the performer lost
 * the tag performerCondition required, the timing window closed — the
 * proposal FIZZLES: the effect handler never runs, cost stays paid
 * (unaffected, per "Malfunction" below), and an `action:fizzled` event
 * fires instead of `action:resolved`. Deliberately an EVENT, not a
 * counter or any other stack-specific mechanism — resolveEffect itself
 * has no idea whether its caller is using a Stack at all, and content
 * is free to react to a fizzle however its own game logic wants
 * (log it, refund something extra, trigger a follow-up rule) rather
 * than the engine imposing one fixed meaning for what a fizzle does.
 * minTargets/maxTargets are NOT re-checked — targetIds itself is fixed
 * data from propose time, arity can't have changed. See actions.test.ts's
 * own "Protection" suite, proven.
 *
 * This changes exactly what "Dead Drop" (the performer ceasing to
 * exist before this runs) means for an action that DEFINES
 * performerCondition: re-validation will find that condition failing
 * against a subject that no longer exists (the same graceful
 * "hasTag on a missing entity reads false" behavior every other query
 * already has) and fizzle before the handler is ever reached. Dead
 * Drop's own three-state contract — targetIds-only effects unaffected,
 * reading the performer's property gets undefined, mutating it
 * throws — still holds exactly as before, but only for an action
 * whose performerCondition (if it has one at all) doesn't happen to
 * depend on the performer still existing; an action with no
 * performerCondition at all never had anything to re-validate about
 * the performer, so Dead Drop's scenario is fully reachable there.
 *
 * There is also NO transaction guarantee here ("Malfunction") — this
 * function never wraps the handler in a try/catch, and nothing rolls
 * back partial state. If a handler makes several mutations and then
 * throws (a genuine bug, or an unguarded assumption that turns out
 * false), every mutation made before the throw is permanent; only the
 * ones after it never happen. Cost is similarly unaffected — it was
 * already deducted by proposeAction before resolveEffect ever runs, so
 * a mid-effect crash does not refund it. An effect author who needs
 * multiple mutations to succeed or fail together has to arrange that
 * themselves; the engine provides no atomicity here at all. See
 * actions.test.ts's own "Malfunction" suite for both halves, proven.
 */
export interface ResolveEffectResult {
  fizzled: boolean;
  /** Only set when fizzled — which check failed. */
  reason?: string;
}

function revalidateBeforeResolution(intent: ActionContext, definition: ActionDefinition, deps: PerformActionDeps): { ok: true } | { ok: false; reason: string } {
  if (definition.timingCondition && !evaluateBoolExpr(definition.timingCondition(intent), intent.performerId, deps.resolver)) {
    return { ok: false, reason: "timing condition no longer met" };
  }
  if (definition.performerCondition && !evaluateBoolExpr(definition.performerCondition(intent), intent.performerId, deps.resolver)) {
    return { ok: false, reason: "performer condition no longer met" };
  }
  const legalTargets = selectEntities(definition.targetQuery(intent), deps.resolver);
  const legalIds = new Set(legalTargets.map((e) => e.id));
  for (const targetId of intent.targetIds) {
    if (!legalIds.has(targetId)) {
      return { ok: false, reason: `target "${targetId}" is no longer legal` };
    }
    // Same belt-and-suspenders ownership re-check validateAction itself does.
    const targetEntity = deps.entities.get(targetId);
    const owner = targetEntity ? currentOwner(targetEntity) : undefined;
    if (owner !== undefined) {
      if (owner === intent.actingFixerId && !definition.targetsOwn) {
        return { ok: false, reason: `target "${targetId}" is now owned by the performer's own fixer` };
      }
      if (owner !== intent.actingFixerId && !definition.targetsOthers) {
        return { ok: false, reason: `target "${targetId}" is now owned by another fixer` };
      }
    }
  }
  return { ok: true };
}

export function resolveEffect(intent: ActionContext, definition: ActionDefinition, capability: PerformerCapability, adjustedCost: number, deps: PerformActionDeps): ResolveEffectResult {
  const revalidation = revalidateBeforeResolution(intent, definition, deps);
  if (!revalidation.ok) {
    deps.bus.emit({
      type: "action:fizzled",
      actionId: definition.id,
      performerId: intent.performerId,
      actingFixerId: intent.actingFixerId,
      targetIds: intent.targetIds,
      reason: revalidation.reason,
    });
    return { fizzled: true, reason: revalidation.reason };
  }

  const handler = deps.handlers.get(definition.effect);
  if (!handler) {
    throw new Error(`No effect handler registered for "${definition.effect}"`);
  }

  const resolvedCtx: ResolvedActionContext = { ...intent, capability, adjustedCost };
  handler(resolvedCtx, {
    entities: deps.entities,
    modifiers: deps.modifiers,
    resolver: deps.resolver,
    random: deps.random,
    randomFor: makeRandomFor(deps.randomRegistry),
    pendingActions: deps.pendingActions,
  });

  deps.bus.emit({
    type: "action:resolved",
    actionId: definition.id,
    performerId: intent.performerId,
    actingFixerId: intent.actingFixerId,
    targetIds: intent.targetIds,
    capability,
    adjustedCost,
  });
  return { fizzled: false };
}

/**
 * Proposes and, if legal, immediately resolves in the same call —
 * unchanged behavior for anything that doesn't need to wait for
 * priority. Just proposeAction followed by resolveEffect now, not its
 * own separate implementation. A fizzle here is structurally rare
 * (validate and resolve happen back to back, synchronously, with
 * nothing else running in between under normal circumstances) but not
 * impossible — a rule reacting to the cost deduction itself could, in
 * principle, invalidate a target before resolveEffect even runs. This
 * function's own return type is unchanged (ActionResult never grew a
 * fizzled field) — a fizzle is still observable via the
 * action:fizzled event resolveEffect fires, the same way callers
 * already observe action:resolved/action:rejected primarily through
 * events rather than return values.
 */
export function performAction(intent: ActionContext, definition: ActionDefinition, deps: PerformActionDeps): ActionResult {
  const result = proposeAction(intent, definition, deps);
  if (result.ok) {
    resolveEffect(intent, definition, result.capability, result.adjustedCost, deps);
  }
  return result;
}
