/**
 * Layer 4 — Action Pipeline: effect handlers.
 *
 * The resolve stage's actual logic. Referenced by name from
 * ActionDefinition.effect, same rules-as-data-referencing-code-handlers
 * pattern as Layer 5. A handler mutates state only through ActionApi
 * (EntityStore/ModifierStore), never by reaching into an Entity directly —
 * same discipline Layer 2/3 already enforce, so every effect stays
 * observable on the bus.
 */

import type { EntityStore } from "../events/entity-store.ts";
import type { ModifierStore } from "../properties/modifier-store.ts";
import type { PropertyResolver } from "../properties/property-resolver.ts";
import type { SeededRandom } from "../persistence/seeded-random.ts";
import type { PendingActionRegistry } from "./pending-action-registry.ts";
import type { ActionContext, PerformerCapability } from "./action-definition.ts";

export interface ResolvedActionContext extends ActionContext {
  capability: PerformerCapability;
  adjustedCost: number;
}

export interface ActionApi {
  entities: EntityStore;
  modifiers: ModifierStore;
  /** Read resolved (base + modifier stack) values — e.g. api.resolver.getProperty(id, "power"), or pass api.resolver into evaluateAggregate/evaluateQuery directly. */
  resolver: PropertyResolver;
  /**
   * The ONE sanctioned source of randomness for any handler (action,
   * rule, or phase — they all share this shape). Never Math.random()
   * here — see seeded-random.ts. Use api.random.nextInt/.shuffle
   * directly, or rollDice(api.random, sides, count) for an actual dice
   * element.
   */
  random: SeededRandom;
  /**
   * Resolves a NAMED, isolated randomness domain (e.g. "fixer-A:deck")
   * — see RandomRegistry. Present only when the game registered
   * domain-specific streams; throws if called with a domain that was
   * never registered — never silently falls back to `random` above,
   * since that would defeat the entire point of isolating the domain.
   */
  randomFor?(domain: string): SeededRandom;
  /**
   * Reference to the game's own PendingActionRegistry, if it has one —
   * present only when PerformActionDeps was constructed with one (see
   * pipeline.ts's own docs). Lets an effect reach OTHER currently-
   * pending proposals — e.g. a Data-domain ability revealing what a
   * specific pending action's own intent.targetIds actually are, a
   * capability that's deliberately NOT exposed through the query
   * grammar itself (PendingAction.definition has live function fields
   * that can't be represented as BoolExpr/NumExpr data at all — see
   * pending-action-registry.ts's own header). This is the one blessed,
   * narrow channel for reaching in anyway, from inside an effect
   * that's specifically designed to do exactly that — not a general
   * escape hatch every effect gets by default.
   */
  pendingActions?: PendingActionRegistry;
}

export type EffectHandler = (ctx: ResolvedActionContext, api: ActionApi) => void;

export class EffectHandlerRegistry {
  private handlers = new Map<string, EffectHandler>();

  register(name: string, handler: EffectHandler): void {
    this.handlers.set(name, handler);
  }

  get(name: string): EffectHandler | undefined {
    return this.handlers.get(name);
  }
}
