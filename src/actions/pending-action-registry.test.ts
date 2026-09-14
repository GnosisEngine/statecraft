import { describe, expect, it } from "vitest";
import { PendingActionRegistry } from "./pending-action-registry.ts";
import type { ActionDefinition, ActionContext } from "./action-definition.ts";
import { EventBus } from "../events/bus.ts";
import { EntityStore } from "../events/entity-store.ts";
import { Hierarchy } from "../events/hierarchy.ts";
import { Stack } from "../events/stack.ts";
import { ModifierStore } from "../properties/modifier-store.ts";
import { PropertyResolver } from "../properties/property-resolver.ts";
import { SeededRandom } from "../persistence/seeded-random.ts";
import { createCard } from "../core/entity.ts";
import { createSnapshot, restoreSnapshot } from "../persistence/snapshot.ts";
import { EffectHandlerRegistry } from "./effect-handler.ts";
import { resolveEffect, type PerformActionDeps } from "./pipeline.ts";

function makeAction(overrides: Partial<ActionDefinition> = {}): ActionDefinition {
  return {
    id: "test-action",
    category: () => "test",
    targetsOwn: true,
    targetsOthers: true,
    targetQuery: () => ({ op: "and", exprs: [] }),
    effect: "testEffect",
    ...overrides,
  };
}

describe("PendingActionRegistry", () => {
  it("round-trips a set entry through get", () => {
    const registry = new PendingActionRegistry();
    const intent: ActionContext = { performerId: "card-1", actingFixerId: "fixer-A", targetIds: ["target-1"] };
    const definition = makeAction();
    registry.set("pending-1", { intent, actionId: "test-action", definition, capability: "neutral", adjustedCost: 4 });

    const result = registry.get("pending-1");
    expect(result).toEqual({ intent, actionId: "test-action", definition, capability: "neutral", adjustedCost: 4 });
  });

  it("get returns undefined for an id that was never set", () => {
    const registry = new PendingActionRegistry();
    expect(registry.get("nonexistent")).toBeUndefined();
  });

  it("has reflects presence correctly", () => {
    const registry = new PendingActionRegistry();
    expect(registry.has("pending-1")).toBe(false);
    registry.set("pending-1", { intent: { performerId: "a", actingFixerId: "fixer-A", targetIds: [] }, actionId: "test-action", definition: makeAction(), capability: "neutral", adjustedCost: 0 });
    expect(registry.has("pending-1")).toBe(true);
  });

  it("delete removes the entry — a subsequent get returns undefined and has returns false", () => {
    const registry = new PendingActionRegistry();
    registry.set("pending-1", { intent: { performerId: "a", actingFixerId: "fixer-A", targetIds: [] }, actionId: "test-action", definition: makeAction(), capability: "neutral", adjustedCost: 0 });
    registry.delete("pending-1");
    expect(registry.get("pending-1")).toBeUndefined();
    expect(registry.has("pending-1")).toBe(false);
  });

  it("tracks multiple pending entries independently, keyed by id", () => {
    const registry = new PendingActionRegistry();
    registry.set("pending-1", { intent: { performerId: "a", actingFixerId: "fixer-A", targetIds: [] }, actionId: "action-a", definition: makeAction({ id: "action-a" }), capability: "neutral", adjustedCost: 1 });
    registry.set("pending-2", { intent: { performerId: "b", actingFixerId: "fixer-B", targetIds: [] }, actionId: "action-b", definition: makeAction({ id: "action-b" }), capability: "preferred", adjustedCost: 2 });

    expect(registry.get("pending-1")?.definition.id).toBe("action-a");
    expect(registry.get("pending-2")?.definition.id).toBe("action-b");

    registry.delete("pending-1");
    expect(registry.get("pending-1")).toBeUndefined();
    expect(registry.get("pending-2")?.definition.id).toBe("action-b"); // untouched by deleting the other one
  });
});

describe("'Ghost in the Machine', fixed: PendingActionRegistry now survives a Snapshot correctly", () => {
  it("serialize()/loadRaw() round-trip directly: definition is re-derived via the lookup function, not expected to have survived serialization itself", () => {
    const registry = new PendingActionRegistry();
    const intent: ActionContext = { performerId: "ace", actingFixerId: "fixer-A", targetIds: ["runner"], params: { abilityId: "shakedown" } };
    const definition = makeAction({ id: "activate" });
    registry.set("pending-0", { intent, actionId: "activate", definition, capability: "preferred", adjustedCost: 2 });

    const serialized = registry.serialize();
    // no function fields anywhere — genuinely JSON-safe
    expect(() => JSON.stringify(serialized)).not.toThrow();
    expect(JSON.parse(JSON.stringify(serialized))).toEqual(serialized);

    const restored = new PendingActionRegistry();
    restored.loadRaw(serialized, (actionId) => (actionId === "activate" ? definition : undefined));

    expect(restored.get("pending-0")).toEqual({ intent, actionId: "activate", definition, capability: "preferred", adjustedCost: 2 });
  });

  it("loadRaw throws immediately, naming both the actionId and the pending item, if the lookup function can't find a definition — 'the game's own action registry changed shape since this snapshot was taken'", () => {
    const registry = new PendingActionRegistry();
    registry.set("pending-0", {
      intent: { performerId: "ace", actingFixerId: "fixer-A", targetIds: [] },
      actionId: "removed-action",
      definition: makeAction({ id: "removed-action" }),
      capability: "neutral",
      adjustedCost: 0,
    });
    const serialized = registry.serialize();

    const restored = new PendingActionRegistry();
    expect(() => restored.loadRaw(serialized, () => undefined)).toThrow(/no action registered for "removed-action".*pending-0/s);
  });

  it("full Snapshot round-trip: propose something, snapshot, restore into completely fresh stores, and the restored entry is correct enough for resolveEffect to actually run it end to end", () => {
    const bus = new EventBus();
    const entities = new EntityStore(bus);
    const modifiers = new ModifierStore(bus);
    const resolver = new PropertyResolver(entities, modifiers);
    const random = new SeededRandom(1);
    const hierarchy = new Hierarchy("resolution", bus);
    entities.add(createCard("Table", { id: "table" }));
    const stack = new Stack(hierarchy, entities, bus, "table");
    const handlers = new EffectHandlerRegistry();
    const shakedownLikeEffect = makeAction({ id: "activate", effect: "tagTargetEffect" });
    handlers.register("tagTargetEffect", (ctx, api) => {
      api.entities.addTag(ctx.targetIds[0]!, "shaken");
    });
    const deps: PerformActionDeps = { entities, resolver, modifiers, handlers, bus, random };

    entities.add(createCard("Ace", { id: "ace", ownership: ["fixer-A"] }));
    entities.add(createCard("Runner", { id: "runner", ownership: ["fixer-B"] }));
    entities.add(createCard("Pending: activate", { id: "pending-0", ownership: ["fixer-A"] }));
    stack.push("pending-0", null);

    const registry = new PendingActionRegistry();
    const intent: ActionContext = { performerId: "ace", actingFixerId: "fixer-A", targetIds: ["runner"], params: { abilityId: "shakedown" } };
    registry.set("pending-0", { intent, actionId: "activate", definition: shakedownLikeEffect, capability: "preferred", adjustedCost: 2 });

    const snapshot = createSnapshot(entities, modifiers, 0, [hierarchy], [stack], registry);

    // completely fresh stores — nothing shared with the live side above
    const freshBus = new EventBus();
    const freshEntities = new EntityStore(freshBus);
    const freshModifiers = new ModifierStore(freshBus);
    const freshResolver = new PropertyResolver(freshEntities, freshModifiers);
    const freshHierarchy = new Hierarchy("resolution", freshBus);
    const freshStack = new Stack(freshHierarchy, freshEntities, freshBus, "table");
    const freshRegistry = new PendingActionRegistry();
    const freshHandlers = new EffectHandlerRegistry();
    freshHandlers.register("tagTargetEffect", (ctx, api) => {
      api.entities.addTag(ctx.targetIds[0]!, "shaken");
    });
    const freshDeps: PerformActionDeps = { entities: freshEntities, resolver: freshResolver, modifiers: freshModifiers, handlers: freshHandlers, bus: freshBus, random: new SeededRandom(1) };

    restoreSnapshot(snapshot, freshEntities, freshModifiers, [freshHierarchy], [freshStack], freshRegistry, (actionId) => (actionId === "activate" ? shakedownLikeEffect : undefined));

    const restoredPending = freshRegistry.get("pending-0");
    expect(restoredPending).toBeDefined();
    expect(restoredPending!.actionId).toBe("activate");
    expect(restoredPending!.intent).toEqual(intent);

    // the actual proof: resolve it, using ONLY what survived the snapshot
    resolveEffect(restoredPending!.intent, restoredPending!.definition, restoredPending!.capability, restoredPending!.adjustedCost, freshDeps);
    expect(freshEntities.get("runner")?.tags.has("shaken")).toBe(true);
  });

  it("restoreSnapshot throws if the snapshot has pending actions but no registry is provided to restore into", () => {
    const bus = new EventBus();
    const entities = new EntityStore(bus);
    const modifiers = new ModifierStore(bus);
    const hierarchy = new Hierarchy("resolution", bus);
    entities.add(createCard("Table", { id: "table" }));
    const stack = new Stack(hierarchy, entities, bus, "table");
    entities.add(createCard("Pending", { id: "pending-0" }));
    stack.push("pending-0", null);
    const registry = new PendingActionRegistry();
    registry.set("pending-0", {
      intent: { performerId: "x", actingFixerId: "fixer-A", targetIds: [] },
      actionId: "activate",
      definition: makeAction({ id: "activate" }),
      capability: "neutral",
      adjustedCost: 0,
    });
    const snapshot = createSnapshot(entities, modifiers, 0, [hierarchy], [stack], registry);

    expect(() =>
      restoreSnapshot(snapshot, new EntityStore(new EventBus()), new ModifierStore(new EventBus()), [new Hierarchy("resolution", new EventBus())], [new Stack(new Hierarchy("resolution", new EventBus()), new EntityStore(new EventBus()), new EventBus(), "x")], null, () => undefined),
    ).toThrow(/no PendingActionRegistry was provided/);
  });

  it("the integrity check fires if a restored pending action doesn't correspond to anything any restored Stack still considers pending — the snapshot's own Stack and PendingActionRegistry data have drifted out of sync", () => {
    const bus = new EventBus();
    const entities = new EntityStore(bus);
    const modifiers = new ModifierStore(bus);
    const hierarchy = new Hierarchy("resolution", bus);
    entities.add(createCard("Table", { id: "table" }));
    const stack = new Stack(hierarchy, entities, bus, "table");
    // deliberately DON'T push anything — the stack stays empty
    const registry = new PendingActionRegistry();
    registry.set("orphaned-item", {
      intent: { performerId: "x", actingFixerId: "fixer-A", targetIds: [] },
      actionId: "activate",
      definition: makeAction({ id: "activate" }),
      capability: "neutral",
      adjustedCost: 0,
    });
    // hand-construct a snapshot where the registry has an entry the
    // stack itself never actually has pending — simulating corrupted
    // or mismatched snapshot data rather than reproducing it via the
    // normal push/set flow, since that flow wouldn't let this happen
    const snapshot = createSnapshot(entities, modifiers, 0, [hierarchy], [stack], registry);

    const freshHierarchy = new Hierarchy("resolution", new EventBus());
    const freshBus2 = new EventBus();
    const freshEntities2 = new EntityStore(freshBus2);
    const freshStack = new Stack(freshHierarchy, freshEntities2, freshBus2, "table2");
    freshEntities2.add(createCard("Table2", { id: "table2" }));
    const freshRegistry = new PendingActionRegistry();

    expect(() =>
      restoreSnapshot(snapshot, freshEntities2, new ModifierStore(freshBus2), [freshHierarchy], [freshStack], freshRegistry, (actionId) => (actionId === "activate" ? makeAction({ id: "activate" }) : undefined)),
    ).toThrow(/no restored Stack considers it currently pending/);
  });
});

