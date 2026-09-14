/**
 * Layer 5 — RuleEngine.
 *
 * Subscribes once, to every event (bus.onAny), rather than resubscribing
 * per trigger type whenever bindings change — simpler and always correct
 * regardless of when rules are added/removed, at the cost of one table
 * lookup per event, which is cheap.
 */

import type { EntityStore } from "../events/entity-store.ts";
import type { EventBus } from "../events/bus.ts";
import type { GameEvent } from "../events/types.ts";
import type { ModifierStore } from "../properties/modifier-store.ts";
import type { PropertyResolver } from "../properties/property-resolver.ts";
import type { SeededRandom } from "../persistence/seeded-random.ts";
import { makeRandomFor, type RandomRegistry } from "../persistence/random-registry.ts";
import { evaluateBoolExpr } from "../query/interpreter.ts";
import type { RuleHandlerRegistry } from "./rule-handler.ts";
import type { RuleTable } from "./rule-table.ts";

export class RuleEngine {
  constructor(
    private readonly ruleTable: RuleTable,
    private readonly handlers: RuleHandlerRegistry,
    private readonly entities: EntityStore,
    private readonly modifiers: ModifierStore,
    private readonly resolver: PropertyResolver,
    private readonly random: SeededRandom,
    /** Only needed if a rule handler calls api.randomFor(domain) — see RandomRegistry. */
    private readonly randomRegistry?: RandomRegistry,
  ) {}

  /** Subscribes to the bus. Returns an unsubscribe function. */
  wire(bus: EventBus): () => void {
    return bus.onAny((event) => this.handleEvent(event));
  }

  private handleEvent(event: GameEvent): void {
    const bindings = this.ruleTable.getForTrigger(event.type);
    for (const binding of bindings) {
      // Type-erasure boundary (see rule-table.ts): safe because
      // getForTrigger already filtered to binding.trigger === event.type.
      if (binding.match && !binding.match(event as never)) continue;

      if (binding.condition) {
        const subjectId = binding.subject?.(event as never);
        if (subjectId === undefined) continue;
        if (!this.entities.get(subjectId)) continue;
        if (!evaluateBoolExpr(binding.condition, subjectId, this.resolver)) continue;
      }

      const handler = this.handlers.get(binding.effect);
      if (!handler) {
        throw new Error(`No rule handler registered for "${binding.effect}"`);
      }
      handler(event, { entities: this.entities, modifiers: this.modifiers, resolver: this.resolver, random: this.random, randomFor: makeRandomFor(this.randomRegistry) });
    }
  }
}
