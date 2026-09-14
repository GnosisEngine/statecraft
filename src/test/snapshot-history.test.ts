import { describe, expect, it } from "vitest";
import { EventBus } from "../events/bus.ts";
import { EntityStore } from "../events/entity-store.ts";
import { Hierarchy } from "../events/hierarchy.ts";
import { Stack } from "../events/stack.ts";
import { ModifierStore } from "../properties/modifier-store.ts";
import { PropertyResolver } from "../properties/property-resolver.ts";
import { createCard } from "../core/entity.ts";
import { createSnapshot, type Snapshot } from "../persistence/snapshot.ts";
import { SnapshotHistory, materializeHistoricalContext, evaluatePastBoolExpr, evaluatePastNumExpr, type HistoricalContextConfig } from "../persistence/snapshot-history.ts";
import type { BoolExpr, NumExpr } from "../query/types.ts";

function makeSnapshotAt(atSequence: number, inflow: number): Snapshot {
  const bus = new EventBus();
  const entities = new EntityStore(bus);
  const modifiers = new ModifierStore(bus);
  entities.add(createCard("Fixer", { id: "fixer-A", properties: { inflow } }));
  return createSnapshot(entities, modifiers, atSequence, [], [], null);
}

describe("SnapshotHistory — retention and lookup", () => {
  it("record/at round-trips an exact sequence", () => {
    const history = new SnapshotHistory({ maxRetained: 10 });
    const snap = makeSnapshotAt(5, 10);
    history.record(snap);
    expect(history.at(5)).toBe(snap);
  });

  it("at() returns the most recent snapshot AT OR BEFORE the requested sequence, not requiring an exact match", () => {
    const history = new SnapshotHistory({ maxRetained: 10 });
    history.record(makeSnapshotAt(0, 1));
    history.record(makeSnapshotAt(5, 2));
    history.record(makeSnapshotAt(10, 3));

    expect(history.at(7)?.atSequence).toBe(5); // nearest at-or-before 7 is 5, not 10
    expect(history.at(10)?.atSequence).toBe(10); // exact match
    expect(history.at(0)?.atSequence).toBe(0);
  });

  it("returns undefined — not a throw — for a sequence before anything ever retained", () => {
    const history = new SnapshotHistory({ maxRetained: 10 });
    history.record(makeSnapshotAt(5, 1));
    expect(history.at(2)).toBeUndefined();
  });

  it("prunes the OLDEST snapshot once maxRetained is exceeded", () => {
    const history = new SnapshotHistory({ maxRetained: 2 });
    history.record(makeSnapshotAt(0, 1));
    history.record(makeSnapshotAt(5, 2));
    expect(history.retainedSequences()).toEqual([0, 5]);

    history.record(makeSnapshotAt(10, 3));
    expect(history.retainedSequences()).toEqual([5, 10]); // 0 was pruned

    // a query for something before the pruned snapshot now honestly
    // returns undefined — the history genuinely doesn't know anymore
    expect(history.at(2)).toBeUndefined();
  });

  it("maxRetained: Infinity keeps everything ever recorded — a real, explicit choice, not a silent default", () => {
    const history = new SnapshotHistory({ maxRetained: Infinity });
    for (let i = 0; i < 50; i++) history.record(makeSnapshotAt(i, i));
    expect(history.retainedSequences().length).toBe(50);
    expect(history.at(0)?.atSequence).toBe(0); // the very first one is still there
  });

  it("throws constructing with maxRetained < 1 — an explicit, sane floor", () => {
    expect(() => new SnapshotHistory({ maxRetained: 0 })).toThrow(/must be at least 1/);
  });

  it("throws recording a snapshot older than the most recently recorded one — a history has to stay internally coherent", () => {
    const history = new SnapshotHistory({ maxRetained: 10 });
    history.record(makeSnapshotAt(10, 1));
    expect(() => history.record(makeSnapshotAt(5, 2))).toThrow(/older than the most recently recorded one/);
  });
});

describe("materializeHistoricalContext — reconstructs a frozen moment without ever touching live state", () => {
  it("reads the property values exactly as they were at the snapshot moment", () => {
    const snapshot = makeSnapshotAt(0, 42);
    const config: HistoricalContextConfig = { hierarchyNames: [], stacks: [], lookupAction: () => undefined };
    const { resolver } = materializeHistoricalContext(snapshot, config);
    expect(resolver.getProperty("fixer-A", "inflow")).toBe(42);
  });

  it("is FULLY ISOLATED from the live game — mutating live state after materializing never affects the materialized context, and vice versa", () => {
    const bus = new EventBus();
    const entities = new EntityStore(bus);
    const modifiers = new ModifierStore(bus);
    entities.add(createCard("Fixer", { id: "fixer-A", properties: { inflow: 10 } }));
    const snapshot = createSnapshot(entities, modifiers, 0, [], [], null);

    const config: HistoricalContextConfig = { hierarchyNames: [], stacks: [], lookupAction: () => undefined };
    const { entities: historicalEntities, resolver: historicalResolver } = materializeHistoricalContext(snapshot, config);

    // mutate the LIVE state after the snapshot/materialization
    entities.setProperty("fixer-A", "inflow", 999);
    expect(historicalResolver.getProperty("fixer-A", "inflow")).toBe(10); // untouched by the live mutation

    // mutate the HISTORICAL context — must never reach back to live state
    historicalEntities.setProperty("fixer-A", "inflow", -1);
    expect(entities.get("fixer-A")?.properties.inflow).toBe(999); // untouched by the historical mutation
  });

  it("fires NO events on the live bus — nothing anywhere reacts to a historical materialization happening", () => {
    const bus = new EventBus();
    const entities = new EntityStore(bus);
    const modifiers = new ModifierStore(bus);
    entities.add(createCard("Fixer", { id: "fixer-A", properties: { inflow: 10 } }));
    const snapshot = createSnapshot(entities, modifiers, 0, [], [], null);

    let liveEventsFired = 0;
    bus.on("entity:created", () => liveEventsFired++);
    bus.on("entity:propertyChanged", () => liveEventsFired++);

    materializeHistoricalContext(snapshot, { hierarchyNames: [], stacks: [], lookupAction: () => undefined });

    expect(liveEventsFired).toBe(0); // materialization uses its OWN, throwaway bus entirely
  });

  it("correctly reconstructs Hierarchy/Stack state too, not just plain entity properties", () => {
    const bus = new EventBus();
    const entities = new EntityStore(bus);
    const modifiers = new ModifierStore(bus);
    const hierarchy = new Hierarchy("responses", bus);
    entities.add(createCard("Table", { id: "table" }));
    const stack = new Stack(hierarchy, entities, bus, "table");
    entities.add(createCard("Root", { id: "root" }));
    entities.add(createCard("Response", { id: "response" }));
    stack.push("root", null);
    stack.push("response", "root");

    const snapshot = createSnapshot(entities, modifiers, 0, [hierarchy], [stack], null);
    const { resolver } = materializeHistoricalContext(snapshot, {
      hierarchyNames: ["responses"],
      stacks: [{ hierarchyName: "responses", anchorEntityId: "table" }],
      lookupAction: () => undefined,
    });

    expect(resolver.getProperty("table", "stackDepth:responses")).toBe(2);
  });
});

describe("evaluatePastBoolExpr / evaluatePastNumExpr — the actual 'query the past' entry point", () => {
  it("evaluates an ordinary NumExpr against a frozen prior moment — the 'Cold Case' use case: was this property genuinely higher three turns ago?", () => {
    const history = new SnapshotHistory({ maxRetained: 10 });
    history.record(makeSnapshotAt(0, 100)); // inflow was 100 three turns ago
    history.record(makeSnapshotAt(10, 40)); // it's 40 now

    const config: HistoricalContextConfig = { hierarchyNames: [], stacks: [], lookupAction: () => undefined };
    const inflowThreeAgo = evaluatePastNumExpr(history, 0, "fixer-A", { op: "prop", name: "inflow" }, config);
    expect(inflowThreeAgo).toBe(100);

    // a real comparison a card could make: "was I richer before than I am now"
    const wasHigherThan50: BoolExpr = { op: "compare", left: { op: "prop", name: "inflow" }, cmp: "gt", right: { op: "lit", value: 50 } };
    expect(evaluatePastBoolExpr(history, 0, "fixer-A", wasHigherThan50, config)).toBe(true);
    expect(evaluatePastBoolExpr(history, 10, "fixer-A", wasHigherThan50, config)).toBe(false);
  });

  it("returns undefined (not a throw) when nothing retained goes back that far — an honest 'we don't know', not a false answer", () => {
    const history = new SnapshotHistory({ maxRetained: 2 });
    history.record(makeSnapshotAt(0, 1));
    history.record(makeSnapshotAt(5, 2));
    history.record(makeSnapshotAt(10, 3)); // prunes sequence 0

    const config: HistoricalContextConfig = { hierarchyNames: [], stacks: [], lookupAction: () => undefined };
    const expr: NumExpr = { op: "prop", name: "inflow" };
    expect(evaluatePastNumExpr(history, 1, "fixer-A", expr, config)).toBeUndefined();
  });
});
