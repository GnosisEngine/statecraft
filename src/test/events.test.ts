import { describe, expect, it, vi } from "vitest";
import { createCard, createZone } from "../core/entity.ts";
import { EventBus } from "../events/bus.ts";
import { EntityStore, UnknownEntityError } from "../events/entity-store.ts";
import { wireQuerySubscriptions } from "../events/subscriptions-wiring.ts";
import { evaluateNumExpr, extractNumExprDependencies } from "../query/interpreter.ts";
import { SubscriptionRegistry } from "../query/subscriptions.ts";
import type { NumExpr } from "../query/types.ts";

describe("EventBus", () => {
  it("dispatches to type-specific handlers only for matching events", () => {
    const bus = new EventBus();
    const created = vi.fn();
    const removed = vi.fn();
    bus.on("entity:created", created);
    bus.on("entity:removed", removed);

    const card = createCard("Razor");
    bus.emit({ type: "entity:created", entity: card });

    expect(created).toHaveBeenCalledTimes(1);
    expect(removed).not.toHaveBeenCalled();
  });

  it("onAny receives every event regardless of type", () => {
    const bus = new EventBus();
    const any = vi.fn();
    bus.on("entity:tagAdded", () => {});
    bus.onAny(any);

    const card = createCard("Razor");
    bus.emit({ type: "entity:created", entity: card });
    bus.emit({ type: "entity:tagAdded", entityId: card.id, tag: "contractor" });

    expect(any).toHaveBeenCalledTimes(2);
  });

  it("unsubscribe stops delivery", () => {
    const bus = new EventBus();
    const handler = vi.fn();
    const off = bus.on("entity:tagAdded", handler);
    off();
    bus.emit({ type: "entity:tagAdded", entityId: "x", tag: "t" });
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("EntityStore", () => {
  it("add/get and emits entity:created", () => {
    const bus = new EventBus();
    const store = new EntityStore(bus);
    const spy = vi.fn();
    bus.on("entity:created", spy);

    const card = createCard("Razor");
    store.add(card);

    expect(store.get(card.id)).toBe(card);
    expect(spy).toHaveBeenCalledWith({ type: "entity:created", entity: card });
  });

  it("throws UnknownEntityError mutating an entity that was never added", () => {
    const store = new EntityStore(new EventBus());
    expect(() => store.addTag("nope", "tag")).toThrow(UnknownEntityError);
  });

  it("tag mutations are idempotent and only emit on actual change", () => {
    const bus = new EventBus();
    const store = new EntityStore(bus);
    const card = createCard("Razor");
    store.add(card);

    const spy = vi.fn();
    bus.on("entity:tagAdded", spy);

    store.addTag(card.id, "contractor");
    store.addTag(card.id, "contractor"); // no-op, already present

    expect(spy).toHaveBeenCalledTimes(1);
    expect(card.tags.has("contractor")).toBe(true);
  });

  it("setProperty only emits when the value actually changes, carries old/new", () => {
    const bus = new EventBus();
    const store = new EntityStore(bus);
    const card = createCard("Razor", { properties: { inflow: 5 } });
    store.add(card);

    const spy = vi.fn();
    bus.on("entity:propertyChanged", spy);

    store.setProperty(card.id, "inflow", 5); // unchanged, no event
    store.setProperty(card.id, "inflow", 8);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith({
      type: "entity:propertyChanged",
      entityId: card.id,
      prop: "inflow",
      oldValue: 5,
      newValue: 8,
    });
  });

  it("moveToZone updates zoneId and emits old/new", () => {
    const bus = new EventBus();
    const store = new EntityStore(bus);
    const zoneA = createZone();
    const zoneB = createZone();
    const card = createCard("Razor", { zoneId: zoneA.id });
    store.add(zoneA);
    store.add(zoneB);
    store.add(card);

    const spy = vi.fn();
    bus.on("entity:zoneChanged", spy);
    store.moveToZone(card.id, zoneB.id);

    expect(card.zoneId).toBe(zoneB.id);
    expect(spy).toHaveBeenCalledWith({
      type: "entity:zoneChanged",
      entityId: card.id,
      oldZoneId: zoneA.id,
      newZoneId: zoneB.id,
    });
  });

  it("ownership transfer/revert round-trips through the stack", () => {
    const bus = new EventBus();
    const store = new EntityStore(bus);
    const card = createCard("Razor");
    store.add(card);

    store.transferOwnershipTo(card.id, "fixer-A");
    store.transferOwnershipTo(card.id, "fixer-B");
    expect(card.ownership).toEqual(["fixer-A", "fixer-B"]);

    store.revertOwnershipOf(card.id);
    expect(card.ownership).toEqual(["fixer-A"]);
  });
});

describe("end-to-end: mutation through EntityStore triggers query recompute via the bus", () => {
  it("an inflow aggregate recomputes automatically when a contractor's tag/property changes", () => {
    const bus = new EventBus();
    const store = new EntityStore(bus);
    const registry = new SubscriptionRegistry();
    wireQuerySubscriptions(bus, registry);

    const board = createZone();
    store.add(board);

    const fence = createCard("Fence", { zoneId: board.id, properties: { inflow: 5 } });
    store.add(fence);

    const inflowAgg: NumExpr = {
      op: "fold",
      fold: "sum",
      of: { op: "prop", name: "inflow" },
      where: { op: "and", exprs: [{ op: "inZone", zoneId: board.id }, { op: "hasTag", tag: "contractor" }] },
    };
    const deps = extractNumExprDependencies(inflowAgg);

    let lastComputed = evaluateNumExpr(inflowAgg, board.id, store);
    expect(lastComputed).toBe(0); // fence isn't tagged "contractor" yet

    const recompute = vi.fn(() => {
      lastComputed = evaluateNumExpr(inflowAgg, board.id, store);
    });
    registry.subscribe(deps, recompute);

    // tagging fence as a contractor should trigger a recompute
    store.addTag(fence.id, "contractor");
    expect(recompute).toHaveBeenCalledTimes(1);
    expect(lastComputed).toBe(5);

    // bumping its inflow should trigger another recompute
    store.setProperty(fence.id, "inflow", 9);
    expect(recompute).toHaveBeenCalledTimes(2);
    expect(lastComputed).toBe(9);

    // an unrelated property change should NOT trigger a recompute
    store.setProperty(fence.id, "reputation", 100);
    expect(recompute).toHaveBeenCalledTimes(2);
  });
});
