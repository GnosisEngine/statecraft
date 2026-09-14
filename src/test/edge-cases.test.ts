import { describe, expect, it } from "vitest";
import { createCard, createZone, currentOwner } from "../core/entity.ts";
import type { Entity } from "../core/entity.ts";
import { EventBus } from "../events/bus.ts";
import { EntityStore } from "../events/entity-store.ts";
import { ModifierStore } from "../properties/modifier-store.ts";
import { newModifierId, type Modifier } from "../properties/modifier.ts";
import { PropertyResolver } from "../properties/property-resolver.ts";
import { evaluateBoolExpr, type QueryContext } from "../query/interpreter.ts";
import { type ActionDefinition } from "../actions/action-definition.ts";
import { EffectHandlerRegistry } from "../actions/effect-handler.ts";
import { performAction, type PerformActionDeps } from "../actions/pipeline.ts";
import { SeededRandom } from "../persistence/seeded-random.ts";
import { EventLog } from "../persistence/event-log.ts";
import { ReplayDivergenceError, replayCommands } from "../persistence/replay.ts";
import { ForkedEventLog } from "../forking/forked-event-log.ts";
import { ForkRegistry } from "../forking/fork-record.ts";
import { SeatMap } from "../forking/seat-map.ts";
import { RuleTable } from "../rules/rule-table.ts";
import { materializeFork } from "../forking/materialize-fork.ts";
import { computeVisibleEntityIds } from "../network/visibility.ts";

function makeCtx(entities: Entity[]): QueryContext {
  return {
    getAllEntities: () => entities,
    getEntity: (id) => entities.find((e) => e.id === id),
    getProperty: (id, prop) => entities.find((e) => e.id === id)?.properties[prop],
  };
}

describe("EventBus: cascade depth guard", () => {
  it("allows a bounded reaction chain (a triggers b triggers c)", () => {
    const bus = new EventBus();
    const calls: string[] = [];
    bus.on("entity:tagAdded", (e) => {
      calls.push(e.tag);
      if (e.tag === "a") bus.emit({ type: "entity:tagAdded", entityId: "x", tag: "b" });
      else if (e.tag === "b") bus.emit({ type: "entity:tagAdded", entityId: "x", tag: "c" });
    });
    bus.emit({ type: "entity:tagAdded", entityId: "x", tag: "a" });
    expect(calls).toEqual(["a", "b", "c"]);
  });

  it("throws a clear, catchable error rather than a raw stack overflow on an unbounded cascade", () => {
    const bus = new EventBus(8); // small depth so the test is fast, not because 8 is a real-world default
    bus.on("entity:tagAdded", (e) => {
      bus.emit({ type: "entity:tagAdded", entityId: "x", tag: e.tag }); // re-fires itself unconditionally
    });
    expect(() => bus.emit({ type: "entity:tagAdded", entityId: "x", tag: "loop" })).toThrow(/cascade depth/);
  });
});

describe("ActionDefinition: target count constraints", () => {
  function makeRig(overrides: Partial<ActionDefinition> = {}) {
    const bus = new EventBus();
    const entities = new EntityStore(bus);
    const modifiers = new ModifierStore(bus);
    const resolver = new PropertyResolver(entities, modifiers);
    const handlers = new EffectHandlerRegistry();
    handlers.register("swapEffect", () => {});

    const performer = createCard("Swapper", { id: "performer-1", ownership: ["fixer-A"] });
    const a = createCard("A", { id: "target-a" });
    const b = createCard("B", { id: "target-b" });
    const c = createCard("C", { id: "target-c" });
    entities.add(performer);
    entities.add(a);
    entities.add(b);
    entities.add(c);

    const swap: ActionDefinition = {
      id: "swap",
      category: () => "utility",
      targetsOwn: true,
      targetsOthers: true,
      targetQuery: () => ({ op: "kindIs", kind: "card" }),
      minTargets: () => 2,
      maxTargets: () => 2,
      effect: "swapEffect",
      ...overrides,
    };

    const deps: PerformActionDeps = { entities, resolver, modifiers, handlers, bus, random: new SeededRandom(1) };
    return { swap, deps };
  }

  it("rejects too few targets", () => {
    const { swap, deps } = makeRig();
    const result = performAction({ performerId: "performer-1", actingFixerId: "fixer-A", targetIds: ["target-a"] }, swap, deps);
    expect(result).toEqual({ ok: false, reason: 'action "swap" requires at least 2 target(s), got 1' });
  });

  it("rejects too many targets", () => {
    const { swap, deps } = makeRig();
    const result = performAction(
      { performerId: "performer-1", actingFixerId: "fixer-A", targetIds: ["target-a", "target-b", "target-c"] },
      swap,
      deps,
    );
    expect(result).toEqual({ ok: false, reason: 'action "swap" allows at most 2 target(s), got 3' });
  });

  it("accepts exactly the required count", () => {
    const { swap, deps } = makeRig();
    const result = performAction(
      { performerId: "performer-1", actingFixerId: "fixer-A", targetIds: ["target-a", "target-b"] },
      swap,
      deps,
    );
    expect(result.ok).toBe(true);
  });

  it("with no constraint set, zero targets is allowed — this was the ONLY behavior available before minTargets/maxTargets existed", () => {
    const { swap, deps } = makeRig({ minTargets: undefined, maxTargets: undefined });
    const result = performAction({ performerId: "performer-1", actingFixerId: "fixer-A", targetIds: [] }, swap, deps);
    expect(result.ok).toBe(true);
  });
});

describe("performAction: duplicate target ids", () => {
  it("applies the effect once per occurrence in targetIds — duplicates are NOT deduplicated", () => {
    const bus = new EventBus();
    const entities = new EntityStore(bus);
    const modifiers = new ModifierStore(bus);
    const resolver = new PropertyResolver(entities, modifiers);
    const handlers = new EffectHandlerRegistry();

    const performer = createCard("Zapper", { id: "performer-1", ownership: ["fixer-A"] });
    const target = createCard("Target", { id: "target-1", properties: { charges: 0 } });
    entities.add(performer);
    entities.add(target);

    handlers.register("zapEffect", (ctx, api) => {
      for (const targetId of ctx.targetIds) {
        const current = api.entities.get(targetId)?.properties.charges ?? 0;
        api.entities.setProperty(targetId, "charges", current + 1);
      }
    });

    const zap: ActionDefinition = {
      id: "zap",
      category: () => "utility",
      targetsOwn: true,
      targetsOthers: true,
      targetQuery: () => ({ op: "kindIs", kind: "card" }),
      effect: "zapEffect",
    };

    const deps: PerformActionDeps = { entities, resolver, modifiers, handlers, bus, random: new SeededRandom(1) };
    // the SAME target id twice in one proposal
    performAction({ performerId: "performer-1", actingFixerId: "fixer-A", targetIds: ["target-1", "target-1"] }, zap, deps);

    expect(target.properties.charges).toBe(2); // effect ran twice, not deduplicated to once
  });
});

describe("replayCommands: divergence detection", () => {
  it("throws ReplayDivergenceError if a logged-as-confirmed command replays as a rejection", () => {
    const log = new EventLog();
    log.append({ kind: "phaseAdvance" });

    expect(() =>
      replayCommands(log.getAll(), {
        performAction: () => ({ ok: true }),
        advancePhase: () => ({ ok: false, reason: "state diverged" }), // simulates a determinism bug
        pass: () => ({ ok: true }),
      }),
    ).toThrow(ReplayDivergenceError);
  });

  it("does not throw when every replayed command still succeeds", () => {
    const log = new EventLog();
    log.append({ kind: "phaseAdvance" });
    expect(() =>
      replayCommands(log.getAll(), {
        performAction: () => ({ ok: true }),
        advancePhase: () => ({ ok: true }),
        pass: () => ({ ok: true }),
      }),
    ).not.toThrow();
  });
});

describe("currentOwner: edge cases", () => {
  it("returns undefined for an entity with no ownership stack at all", () => {
    expect(currentOwner(createCard("X"))).toBeUndefined();
  });

  it("returns undefined for an entity with an explicitly empty ownership array (distinct from undefined, same result)", () => {
    expect(currentOwner(createCard("X", { ownership: [] }))).toBeUndefined();
  });
});

describe("withinDistance: exotic inputs", () => {
  it("treats a nonexistent 'of' entity as sitting at the origin, rather than throwing", () => {
    const near = createCard("Near", { id: "near", properties: { x: 0, y: 0 } });
    const far = createCard("Far", { id: "far", properties: { x: 5, y: 5 } });
    const ctx = makeCtx([near, far]);
    expect(evaluateBoolExpr({ op: "withinDistance", of: "ghost-entity", maxDistance: 0 }, near.id, ctx)).toBe(true);
    expect(evaluateBoolExpr({ op: "withinDistance", of: "ghost-entity", maxDistance: 0 }, far.id, ctx)).toBe(false);
  });
});

describe("ModifierStore + PropertyResolver: exotic modifier interactions", () => {
  function makeModifier(overrides: Partial<Modifier> & Pick<Modifier, "targetEntityId" | "prop" | "op" | "value">): Modifier {
    return { id: newModifierId(), priority: 0, source: "test", ...overrides };
  }

  it("same-priority modifiers resolve in insertion order (a stable sort, not arbitrary)", () => {
    const bus = new EventBus();
    const entities = new EntityStore(bus);
    const modifiers = new ModifierStore(bus);
    const resolver = new PropertyResolver(entities, modifiers);
    const card = createCard("X", { properties: { power: 10 } });
    entities.add(card);

    modifiers.add(makeModifier({ targetEntityId: card.id, prop: "power", op: "add", value: 1, priority: 0 }));
    modifiers.add(makeModifier({ targetEntityId: card.id, prop: "power", op: "multiply", value: 2, priority: 0 }));

    // insertion order at a tie: (10 + 1) * 2 = 22, not 10 * 2 + 1 = 21
    expect(resolver.getProperty(card.id, "power")).toBe(22);
  });

  it("a multiply by zero silences everything before it, but not modifiers after it", () => {
    const bus = new EventBus();
    const entities = new EntityStore(bus);
    const modifiers = new ModifierStore(bus);
    const resolver = new PropertyResolver(entities, modifiers);
    const card = createCard("X", { properties: { power: 0 } });
    entities.add(card);

    modifiers.add(makeModifier({ targetEntityId: card.id, prop: "power", op: "add", value: 100, priority: 0 }));
    modifiers.add(makeModifier({ targetEntityId: card.id, prop: "power", op: "multiply", value: 0, priority: 100 }));
    modifiers.add(makeModifier({ targetEntityId: card.id, prop: "power", op: "add", value: 5, priority: 200 }));

    expect(resolver.getProperty(card.id, "power")).toBe(5); // (0 + 100) * 0 + 5 = 5
  });

  it("a negative multiply inverts the accumulated value (a 'reversal' effect)", () => {
    const bus = new EventBus();
    const entities = new EntityStore(bus);
    const modifiers = new ModifierStore(bus);
    const resolver = new PropertyResolver(entities, modifiers);
    const card = createCard("X", { properties: { power: 0 } });
    entities.add(card);

    modifiers.add(makeModifier({ targetEntityId: card.id, prop: "power", op: "add", value: 10, priority: 0 }));
    modifiers.add(makeModifier({ targetEntityId: card.id, prop: "power", op: "multiply", value: -1, priority: 100 }));

    expect(resolver.getProperty(card.id, "power")).toBe(-10);
  });
});

describe("materializeFork: fork of a fork (a chain of ForkedEventLogs)", () => {
  it("materializes correctly when the parent log is itself a ForkedEventLog, and each level gets its own distinct seed", () => {
    const root = new EventLog(111);
    root.append({ kind: "phaseAdvance" }); // seq 0
    root.append({ kind: "phaseAdvance" }); // seq 1

    const forks = new ForkRegistry();
    const ruleTable = new RuleTable("root-rules");
    const seatMap = new SeatMap();
    const noopHandlers = { performAction: () => ({ ok: true }), advancePhase: () => ({ ok: true }), pass: () => ({ ok: true }) };

    forks.propose({
      id: "forkA",
      parentGameId: "root",
      forkPointSequence: 1,
      description: "first fork",
      proposedBy: "p",
      invitedSeats: [],
    });
    forks.accept("forkA");
    const forkARecord = forks.get("forkA")!;

    const { log: forkALog, ruleTable: forkARuleTable, seatMap: forkASeatMap } = materializeFork(forkARecord, {
      parentLog: root,
      parentRuleTable: ruleTable,
      parentSeatMap: seatMap,
      entities: new EntityStore(new EventBus()),
      modifiers: new ModifierStore(new EventBus()),
      hierarchies: [],
      stacks: [],
      pendingActionRegistry: null,
      lookupAction: () => undefined,
      replayHandlers: noopHandlers,
    });
    forkALog.append({ kind: "phaseAdvance" }); // seq 2, forkA's own

    const forkBRecord = forks.propose({
      id: "forkB",
      parentGameId: "forkA",
      forkPointSequence: 2,
      description: "fork of the fork",
      proposedBy: "p",
      invitedSeats: [],
    });
    forks.accept(forkBRecord.id);

    const { log: forkBLog } = materializeFork(forks.get("forkB")!, {
      parentLog: forkALog, // <- a ForkedEventLog, not a plain EventLog
      parentRuleTable: forkARuleTable,
      parentSeatMap: forkASeatMap,
      entities: new EntityStore(new EventBus()),
      modifiers: new ModifierStore(new EventBus()),
      hierarchies: [],
      stacks: [],
      pendingActionRegistry: null,
      lookupAction: () => undefined,
      replayHandlers: noopHandlers,
    });

    expect(forkBLog).toBeInstanceOf(ForkedEventLog);
    expect(forkBLog.getAll().map((c) => c.sequence)).toEqual([0, 1, 2]); // inherited through TWO levels
    expect(forkALog.seed).not.toBe(root.seed);
    expect(forkBLog.seed).not.toBe(forkALog.seed);
    expect(forkBLog.seed).not.toBe(root.seed);
  });
});

describe("visibility: nested zone containment (documented limitation, not a bug)", () => {
  it("does NOT cascade a hidden zone's visibility onto zones nested inside it — only an entity's DIRECT containing zone applies", () => {
    // zoneOuter is hidden; zoneInner sits INSIDE zoneOuter and is itself
    // public. Intuitively "inside a hidden container" should hide
    // everything nested within it, but computeVisibility only ever
    // checks an entity's immediate zoneId — it doesn't walk up a chain
    // of nested zones. This is a real, deliberate scope boundary (see
    // network/visibility.ts's doc comment) — cascading containment is a
    // separate feature a game with nested containers would need to add
    // explicitly, not something silently half-working today.
    const outer = createZone({ visibility: "hidden" }, { id: "outer" });
    const inner = createZone({ visibility: "public" }, { id: "inner", zoneId: "outer" });
    const card = createCard("Nested", { zoneId: "inner" });
    const all = [outer, inner, card];
    const byId = new Map(all.map((e) => [e.id, e]));

    const visible = computeVisibleEntityIds(all, (id) => byId.get(id), "any-fixer");
    expect(visible.has(card.id)).toBe(true); // currently visible — NOT cascaded from outer's hidden-ness
  });
});
