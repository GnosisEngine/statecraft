import { describe, expect, it, vi } from "vitest";
import { createCard, createHand } from "../core/entity.ts";
import { EventBus } from "../events/bus.ts";
import { EntityStore } from "../events/entity-store.ts";
import { Hierarchy } from "../events/hierarchy.ts";
import { Stack } from "../events/stack.ts";
import { ModifierStore } from "../properties/modifier-store.ts";
import { newModifierId } from "../properties/modifier.ts";
import { PropertyResolver } from "../properties/property-resolver.ts";
import { ActionRegistry, type ActionContext, type ActionDefinition } from "../actions/action-definition.ts";
import { EffectHandlerRegistry } from "../actions/effect-handler.ts";
import { performAction, type PerformActionDeps } from "../actions/pipeline.ts";
import { RuleHandlerRegistry } from "../rules/rule-handler.ts";
import { RuleTable } from "../rules/rule-table.ts";
import { RuleEngine } from "../rules/rule-engine.ts";
import { SeededRandom, rollDice, randomSeed, deriveSeed } from "../persistence/seeded-random.ts";
import { RandomRegistry, makeRandomFor } from "../persistence/random-registry.ts";
import { EventLog } from "../persistence/event-log.ts";
import { performActionAndLog, replayCommands } from "../persistence/replay.ts";
import { createSnapshot, restoreSnapshot } from "../persistence/snapshot.ts";

describe("SeededRandom", () => {
  it("is deterministic: the same seed produces the same sequence", () => {
    const a = new SeededRandom(42);
    const b = new SeededRandom(42);
    expect([a.next(), a.next(), a.next()]).toEqual([b.next(), b.next(), b.next()]);
  });

  it("different seeds produce different sequences", () => {
    const a = new SeededRandom(1);
    const b = new SeededRandom(2);
    expect(a.next()).not.toBe(b.next());
  });

  it("shuffle is deterministic given the same seed, and never mutates the input", () => {
    const input = [1, 2, 3, 4, 5];
    const shuffled1 = new SeededRandom(7).shuffle(input);
    const shuffled2 = new SeededRandom(7).shuffle(input);

    expect(shuffled1).toEqual(shuffled2);
    expect(input).toEqual([1, 2, 3, 4, 5]);
    expect([...shuffled1].sort()).toEqual([...input].sort());
  });
});

describe("rollDice", () => {
  it("rolls each die within [1, sides] and sums them into total", () => {
    const random = new SeededRandom(99);
    const roll = rollDice(random, 6, 3);
    expect(roll.sides).toBe(6);
    expect(roll.count).toBe(3);
    expect(roll.rolls).toHaveLength(3);
    for (const die of roll.rolls) {
      expect(die).toBeGreaterThanOrEqual(1);
      expect(die).toBeLessThanOrEqual(6);
    }
    expect(roll.total).toBe(roll.rolls.reduce((a, b) => a + b, 0));
  });

  it("is deterministic given the same seed", () => {
    const roll1 = rollDice(new SeededRandom(5), 20, 4);
    const roll2 = rollDice(new SeededRandom(5), 20, 4);
    expect(roll1).toEqual(roll2);
  });

  it("defaults to a single die", () => {
    const roll = rollDice(new SeededRandom(1), 6);
    expect(roll.count).toBe(1);
    expect(roll.rolls).toHaveLength(1);
  });
});

describe("randomSeed", () => {
  it("produces a 32-bit unsigned integer", () => {
    const seed = randomSeed();
    expect(Number.isInteger(seed)).toBe(true);
    expect(seed).toBeGreaterThanOrEqual(0);
    expect(seed).toBeLessThanOrEqual(0xffffffff);
  });

  it("is not the same value every call (sanity check, not a statistical proof)", () => {
    const seeds = new Set(Array.from({ length: 10 }, () => randomSeed()));
    expect(seeds.size).toBeGreaterThan(1);
  });
});

describe("deriveSeed", () => {
  it("is deterministic — same (master, domain) always derives the same seed", () => {
    expect(deriveSeed(12345, "fixer-A:deck")).toBe(deriveSeed(12345, "fixer-A:deck"));
  });

  it("different domains, same master, derive different seeds", () => {
    expect(deriveSeed(12345, "fixer-A:deck")).not.toBe(deriveSeed(12345, "fixer-B:deck"));
    expect(deriveSeed(12345, "fixer-A:deck")).not.toBe(deriveSeed(12345, "general"));
  });

  it("same domain, different masters, derive different seeds", () => {
    expect(deriveSeed(1, "fixer-A:deck")).not.toBe(deriveSeed(2, "fixer-A:deck"));
  });

  it("similar domain strings avalanche into unrelated seeds (sanity check, not a cryptographic proof)", () => {
    const a = deriveSeed(12345, "fixer-A:deck");
    const b = deriveSeed(12345, "fixer-B:deck"); // differs by one character
    // count differing bits — a healthy mix should differ in roughly half of 32 bits, not just the 1-2 bits the input itself differed by
    let differingBits = 0;
    for (let bit = 0; bit < 32; bit++) {
      if (((a >>> bit) & 1) !== ((b >>> bit) & 1)) differingBits++;
    }
    expect(differingBits).toBeGreaterThan(8);
  });

  it("streams derived for different domains are genuinely independent — consuming one never affects the other's sequence", () => {
    const master = 999;
    const seedA = deriveSeed(master, "fixer-A:deck");
    const seedB = deriveSeed(master, "fixer-B:deck");

    const freshB = new SeededRandom(seedB);
    const bFirstValueBeforeAnyAConsumption = freshB.next();

    // now consume a large, arbitrary number of values from A's stream
    const a = new SeededRandom(seedA);
    for (let i = 0; i < 500; i++) a.next();

    // B's stream, reconstructed identically, produces the EXACT same first value —
    // nothing about how much A was consumed could have shifted it, because they
    // were never the same underlying generator to begin with.
    const bAgain = new SeededRandom(seedB);
    expect(bAgain.next()).toBe(bFirstValueBeforeAnyAConsumption);
  });
});

describe("RandomRegistry / makeRandomFor", () => {
  it("register + get round-trips the exact registered stream instance", () => {
    const registry = new RandomRegistry();
    const stream = new SeededRandom(1);
    registry.register("fixer-A:deck", stream);
    expect(registry.get("fixer-A:deck")).toBe(stream);
    expect(registry.get("fixer-B:deck")).toBeUndefined();
  });

  it("makeRandomFor returns undefined when no registry was supplied at all", () => {
    expect(makeRandomFor(undefined)).toBeUndefined();
  });

  it("makeRandomFor's function resolves a registered domain to its exact stream", () => {
    const registry = new RandomRegistry();
    const stream = new SeededRandom(1);
    registry.register("fixer-A:deck", stream);
    const randomFor = makeRandomFor(registry)!;
    expect(randomFor("fixer-A:deck")).toBe(stream);
  });

  it("makeRandomFor's function throws a clear error for an unregistered domain, never silently falling back", () => {
    const registry = new RandomRegistry();
    const randomFor = makeRandomFor(registry)!;
    expect(() => randomFor("nope")).toThrow(/no random stream registered for domain "nope"/);
  });
});

describe("EventLog", () => {
  it("assigns sequential sequence numbers and stores the seed", () => {
    const log = new EventLog(1234);
    expect(log.seed).toBe(1234);

    const c0 = log.append({ kind: "phaseAdvance" });
    const c1 = log.append({ kind: "action", actionId: "x", intent: { performerId: "p", actingFixerId: "f", targetIds: [] } });

    expect(c0.sequence).toBe(0);
    expect(c1.sequence).toBe(1);
    expect(log.length).toBe(2);
  });

  it("getSince returns strictly-after entries", () => {
    const log = new EventLog();
    log.append({ kind: "phaseAdvance" });
    log.append({ kind: "phaseAdvance" });
    log.append({ kind: "phaseAdvance" });

    expect(log.getSince(0).map((c) => c.sequence)).toEqual([1, 2]);
    expect(log.getSince(2)).toEqual([]);
  });
});

describe("Snapshot", () => {
  it("round-trips entities (incl. tags) and modifiers into fresh stores without emitting any events", () => {
    const bus = new EventBus();
    const entities = new EntityStore(bus);
    const modifiers = new ModifierStore(bus);

    const card = createCard("Fence", { id: "card-1", properties: { inflow: 5 } });
    card.tags.add("contractor");
    entities.add(card);
    modifiers.add({ id: "mod-1", targetEntityId: "card-1", prop: "inflow", op: "add", value: -3, priority: 0, source: "test" });

    const snapshot = createSnapshot(entities, modifiers, 0, [], [], null);

    const freshBus = new EventBus();
    const freshEntities = new EntityStore(freshBus);
    const freshModifiers = new ModifierStore(freshBus);
    const createdSpy = vi.fn();
    const modifierAddedSpy = vi.fn();
    freshBus.on("entity:created", createdSpy);
    freshBus.on("modifier:added", modifierAddedSpy);

    restoreSnapshot(snapshot, freshEntities, freshModifiers, [], [], null, () => undefined);

    expect(createdSpy).not.toHaveBeenCalled();
    expect(modifierAddedSpy).not.toHaveBeenCalled();

    const restored = freshEntities.get("card-1")!;
    expect(restored.tags.has("contractor")).toBe(true);
    expect(freshModifiers.getModifiersFor("card-1", "inflow")).toHaveLength(1);

    const resolver = new PropertyResolver(freshEntities, freshModifiers);
    expect(resolver.getProperty("card-1", "inflow")).toBe(2); // 5 + (-3)
  });

  it("round-trips Hierarchy state too — this is the actual fix: a snapshot used to have no idea Hierarchy existed at all", () => {
    const bus = new EventBus();
    const entities = new EntityStore(bus);
    const modifiers = new ModifierStore(bus);
    const deckHierarchy = new Hierarchy("deck", bus);
    deckHierarchy.setParent("card-1", "fixer-A"); // unordered pool member — no siblingIndex
    deckHierarchy.setParent("card-2", "fixer-A", 0); // an ordered sibling, for contrast

    const snapshot = createSnapshot(entities, modifiers, 0, [deckHierarchy], [], null);

    const freshDeckHierarchy = new Hierarchy("deck", new EventBus());
    restoreSnapshot(snapshot, new EntityStore(new EventBus()), new ModifierStore(new EventBus()), [freshDeckHierarchy], [], null, () => undefined);

    expect(freshDeckHierarchy.getParent("card-1")).toBe("fixer-A");
    expect(freshDeckHierarchy.getParent("card-2")).toBe("fixer-A");
    // the pool/ordered distinction survives too: card-1 (no index) is still
    // drawable via drawRandom, card-2 (explicit index) is not
    const drawn = freshDeckHierarchy.drawRandom("fixer-A", new SeededRandom(1));
    expect(drawn).toBe("card-1");
    expect(freshDeckHierarchy.getParent("card-2")).toBe("fixer-A"); // untouched — never eligible to be drawn
  });

  it("restoreSnapshot throws if a hierarchy the snapshot references isn't among the ones provided to restore into", () => {
    const bus = new EventBus();
    const entities = new EntityStore(bus);
    const modifiers = new ModifierStore(bus);
    const deckHierarchy = new Hierarchy("deck", bus);
    deckHierarchy.setParent("card-1", "fixer-A");

    const snapshot = createSnapshot(entities, modifiers, 0, [deckHierarchy], [], null);

    expect(() => restoreSnapshot(snapshot, new EntityStore(new EventBus()), new ModifierStore(new EventBus()), [], [], null, () => undefined)).toThrow(
      /no Hierarchy named "deck" was provided/,
    );
  });

  it("round-trips Stack state too — this is the actual fix: sequenceCounter used to be private, in-memory-only state with no restore path, so the FIRST push after resuming from a snapshot would be stamped with a LOWER pushedAtSequence than items genuinely pushed before the snapshot, silently corrupting LIFO/FIFO/any custom resolution policy", () => {
    const bus = new EventBus();
    const entities = new EntityStore(bus);
    const modifiers = new ModifierStore(bus);
    const hierarchy = new Hierarchy("responses", bus);
    entities.add(createCard("Table", { id: "table" }));
    const stack = new Stack(hierarchy, entities, bus, "table");
    entities.add(createCard("A", { id: "a" }));
    entities.add(createCard("B", { id: "b" }));
    stack.push("a", null);
    stack.push("b", "a"); // sequenceCounter is now 2 internally, "a"/"b" both pending

    const snapshot = createSnapshot(entities, modifiers, 0, [hierarchy], [stack], null);

    const freshBus = new EventBus();
    const freshEntities = new EntityStore(freshBus);
    const freshHierarchy = new Hierarchy("responses", freshBus);
    freshEntities.add(createCard("Table", { id: "table" }));
    const freshStack = new Stack(freshHierarchy, freshEntities, freshBus, "table");
    restoreSnapshot(snapshot, freshEntities, new ModifierStore(freshBus), [freshHierarchy], [freshStack], null, () => undefined);

    // the tree structure survived (via Hierarchy's own restore)
    expect(freshHierarchy.getParent("b")).toBe("a");
    // and critically, the NEXT push gets a sequence number that doesn't
    // collide with or precede the restored items — proving sequenceCounter
    // itself, not just the pending data, actually resumed correctly
    entities.add(createCard("C", { id: "c" })); // mirror on the "live" side too, for a fair comparison
    freshEntities.add(createCard("C", { id: "c" }));
    freshStack.push("c", null);
    expect(freshEntities.get("c")?.properties.pushedAtSequence).toBe(2); // continues from 2, not reset to 0
  });

  it("restoreSnapshot throws if a stack the snapshot references isn't among the ones provided to restore into", () => {
    const bus = new EventBus();
    const entities = new EntityStore(bus);
    const modifiers = new ModifierStore(bus);
    const hierarchy = new Hierarchy("responses", bus);
    entities.add(createCard("Table", { id: "table" }));
    const stack = new Stack(hierarchy, entities, bus, "table");
    entities.add(createCard("A", { id: "a" }));
    stack.push("a", null);

    const snapshot = createSnapshot(entities, modifiers, 0, [hierarchy], [stack], null);

    expect(() => restoreSnapshot(snapshot, new EntityStore(new EventBus()), new ModifierStore(new EventBus()), [new Hierarchy("responses", new EventBus())], [], null, () => undefined)).toThrow(
      /no Stack named "responses" was provided/,
    );
  });
});

/** Shared registrations (action def, effect handler, rule) for the replay tests below — no fixture entities yet. */
function buildRegistrations() {
  const bus = new EventBus();
  const entities = new EntityStore(bus);
  const modifiers = new ModifierStore(bus);
  const resolver = new PropertyResolver(entities, modifiers);
  const effectHandlers = new EffectHandlerRegistry();
  const actions = new ActionRegistry();
  const ruleHandlers = new RuleHandlerRegistry();
  const ruleTable = new RuleTable("core");
  const ruleEngine = new RuleEngine(ruleTable, ruleHandlers, entities, modifiers, resolver, new SeededRandom(1));
  ruleEngine.wire(bus);

  const shakedown: ActionDefinition = {
    id: "shakedown",
    category: () => "coercion",
    targetsOwn: false,
    targetsOthers: true,
    targetQuery: (ctx) => ({
      op: "and",
      exprs: [{ op: "hasTag", tag: "contractor" }, { op: "not", expr: { op: "ownedBy", fixerId: ctx.actingFixerId } }],
    }),
    performerCondition: () => ({ op: "hasTag", tag: "contractor" }),
    cost: () => ({ prop: "resources", amount: 4 }),
    effect: "shakedownEffect",
  };
  actions.register(shakedown);

  effectHandlers.register("shakedownEffect", (ctx, api) => {
    for (const targetId of ctx.targetIds) {
      api.entities.addTag(targetId, "shaken");
      api.modifiers.add({
        id: newModifierId(),
        targetEntityId: targetId,
        prop: "inflow",
        op: "add",
        value: -3,
        priority: 0,
        source: "shakedown",
      });
    }
  });

  // A rule fires on every resolved shakedown — never separately logged, so
  // this is what proves replay re-derives rule effects, not just direct ones.
  ruleTable.add({
    id: "shakedown-bonus",
    trigger: "action:resolved",
    match: (event) => event.actionId === "shakedown",
    effect: "grantReputationBonus",
  });
  ruleHandlers.register("grantReputationBonus", (event, api) => {
    const e = event as Extract<typeof event, { type: "action:resolved" }>;
    const current = api.entities.get(e.actingFixerId)?.properties.reputation ?? 0;
    api.entities.setProperty(e.actingFixerId, "reputation", current + 1);
  });

  const deps: PerformActionDeps = { entities, resolver, modifiers, handlers: effectHandlers, bus, random: new SeededRandom(1) };
  return { bus, entities, modifiers, resolver, actions, deps };
}

function seedFixtures(rig: ReturnType<typeof buildRegistrations>): void {
  rig.entities.add(createHand([], { id: "fixer-A", properties: { resources: 10, reputation: 0 } }));
  rig.entities.add(createHand([], { id: "fixer-B", properties: { resources: 10 } }));
  const performer = createCard("Ace", { id: "performer-1", ownership: ["fixer-A"] });
  performer.tags.add("contractor");
  const target = createCard("Runner", { id: "target-1", ownership: ["fixer-B"], properties: { inflow: 5 } });
  target.tags.add("contractor");
  rig.entities.add(performer);
  rig.entities.add(target);
}

describe("end-to-end: replaying a logged command sequence reproduces live state", () => {
  it("replaying from scratch reproduces final state, including a rule effect that was never separately logged", () => {
    const log = new EventLog();
    const live = buildRegistrations();
    seedFixtures(live);

    const intent: ActionContext = { performerId: "performer-1", actingFixerId: "fixer-A", targetIds: ["target-1"] };
    const r1 = performActionAndLog(log, "shakedown", intent, () => performAction(intent, live.actions.get("shakedown")!, live.deps));
    const r2 = performActionAndLog(log, "shakedown", intent, () => performAction(intent, live.actions.get("shakedown")!, live.deps));
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);

    expect(live.resolver.getProperty("fixer-A", "resources")).toBe(2); // 10 - 4 - 4
    expect(live.resolver.getProperty("target-1", "inflow")).toBe(-1); // 5 - 3 - 3
    expect(live.entities.get("fixer-A")?.properties.reputation).toBe(2); // rule fired twice

    const replayed = buildRegistrations();
    seedFixtures(replayed);
    replayCommands(log.getAll(), {
      performAction: (actionId, replayIntent) => performAction(replayIntent, replayed.actions.get(actionId)!, replayed.deps),
      advancePhase: () => {
        throw new Error("not used in this test");
      },
      pass: () => {
        throw new Error("not used in this test");
      },
    });

    expect(replayed.resolver.getProperty("fixer-A", "resources")).toBe(2);
    expect(replayed.resolver.getProperty("target-1", "inflow")).toBe(-1);
    expect(replayed.entities.get("fixer-A")?.properties.reputation).toBe(2);
  });

  it("resuming from a snapshot plus only the commands since it reproduces the same final state", () => {
    const log = new EventLog();
    const live = buildRegistrations();
    seedFixtures(live);

    const intent: ActionContext = { performerId: "performer-1", actingFixerId: "fixer-A", targetIds: ["target-1"] };
    performActionAndLog(log, "shakedown", intent, () => performAction(intent, live.actions.get("shakedown")!, live.deps));

    // snapshot reflects state after exactly the one command applied so far
    const snapshot = createSnapshot(live.entities, live.modifiers, log.length - 1, [], [], null);

    performActionAndLog(log, "shakedown", intent, () => performAction(intent, live.actions.get("shakedown")!, live.deps));
    const finalResources = live.resolver.getProperty("fixer-A", "resources");
    const finalInflow = live.resolver.getProperty("target-1", "inflow");
    const finalReputation = live.entities.get("fixer-A")?.properties.reputation;

    const resumed = buildRegistrations();
    restoreSnapshot(snapshot, resumed.entities, resumed.modifiers, [], [], null, () => undefined);
    replayCommands(log.getSince(snapshot.atSequence), {
      performAction: (actionId, replayIntent) => performAction(replayIntent, resumed.actions.get(actionId)!, resumed.deps),
      advancePhase: () => {
        throw new Error("not used in this test");
      },
      pass: () => {
        throw new Error("not used in this test");
      },
    });

    expect(resumed.resolver.getProperty("fixer-A", "resources")).toBe(finalResources);
    expect(resumed.resolver.getProperty("target-1", "inflow")).toBe(finalInflow);
    expect(resumed.entities.get("fixer-A")?.properties.reputation).toBe(finalReputation);
  });
});
