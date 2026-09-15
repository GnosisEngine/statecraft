/**
 * Layer 4 — Action Pipeline: registerReflex.
 *
 * A Reflex-genre card shares one shape regardless of which game defines
 * it: "whenever TRIGGER fires, for every entity carrying
 * boundAbilityTag that MATCHES the event, automatically propose that
 * entity's bound response" — only the trigger, the match condition, and
 * which ability responds vary per card. This is that shared shape,
 * built once, promoted here after cyberfixer's own first instance
 * (Countermeasure) proved it out — checked directly before promoting:
 * every dependency it touches (Stack, PendingActionRegistry,
 * EffectHandlerRegistry, EventBus, proposeAction, currentOwner,
 * createCard) is already generic engine machinery. The only things
 * that were ever cyberfixer-specific were two hardcoded strings (an
 * anchor entity id and a counter property name), now parameters
 * instead.
 *
 * Bound entities are found by TAG, not by a hardcoded entity id —
 * operatives are drafted, so their real ids don't exist at game-content-
 * build time at all, the same reason activate.ts's own AbilityRegistry
 * works by tag rather than by id.
 *
 * "Automatically proposed" still pays its own normal cost through the
 * ordinary proposeAction path — this is automated PROPOSAL, not a free
 * ability. If the bound fixer can't currently afford it, or the
 * response is no longer legal for some other reason, proposeAction
 * rejects it the same as any other proposal, and the reflex silently
 * doesn't fire — no special-casing needed for that case.
 *
 * A deterministic pending-item id is required — Date.now() or any
 * other non-deterministic source would silently break replay. This
 * uses a dedicated, monotonically increasing counter property on a
 * caller-supplied anchor entity, the exact same "ordinary property
 * mutation, replayed the same as any other" shape pushedAtSequence
 * itself already uses. `anchorEntityId` must already exist by the time
 * any reflex fires, and `counterProperty` must not collide with any
 * other property the game already uses on that same entity — both are
 * the caller's own responsibility to choose sensibly, the same as
 * choosing a unique rule id.
 */

import type { EntityId } from "../core/id.ts";
import { createCard, currentOwner } from "../core/entity.ts";
import type { EventBus } from "../events/bus.ts";
import type { GameEvent, GameEventType } from "../events/types.ts";
import type { Stack } from "../events/stack.ts";
import type { QueryContext } from "../query/interpreter.ts";
import type { RuleTable } from "../rules/rule-table.ts";
import type { RuleHandlerRegistry } from "../rules/rule-handler.ts";
import { registerRule } from "../rules/register-rule.ts";
import type { ActionDefinition, ActionContext } from "./action-definition.ts";
import type { EffectHandlerRegistry } from "./effect-handler.ts";
import { proposeAction, type PerformActionDeps } from "./pipeline.ts";
import type { PendingActionRegistry } from "./pending-action-registry.ts";

export interface ReflexDeps {
  ruleTable: RuleTable;
  ruleHandlers: RuleHandlerRegistry;
  stack: Stack;
  pendingActions: PendingActionRegistry;
  effectHandlers: EffectHandlerRegistry;
  bus: EventBus;
  /** The game's own generic dispatch action (e.g. buildActivateAction's own result) — every reflex response is proposed through this, with params.abilityId naming the specific ability. */
  activateDefinition: ActionDefinition;
  /** Any entity that already exists by the time a reflex could first fire — carries the deterministic counter used to generate pending-item ids. Must be the SAME entity across every registerReflex call in one game, or ids could collide across different reflexes. */
  anchorEntityId: EntityId;
  /** Property name for the counter above — must not collide with any other property the game already stores on anchorEntityId. */
  counterProperty: string;
}

export interface ReflexConfig<T extends GameEventType> {
  id: string;
  boundAbilityTag: string;
  trigger: T;
  /** Does this reflex fire for this specific bound entity, given the triggering event? */
  matches: (event: Extract<GameEvent, { type: T }>, boundEntityId: EntityId, ctx: QueryContext) => boolean;
  /** Which registered ability (in the game's own AbilityRegistry) the bound entity proposes in response. */
  responseAbilityId: string;
  /** The response's own targetIds/extra params, derived from the event and the bound entity. */
  buildIntent: (event: Extract<GameEvent, { type: T }>, boundEntityId: EntityId) => { targetIds: EntityId[]; params?: Record<string, unknown> };
}

export function registerReflex<T extends GameEventType>(deps: ReflexDeps, config: ReflexConfig<T>): void {
  registerRule(deps.ruleTable, deps.ruleHandlers, { id: config.id, trigger: config.trigger }, (event, api) => {
    for (const entity of api.entities.getAllEntities()) {
      if (!entity.tags.has(config.boundAbilityTag)) continue;
      if (!config.matches(event, entity.id, api.resolver)) continue;
      const boundFixerId = currentOwner(entity);
      if (boundFixerId === undefined) continue; // unowned — nothing to propose on behalf of

      const { targetIds, params } = config.buildIntent(event, entity.id);
      const intent: ActionContext = { performerId: entity.id, actingFixerId: boundFixerId, targetIds, params: { abilityId: config.responseAbilityId, ...params } };
      const proposeDeps: PerformActionDeps = {
        entities: api.entities,
        resolver: api.resolver,
        modifiers: api.modifiers,
        random: api.random,
        handlers: deps.effectHandlers,
        bus: deps.bus,
        pendingActions: deps.pendingActions,
      };
      const proposed = proposeAction(intent, deps.activateDefinition, proposeDeps);
      if (!proposed.ok) continue; // e.g. unaffordable, or no longer legal — silently doesn't fire, same as any failed proposal

      const nextReflexId = (api.resolver.getProperty(deps.anchorEntityId, deps.counterProperty) ?? 0) + 1;
      api.entities.setProperty(deps.anchorEntityId, deps.counterProperty, nextReflexId);
      const pendingId = `reflex-${entity.id}-${nextReflexId}`;

      const pendingCard = createCard(`Pending: ${config.responseAbilityId}`, { id: pendingId, ownership: [boundFixerId] });
      pendingCard.tags.add("pending-action");
      api.entities.add(pendingCard);
      deps.stack.push(pendingId, null); // a fresh root — not responding to whatever triggered it, just newly pending alongside it
      deps.pendingActions.set(pendingId, {
        intent,
        actionId: deps.activateDefinition.id,
        definition: deps.activateDefinition,
        capability: proposed.capability,
        adjustedCost: proposed.adjustedCost,
      });
    }
  });
}
