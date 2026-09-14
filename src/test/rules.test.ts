import { describe, expect, it, vi } from "vitest";
import { createCard, createHand, createZone } from "../core/entity.ts";
import { EventBus } from "../events/bus.ts";
import { EntityStore } from "../events/entity-store.ts";
import { ModifierStore } from "../properties/modifier-store.ts";
import { PropertyResolver } from "../properties/property-resolver.ts";
import { RuleTable } from "../rules/rule-table.ts";
import { RuleHandlerRegistry } from "../rules/rule-handler.ts";
import { RuleEngine } from "../rules/rule-engine.ts";
import { SeededRandom } from "../persistence/seeded-random.ts";

describe("RuleTable", () => {
  it("getForTrigger filters by trigger and sorts by priority", () => {
    const table = new RuleTable("core-rules");
    table.add({ id: "b", trigger: "entity:tagAdded", effect: "noop", priority: 5 });
    table.add({ id: "a", trigger: "entity:tagAdded", effect: "noop", priority: 1 });
    table.add({ id: "c", trigger: "entity:tagRemoved", effect: "noop" });

    const forTagAdded = table.getForTrigger("entity:tagAdded");
    expect(forTagAdded.map((b) => b.id)).toEqual(["a", "b"]);
    expect(table.getForTrigger("entity:tagRemoved").map((b) => b.id)).toEqual(["c"]);
    expect(table.getForTrigger("entity:zoneChanged")).toEqual([]);
  });

  it("remove drops a binding by id", () => {
    const table = new RuleTable("core-rules");
    table.add({ id: "a", trigger: "entity:tagAdded", effect: "noop" });
    table.remove("a");
    expect(table.getForTrigger("entity:tagAdded")).toEqual([]);
  });

  it("clone() is an independent copy — editing the clone never touches the original", () => {
    const original = new RuleTable("core-rules", 3);
    original.add({ id: "a", trigger: "entity:tagAdded", effect: "noop" });

    const fork = original.clone("fork-rules");
    fork.add({ id: "b", trigger: "entity:tagAdded", effect: "noop" });
    fork.remove("a");

    expect(fork.version).toBe(3);
    expect(fork.getForTrigger("entity:tagAdded").map((b) => b.id)).toEqual(["b"]);
    expect(original.getForTrigger("entity:tagAdded").map((b) => b.id)).toEqual(["a"]); // untouched
  });
});

function makeEngineRig() {
  const bus = new EventBus();
  const entities = new EntityStore(bus);
  const modifiers = new ModifierStore(bus);
  const resolver = new PropertyResolver(entities, modifiers);
  const table = new RuleTable("core-rules");
  const handlers = new RuleHandlerRegistry();
  const engine = new RuleEngine(table, handlers, entities, modifiers, resolver, new SeededRandom(1));
  engine.wire(bus);
  return { bus, entities, modifiers, resolver, table, handlers, engine };
}

describe("RuleEngine: condition gated on entity/world state", () => {
  it("retires a contractor whose inflow drops to zero or below", () => {
    const { entities, resolver, table, handlers } = makeEngineRig();

    handlers.register("retireContractor", (_event, api) => {
      const e = _event as Extract<typeof _event, { type: "entity:propertyChanged" }>;
      api.entities.addTag(e.entityId, "retired");
      api.entities.moveToZone(e.entityId, null);
    });

    table.add({
      id: "retire-on-zero-inflow",
      trigger: "entity:propertyChanged",
      match: (event) => event.prop === "inflow",
      subject: (event) => event.entityId,
      condition: { op: "compare", left: { op: "prop", name: "inflow" }, cmp: "lte", right: { op: "lit", value: 0 } },
      effect: "retireContractor",
    });

    const board = createZone();
    entities.add(board);
    const contractor = createCard("Fence", { zoneId: board.id, properties: { inflow: 3 } });
    entities.add(contractor);

    entities.setProperty(contractor.id, "inflow", 1); // still positive, rule shouldn't fire
    expect(contractor.tags.has("retired")).toBe(false);

    entities.setProperty(contractor.id, "inflow", 0); // now hits the condition
    expect(contractor.tags.has("retired")).toBe(true);
    expect(resolver.getProperty(contractor.id, "inflow")).not.toBeUndefined();
    expect(contractor.zoneId).toBeNull();
  });

  it("skips the rule when subject() resolves to an entity that isn't in the store", () => {
    const { bus, table, handlers } = makeEngineRig();
    const handler = vi.fn();
    handlers.register("noop", handler);

    table.add({
      id: "r",
      trigger: "entity:propertyChanged",
      subject: () => "no-such-entity",
      condition: { op: "compare", left: { op: "prop", name: "inflow" }, cmp: "lte", right: { op: "lit", value: 0 } },
      effect: "noop",
    });

    bus.emit({ type: "entity:propertyChanged", entityId: "irrelevant", prop: "inflow", oldValue: 1, newValue: 0 });
    expect(handler).not.toHaveBeenCalled();
  });

  it("skips the rule when subject() itself returns undefined", () => {
    const { bus, table, handlers } = makeEngineRig();
    const handler = vi.fn();
    handlers.register("noop", handler);

    table.add({
      id: "r",
      trigger: "entity:propertyChanged",
      subject: () => undefined,
      condition: { op: "compare", left: { op: "prop", name: "inflow" }, cmp: "lte", right: { op: "lit", value: 0 } },
      effect: "noop",
    });

    bus.emit({ type: "entity:propertyChanged", entityId: "irrelevant", prop: "inflow", oldValue: 1, newValue: 0 });
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("RuleEngine: match gated on the event's own fields", () => {
  it("grants a reputation bonus only for a specific actionId + capability combination", () => {
    const { bus, entities, table, handlers } = makeEngineRig();

    handlers.register("grantReputationBonus", (event, api) => {
      const e = event as Extract<typeof event, { type: "action:resolved" }>;
      const current = api.entities.get(e.actingFixerId)?.properties.reputation ?? 0;
      api.entities.setProperty(e.actingFixerId, "reputation", current + 1);
    });

    table.add({
      id: "shakedown-preferred-bonus",
      trigger: "action:resolved",
      match: (event) => event.actionId === "shakedown" && event.capability === "preferred",
      effect: "grantReputationBonus",
    });

    const fixer = createHand([], { id: "fixer-A", properties: { reputation: 0 } });
    entities.add(fixer);

    // capability "neutral" — match fails, no bonus
    bus.emit({
      type: "action:resolved",
      actionId: "shakedown",
      performerId: "performer-1",
      actingFixerId: "fixer-A",
      targetIds: [],
      capability: "neutral",
      adjustedCost: 4,
    });
    expect(fixer.properties.reputation).toBe(0);

    // capability "preferred" — match passes, bonus applied
    bus.emit({
      type: "action:resolved",
      actionId: "shakedown",
      performerId: "performer-1",
      actingFixerId: "fixer-A",
      targetIds: [],
      capability: "preferred",
      adjustedCost: 2,
    });
    expect(fixer.properties.reputation).toBe(1);

    // different actionId entirely — match fails, no bonus
    bus.emit({
      type: "action:resolved",
      actionId: "bribe",
      performerId: "performer-1",
      actingFixerId: "fixer-A",
      targetIds: [],
      capability: "preferred",
      adjustedCost: 1,
    });
    expect(fixer.properties.reputation).toBe(1);
  });
});

describe("RuleEngine: ordering and error handling", () => {
  it("fires multiple bindings on the same trigger in priority order", () => {
    const { bus, table, handlers } = makeEngineRig();
    const calls: string[] = [];
    handlers.register("recordSecond", () => calls.push("second"));
    handlers.register("recordFirst", () => calls.push("first"));

    table.add({ id: "b", trigger: "entity:tagAdded", effect: "recordSecond", priority: 10 });
    table.add({ id: "a", trigger: "entity:tagAdded", effect: "recordFirst", priority: 1 });

    bus.emit({ type: "entity:tagAdded", entityId: "x", tag: "t" });
    expect(calls).toEqual(["first", "second"]);
  });

  it("throws a clear error when the effect handler was never registered", () => {
    const { bus, table } = makeEngineRig();
    table.add({ id: "orphan", trigger: "entity:tagAdded", effect: "does-not-exist" });

    expect(() => bus.emit({ type: "entity:tagAdded", entityId: "x", tag: "t" })).toThrow(
      /No rule handler registered/,
    );
  });

  it("does nothing for events with no matching bindings", () => {
    const { bus, table, handlers } = makeEngineRig();
    const handler = vi.fn();
    handlers.register("noop", handler);
    table.add({ id: "r", trigger: "entity:tagAdded", effect: "noop" });

    bus.emit({ type: "entity:tagRemoved", entityId: "x", tag: "t" }); // different trigger
    expect(handler).not.toHaveBeenCalled();
  });
});
