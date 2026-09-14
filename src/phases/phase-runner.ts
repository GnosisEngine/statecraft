/**
 * Layer 6 — PhaseRunner.
 *
 * Runs ONE phase instance: start -> (world state changes, gate re-checked
 * via the same query-dependency-subscription machinery Layer 3's
 * aggregate properties use) -> end. This is deliberately the only
 * "a phase that runs until its gate is satisfied" mechanism in the
 * engine — TurnCycle uses it for each repeating phase, and Match (see
 * match.ts) uses it directly for the one-shot pregame/postgame stages.
 * Nothing here is turn-cycle-specific.
 */

import type { EntityId } from "../core/id.ts";
import type { EntityStore } from "../events/entity-store.ts";
import type { EventBus } from "../events/bus.ts";
import type { ModifierStore } from "../properties/modifier-store.ts";
import type { PropertyResolver } from "../properties/property-resolver.ts";
import type { SeededRandom } from "../persistence/seeded-random.ts";
import { makeRandomFor, type RandomRegistry } from "../persistence/random-registry.ts";
import { evaluateBoolExpr, extractBoolExprDependencies } from "../query/interpreter.ts";
import type { QueryFunctionRegistry } from "../query/functions.ts";
import type { HierarchyRegistry } from "../query/hierarchy-registry.ts";
import type { SubscriptionRegistry } from "../query/subscriptions.ts";
import type { PhaseDefinition, PhaseHandlerRegistry } from "./phase-definition.ts";

export interface PhaseRunnerDeps {
  entities: EntityStore;
  modifiers: ModifierStore;
  random: SeededRandom;
  /** Only needed if an onStart/onChange/onEnd handler calls api.randomFor(domain) — see RandomRegistry. */
  randomRegistry?: RandomRegistry;
  resolver: PropertyResolver;
  registry: SubscriptionRegistry;
  handlers: PhaseHandlerRegistry;
  bus: EventBus;
  /** Only needed if a phase's completionGate uses the `call` op — extractBoolExprDependencies throws on `call` without it, rather than silently under-subscribing. */
  queryFunctions?: QueryFunctionRegistry;
  /** Only needed if a phase's completionGate uses `childOf`/`descendantOf` — same reasoning as queryFunctions above. */
  hierarchies?: HierarchyRegistry;
}

export class PhaseRunner {
  private gateSubscription: { unsubscribe(): void } | null = null;
  private lastGateValue = false;

  constructor(
    private readonly phase: PhaseDefinition,
    private readonly subjectId: EntityId,
    private readonly deps: PhaseRunnerDeps,
  ) {}

  private evaluateGate(): boolean {
    if (!this.deps.entities.get(this.subjectId)) return false;
    return evaluateBoolExpr(this.phase.completionGate, this.subjectId, this.deps.resolver);
  }

  private runHandler(name: string | undefined): void {
    if (!name) return;
    const handler = this.deps.handlers.get(name);
    if (!handler) throw new Error(`No phase handler registered for "${name}"`);
    handler(
      { phaseId: this.phase.id, subjectId: this.subjectId },
      { entities: this.deps.entities, modifiers: this.deps.modifiers, resolver: this.deps.resolver, random: this.deps.random, randomFor: makeRandomFor(this.deps.randomRegistry) },
    );
  }

  /** Runs onStart, emits phase:started, and begins watching the completion gate for changes. */
  start(): void {
    this.runHandler(this.phase.onStart);
    this.deps.bus.emit({ type: "phase:started", phaseId: this.phase.id, subjectId: this.subjectId });

    this.lastGateValue = this.evaluateGate();
    const depKeys = extractBoolExprDependencies(this.phase.completionGate, undefined, this.deps.queryFunctions, undefined, this.deps.hierarchies);
    this.gateSubscription = this.deps.registry.subscribe(depKeys, () => {
      const newValue = this.evaluateGate();
      if (newValue !== this.lastGateValue) {
        this.lastGateValue = newValue;
        this.runHandler(this.phase.onChange);
        this.deps.bus.emit({
          type: "phase:gateChanged",
          phaseId: this.phase.id,
          subjectId: this.subjectId,
          satisfied: newValue,
        });
      }
    });
  }

  canEnd(): boolean {
    return this.evaluateGate();
  }

  /** Ends the phase if the gate is satisfied; otherwise a no-op that reports why. This IS what makes a forced phase forced. */
  tryEnd(): { ok: true } | { ok: false; reason: string } {
    if (!this.canEnd()) {
      return { ok: false, reason: `phase "${this.phase.id}" completion gate not satisfied` };
    }
    this.gateSubscription?.unsubscribe();
    this.gateSubscription = null;
    this.runHandler(this.phase.onEnd);
    this.deps.bus.emit({ type: "phase:ended", phaseId: this.phase.id, subjectId: this.subjectId });
    return { ok: true };
  }
}
