import { describe, expect, it, vi } from "vitest";
import { createCard, createZone } from "../core/entity.ts";
import { EventBus } from "../events/bus.ts";
import { EntityStore } from "../events/entity-store.ts";
import { wireQuerySubscriptions } from "../events/subscriptions-wiring.ts";
import { evaluateNumExpr, extractNumExprDependencies, evaluateBoolExpr } from "../query/interpreter.ts";
import { SubscriptionRegistry } from "../query/subscriptions.ts";
import type { NumExpr, BoolExpr } from "../query/types.ts";
import { applyModifier, newModifierId, type Modifier } from "../properties/modifier.ts";
import { ModifierStore } from "../properties/modifier-store.ts";
import { PropertyResolver } from "../properties/property-resolver.ts";
import { PropertyBoundsRegistry } from "../properties/property-bounds.ts";

function makeModifier(overrides: Partial<Modifier> & Pick<Modifier, "targetEntityId" | "prop" | "op" | "value">): Modifier {
  return {
    id: newModifierId(),
    priority: 0,
    source: "test",
    ...overrides,
  };
}

describe("applyModifier", () => {
  it("add / multiply / set", () => {
    const add: Modifier = makeModifier({ targetEntityId: "x", prop: "p", op: "add", value: 3 });
    const mul: Modifier = makeModifier({ targetEntityId: "x", prop: "p", op: "multiply", value: 2 });
    const set: Modifier = makeModifier({ targetEntityId: "x", prop: "p", op: "set", value: 7 });

    expect(applyModifier(5, add)).toBe(8);
    expect(applyModifier(5, mul)).toBe(10);
    expect(applyModifier(5, set)).toBe(7);
  });
});

describe("ModifierStore", () => {
  it("indexes modifiers by (entity, prop) and sorts by priority", () => {
    const store = new ModifierStore(new EventBus());
    const low = makeModifier({ targetEntityId: "card-1", prop: "outflow", op: "add", value: 1, priority: 50 });
    const high = makeModifier({ targetEntityId: "card-1", prop: "outflow", op: "add", value: 2, priority: 10 });
    const otherProp = makeModifier({ targetEntityId: "card-1", prop: "inflow", op: "add", value: 99, priority: 0 });

    store.add(low);
    store.add(high);
    store.add(otherProp);

    const mods = store.getModifiersFor("card-1", "outflow");
    expect(mods.map((m) => m.id)).toEqual([high.id, low.id]); // priority 10 before 50
  });

  it("remove() drops the modifier from the index", () => {
    const store = new ModifierStore(new EventBus());
    const mod = makeModifier({ targetEntityId: "card-1", prop: "outflow", op: "add", value: 1 });
    store.add(mod);
    expect(store.getModifiersFor("card-1", "outflow")).toHaveLength(1);

    store.remove(mod.id);
    expect(store.getModifiersFor("card-1", "outflow")).toHaveLength(0);
    expect(store.get(mod.id)).toBeUndefined();
  });

  it("emits modifier:added and modifier:removed", () => {
    const bus = new EventBus();
    const store = new ModifierStore(bus);
    const added = vi.fn();
    const removed = vi.fn();
    bus.on("modifier:added", added);
    bus.on("modifier:removed", removed);

    const mod = makeModifier({ targetEntityId: "card-1", prop: "outflow", op: "add", value: 1 });
    store.add(mod);
    store.remove(mod.id);

    expect(added).toHaveBeenCalledWith({ type: "modifier:added", modifier: mod });
    expect(removed).toHaveBeenCalledWith({ type: "modifier:removed", modifier: mod });
  });
});

describe("PropertyResolver", () => {
  it("resolves base value with no modifiers", () => {
    const bus = new EventBus();
    const entities = new EntityStore(bus);
    const modifiers = new ModifierStore(bus);
    const resolver = new PropertyResolver(entities, modifiers);

    const card = createCard("Fence", { properties: { outflow: 4 } });
    entities.add(card);

    expect(resolver.getProperty(card.id, "outflow")).toBe(4);
  });

  it("applies additive then multiplicative then set, in priority order regardless of insertion order", () => {
    const bus = new EventBus();
    const entities = new EntityStore(bus);
    const modifiers = new ModifierStore(bus);
    const resolver = new PropertyResolver(entities, modifiers);

    const card = createCard("Fence", { properties: { outflow: 4 } });
    entities.add(card);

    // insert out of priority order on purpose
    modifiers.add(makeModifier({ targetEntityId: card.id, prop: "outflow", op: "multiply", value: 2, priority: 100 }));
    modifiers.add(makeModifier({ targetEntityId: card.id, prop: "outflow", op: "add", value: 3, priority: 0 }));

    // (4 + 3) * 2 = 14, not 4*2+3=11 — priority governs order, not insertion order
    expect(resolver.getProperty(card.id, "outflow")).toBe(14);
  });

  it("a late 'set' overrides everything before it, but not modifiers after it", () => {
    const bus = new EventBus();
    const entities = new EntityStore(bus);
    const modifiers = new ModifierStore(bus);
    const resolver = new PropertyResolver(entities, modifiers);

    const card = createCard("Fence", { properties: { outflow: 4 } });
    entities.add(card);

    modifiers.add(makeModifier({ targetEntityId: card.id, prop: "outflow", op: "add", value: 100, priority: 0 }));
    modifiers.add(makeModifier({ targetEntityId: card.id, prop: "outflow", op: "set", value: 1, priority: 200 }));
    modifiers.add(makeModifier({ targetEntityId: card.id, prop: "outflow", op: "add", value: 5, priority: 300 }));

    expect(resolver.getProperty(card.id, "outflow")).toBe(6); // set clobbers the +100, then +5 still applies after
  });

  it("resolves to 0 for a property with no base and no modifiers", () => {
    const bus = new EventBus();
    const entities = new EntityStore(bus);
    const modifiers = new ModifierStore(bus);
    const resolver = new PropertyResolver(entities, modifiers);

    const card = createCard("Fence");
    entities.add(card);
    expect(resolver.getProperty(card.id, "reputation")).toBe(0);
  });

  it("removing a modifier reverts the resolved value", () => {
    const bus = new EventBus();
    const entities = new EntityStore(bus);
    const modifiers = new ModifierStore(bus);
    const resolver = new PropertyResolver(entities, modifiers);

    const card = createCard("Fence", { properties: { outflow: 4 } });
    entities.add(card);

    const debuff = makeModifier({ targetEntityId: card.id, prop: "outflow", op: "add", value: 10 });
    modifiers.add(debuff);
    expect(resolver.getProperty(card.id, "outflow")).toBe(14);

    modifiers.remove(debuff.id);
    expect(resolver.getProperty(card.id, "outflow")).toBe(4);
  });
});

describe("PropertyResolver: property bounds", () => {
  it("clamps to a static max/min", () => {
    const bus = new EventBus();
    const entities = new EntityStore(bus);
    const modifiers = new ModifierStore(bus);
    const bounds = new PropertyBoundsRegistry();
    bounds.set("health", { min: 0, max: 10 });
    const resolver = new PropertyResolver(entities, modifiers, undefined, bounds);

    const card = createCard("X", { properties: { health: 5 } });
    entities.add(card);

    modifiers.add({ id: newModifierId(), targetEntityId: card.id, prop: "health", op: "add", value: 100, priority: 0, source: "t" });
    expect(resolver.getProperty(card.id, "health")).toBe(10); // clamped to max

    modifiers.add({ id: newModifierId(), targetEntityId: card.id, prop: "health", op: "add", value: -1000, priority: 1, source: "t" });
    expect(resolver.getProperty(card.id, "health")).toBe(0); // clamped to min
  });

  it("clamps against another property's LIVE value — outflow can never exceed inflow", () => {
    const bus = new EventBus();
    const entities = new EntityStore(bus);
    const modifiers = new ModifierStore(bus);
    const bounds = new PropertyBoundsRegistry();
    bounds.set("outflow", { max: { refProp: "inflow" } });
    const resolver = new PropertyResolver(entities, modifiers, undefined, bounds);

    const fixer = createCard("Fixer", { properties: { inflow: 5, outflow: 8 } });
    entities.add(fixer);

    expect(resolver.getProperty(fixer.id, "outflow")).toBe(5); // capped at inflow, not the base 8

    entities.setProperty(fixer.id, "inflow", 12);
    expect(resolver.getProperty(fixer.id, "outflow")).toBe(8); // base is under the new, higher cap — uncapped
  });

  it("throws a clear error on a bound-reference cycle instead of infinite recursion", () => {
    const bus = new EventBus();
    const entities = new EntityStore(bus);
    const modifiers = new ModifierStore(bus);
    const bounds = new PropertyBoundsRegistry();
    bounds.set("a", { max: { refProp: "b" } });
    bounds.set("b", { max: { refProp: "a" } });
    const resolver = new PropertyResolver(entities, modifiers, undefined, bounds);

    const card = createCard("X", { properties: { a: 1, b: 1 } });
    entities.add(card);

    expect(() => resolver.getProperty(card.id, "a")).toThrow(/cycle detected/);
  });

  it("properties with no registered bound are unaffected", () => {
    const bus = new EventBus();
    const entities = new EntityStore(bus);
    const modifiers = new ModifierStore(bus);
    const bounds = new PropertyBoundsRegistry();
    bounds.set("outflow", { max: { refProp: "inflow" } });
    const resolver = new PropertyResolver(entities, modifiers, undefined, bounds);

    const card = createCard("X", { properties: { inflow: 1000 } });
    entities.add(card);
    expect(resolver.getProperty(card.id, "inflow")).toBe(1000);
  });
});

describe("Layer 1 queries transparently see resolved values through PropertyResolver", () => {
  it("an outflow aggregate reflects a debuff on one contractor without the query tree changing", () => {
    const bus = new EventBus();
    const entities = new EntityStore(bus);
    const modifiers = new ModifierStore(bus);
    const resolver = new PropertyResolver(entities, modifiers);

    const board = createZone();
    entities.add(board);

    const fence = createCard("Fence", { zoneId: board.id, properties: { outflow: 5 } });
    fence.tags.add("contractor");
    const runner = createCard("Runner", { zoneId: board.id, properties: { outflow: 3 } });
    runner.tags.add("contractor");
    entities.add(fence);
    entities.add(runner);

    const where: BoolExpr = { op: "and", exprs: [{ op: "inZone", zoneId: board.id }, { op: "hasTag", tag: "contractor" }] };
    const outflowAgg: NumExpr = { op: "fold", fold: "sum", of: { op: "prop", name: "outflow" }, where };

    expect(evaluateNumExpr(outflowAgg, board.id, resolver)).toBe(8);

    // apply a "retainer hike" debuff to one contractor
    modifiers.add(makeModifier({ targetEntityId: fence.id, prop: "outflow", op: "add", value: 4, priority: 0, source: "retainer-hike" }));

    expect(evaluateNumExpr(outflowAgg, board.id, resolver)).toBe(12);

    // raw base is untouched — this proves the modifier layer is non-destructive
    expect(fence.properties.outflow).toBe(5);
    expect(evaluateNumExpr(outflowAgg, board.id, entities)).toBe(8); // querying the raw EntityStore still sees base values
  });

  it("compare (e.g. an outflow > inflow gate) sees resolved values too", () => {
    const bus = new EventBus();
    const entities = new EntityStore(bus);
    const modifiers = new ModifierStore(bus);
    const resolver = new PropertyResolver(entities, modifiers);

    const card = createCard("Fence", { properties: { outflow: 5 } });
    entities.add(card);

    const gate: BoolExpr = { op: "compare", left: { op: "prop", name: "outflow" }, cmp: "gt", right: { op: "lit", value: 10 } };
    expect(evaluateBoolExpr(gate, card.id, resolver)).toBe(false);

    modifiers.add(makeModifier({ targetEntityId: card.id, prop: "outflow", op: "add", value: 10 }));
    expect(evaluateBoolExpr(gate, card.id, resolver)).toBe(true);
  });
});

describe("end-to-end: adding/removing a modifier triggers query recompute via the bus", () => {
  it("recomputes an outflow aggregate automatically on modifier add and remove", () => {
    const bus = new EventBus();
    const entities = new EntityStore(bus);
    const modifiers = new ModifierStore(bus);
    const resolver = new PropertyResolver(entities, modifiers);
    const registry = new SubscriptionRegistry();
    wireQuerySubscriptions(bus, registry);

    const board = createZone();
    entities.add(board);
    const fence = createCard("Fence", { zoneId: board.id, properties: { outflow: 5 } });
    fence.tags.add("contractor");
    entities.add(fence);

    const where: BoolExpr = { op: "and", exprs: [{ op: "inZone", zoneId: board.id }, { op: "hasTag", tag: "contractor" }] };
    const outflowAgg: NumExpr = { op: "fold", fold: "sum", of: { op: "prop", name: "outflow" }, where };
    const deps = extractNumExprDependencies(outflowAgg);

    let lastComputed = evaluateNumExpr(outflowAgg, board.id, resolver);
    const recompute = vi.fn(() => {
      lastComputed = evaluateNumExpr(outflowAgg, board.id, resolver);
    });
    registry.subscribe(deps, recompute);

    const debuff = makeModifier({ targetEntityId: fence.id, prop: "outflow", op: "add", value: 4 });
    modifiers.add(debuff);
    expect(recompute).toHaveBeenCalledTimes(1);
    expect(lastComputed).toBe(9);

    modifiers.remove(debuff.id);
    expect(recompute).toHaveBeenCalledTimes(2);
    expect(lastComputed).toBe(5);
  });
});

describe("ModifierStore — 'Orphaned Debuff': does removing an entity clean up modifiers that were targeting it?", () => {
  it("YES — ModifierStore listens for entity:removed on its own bus and cleans up every modifier still targeting that entity, rather than leaving an orphaned leak that accumulates in getAll() (and therefore in every future Snapshot) forever", () => {
    const bus = new EventBus();
    const entities = new EntityStore(bus);
    const modifiers = new ModifierStore(bus);
    const card = createCard("Ephemeral card", { id: "ephemeral" });
    entities.add(card);
    const debuff = makeModifier({ targetEntityId: "ephemeral", prop: "power", op: "add", value: -2 });
    modifiers.add(debuff);
    expect(modifiers.get(debuff.id)).toBeDefined();

    entities.remove("ephemeral");

    expect(modifiers.get(debuff.id)).toBeUndefined();
    expect(modifiers.getAll()).not.toContainEqual(debuff);
  });

  it("cleans up MULTIPLE modifiers targeting the same removed entity, across different properties — not just the first one found", () => {
    const bus = new EventBus();
    const entities = new EntityStore(bus);
    const modifiers = new ModifierStore(bus);
    entities.add(createCard("Ephemeral card", { id: "ephemeral" }));
    const powerDebuff = makeModifier({ targetEntityId: "ephemeral", prop: "power", op: "add", value: -2 });
    const toughnessBuff = makeModifier({ targetEntityId: "ephemeral", prop: "toughness", op: "add", value: 3 });
    modifiers.add(powerDebuff);
    modifiers.add(toughnessBuff);

    entities.remove("ephemeral");

    expect(modifiers.get(powerDebuff.id)).toBeUndefined();
    expect(modifiers.get(toughnessBuff.id)).toBeUndefined();
  });

  it("leaves modifiers targeting OTHER, still-existing entities completely untouched — the cleanup is scoped precisely to the removed entity, not a blanket sweep", () => {
    const bus = new EventBus();
    const entities = new EntityStore(bus);
    const modifiers = new ModifierStore(bus);
    entities.add(createCard("Ephemeral card", { id: "ephemeral" }));
    entities.add(createCard("Survives", { id: "survivor" }));
    const removedTarget = makeModifier({ targetEntityId: "ephemeral", prop: "power", op: "add", value: -2 });
    const survivingTarget = makeModifier({ targetEntityId: "survivor", prop: "power", op: "add", value: 5 });
    modifiers.add(removedTarget);
    modifiers.add(survivingTarget);

    entities.remove("ephemeral");

    expect(modifiers.get(removedTarget.id)).toBeUndefined();
    expect(modifiers.get(survivingTarget.id)).toEqual(survivingTarget); // completely unaffected
  });

  it("removing an entity that was never modified at all is a normal, harmless no-op — no error, nothing to clean up", () => {
    const bus = new EventBus();
    const entities = new EntityStore(bus);
    const modifiers = new ModifierStore(bus);
    entities.add(createCard("Never modified", { id: "plain" }));
    expect(() => entities.remove("plain")).not.toThrow();
  });
});
