import { describe, expect, it } from "vitest";
import { createCard, createHand } from "../core/entity.ts";
import { EventBus } from "../events/bus.ts";
import { EntityStore } from "../events/entity-store.ts";
import { newModifierId } from "../properties/modifier.ts";
import { ModifierStore } from "../properties/modifier-store.ts";
import { PropertyResolver } from "../properties/property-resolver.ts";
import { ActionRegistry, type ActionContext, type ActionDefinition } from "../actions/action-definition.ts";
import { EffectHandlerRegistry } from "../actions/effect-handler.ts";
import { performAction, type PerformActionDeps } from "../actions/pipeline.ts";
import { RuleHandlerRegistry } from "../rules/rule-handler.ts";
import { RuleTable } from "../rules/rule-table.ts";
import { RuleEngine } from "../rules/rule-engine.ts";
import { EventLog } from "../persistence/event-log.ts";
import { SeededRandom } from "../persistence/seeded-random.ts";
import { performActionAndLog } from "../persistence/replay.ts";
import { createSnapshot } from "../persistence/snapshot.ts";
import { ForkedEventLog } from "../forking/forked-event-log.ts";
import { ForkRegistry } from "../forking/fork-record.ts";
import { SeatMap } from "../forking/seat-map.ts";
import { materializeFork } from "../forking/materialize-fork.ts";

describe("ForkedEventLog", () => {
  it("inherits the parent's prefix up to the fork point and continues sequence numbering for its own commands", () => {
    const parent = new EventLog();
    parent.append({ kind: "phaseAdvance" }); // seq 0
    parent.append({ kind: "phaseAdvance" }); // seq 1
    parent.append({ kind: "phaseAdvance" }); // seq 2

    const fork = new ForkedEventLog(parent, 1); // inherits seq 0, 1
    const c0 = fork.append({ kind: "phaseAdvance" });
    const c1 = fork.append({ kind: "phaseAdvance" });

    expect(c0.sequence).toBe(2);
    expect(c1.sequence).toBe(3);
    expect(fork.getAll().map((c) => c.sequence)).toEqual([0, 1, 2, 3]);
    expect(fork.length).toBe(4);
  });

  it("getSince filters across the inherited/own boundary", () => {
    const parent = new EventLog();
    parent.append({ kind: "phaseAdvance" }); // seq 0
    parent.append({ kind: "phaseAdvance" }); // seq 1

    const fork = new ForkedEventLog(parent, 0); // inherits only seq 0
    fork.append({ kind: "phaseAdvance" }); // seq 1 (fork's own)

    expect(fork.getSince(0).map((c) => c.sequence)).toEqual([1]);
  });

  it("forking with forkPointSequence -1 inherits nothing", () => {
    const parent = new EventLog();
    parent.append({ kind: "phaseAdvance" });
    const fork = new ForkedEventLog(parent, -1);
    fork.append({ kind: "phaseAdvance" });
    expect(fork.getAll().map((c) => c.sequence)).toEqual([0]);
  });

  it("supports fork-of-a-fork chains", () => {
    const root = new EventLog();
    root.append({ kind: "phaseAdvance" }); // seq 0
    root.append({ kind: "phaseAdvance" }); // seq 1

    const forkA = new ForkedEventLog(root, 1); // inherits 0,1
    forkA.append({ kind: "phaseAdvance" }); // seq 2

    const forkB = new ForkedEventLog(forkA, 2); // inherits 0,1,2 (through forkA)
    forkB.append({ kind: "phaseAdvance" }); // seq 3

    expect(forkB.getAll().map((c) => c.sequence)).toEqual([0, 1, 2, 3]);
    // mutating forkB never touched forkA or root
    expect(forkA.getAll().map((c) => c.sequence)).toEqual([0, 1, 2]);
    expect(root.getAll().map((c) => c.sequence)).toEqual([0, 1]);
  });
});

describe("ForkRegistry", () => {
  it("propose() starts a fork as pending", () => {
    const registry = new ForkRegistry();
    const record = registry.propose({
      id: "fork-1",
      parentGameId: "game-1",
      forkPointSequence: 5,
      description: "what if I'd shaken down Runner instead",
      proposedBy: "fixer-A",
      invitedSeats: ["fixer-B"],
    });
    expect(record.status).toBe("pending");
  });

  it("accept/decline/expire transition a pending fork, and cannot be repeated", () => {
    const registry = new ForkRegistry();
    registry.propose({
      id: "fork-1",
      parentGameId: "game-1",
      forkPointSequence: 5,
      description: "d",
      proposedBy: "fixer-A",
      invitedSeats: ["fixer-B"],
    });

    const accepted = registry.accept("fork-1");
    expect(accepted.status).toBe("accepted");
    expect(() => registry.decline("fork-1")).toThrow(/already "accepted"/);
  });

  it("throws transitioning an unknown fork", () => {
    const registry = new ForkRegistry();
    expect(() => registry.accept("nope")).toThrow(/Unknown fork/);
  });

  it("forksOf lists only forks proposed from that game", () => {
    const registry = new ForkRegistry();
    registry.propose({ id: "f1", parentGameId: "game-1", forkPointSequence: 1, description: "d", proposedBy: "a", invitedSeats: [] });
    registry.propose({ id: "f2", parentGameId: "game-1", forkPointSequence: 3, description: "d", proposedBy: "a", invitedSeats: [] });
    registry.propose({ id: "f3", parentGameId: "game-2", forkPointSequence: 1, description: "d", proposedBy: "a", invitedSeats: [] });

    expect(registry.forksOf("game-1").map((r) => r.id).sort()).toEqual(["f1", "f2"]);
    expect(registry.forksOf("game-2").map((r) => r.id)).toEqual(["f3"]);
  });
});

describe("SeatMap", () => {
  it("assign/get and independent clone()", () => {
    const original = new SeatMap();
    original.assign("fixer-A", "user-123");

    const clone = original.clone();
    clone.assign("fixer-A", "user-456"); // a different real player takes over the seat in the fork
    clone.assign("fixer-B", "user-789");

    expect(original.get("fixer-A")).toBe("user-123");
    expect(original.get("fixer-B")).toBeUndefined();
    expect(clone.get("fixer-A")).toBe("user-456");
    expect(clone.get("fixer-B")).toBe("user-789");
  });
});

/** Shared registrations for the materializeFork tests — same shakedown scenario as the persistence tests. */
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
  return { bus, entities, modifiers, resolver, actions, ruleTable, deps };
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

describe("materializeFork: end-to-end", () => {
  it("reconstructs state at the fork point (not including commands after it), independent of the parent", () => {
    const log = new EventLog();
    const live = buildRegistrations();
    seedFixtures(live);

    const intent: ActionContext = { performerId: "performer-1", actingFixerId: "fixer-A", targetIds: ["target-1"] };
    performActionAndLog(log, "shakedown", intent, () => performAction(intent, live.actions.get("shakedown")!, live.deps)); // seq 0
    performActionAndLog(log, "shakedown", intent, () => performAction(intent, live.actions.get("shakedown")!, live.deps)); // seq 1

    const forks = new ForkRegistry();
    const record = forks.propose({
      id: "fork-1",
      parentGameId: "game-1",
      forkPointSequence: 0, // only the FIRST shakedown
      description: "what if I'd stopped after one shakedown",
      proposedBy: "fixer-A",
      invitedSeats: ["fixer-B"],
    });
    forks.accept(record.id);

    const forkRig = buildRegistrations(); // fresh, empty stores + fresh registrations
    seedFixtures(forkRig); // replay-from-scratch only replays LOGGED commands, not the initial setup — same baseline as `live`
    const { log: forkLog, ruleTable: forkRuleTable } = materializeFork(forks.get("fork-1")!, {
      parentLog: log,
      parentRuleTable: live.ruleTable,
      parentSeatMap: new SeatMap(),
      entities: forkRig.entities,
      modifiers: forkRig.modifiers,
      hierarchies: [],
      stacks: [],
      pendingActionRegistry: null,
      lookupAction: () => undefined,
      replayHandlers: {
        performAction: (actionId, replayIntent) => performAction(replayIntent, forkRig.actions.get(actionId)!, forkRig.deps),
        advancePhase: () => {
          throw new Error("not used in this test");
        },
        pass: () => {
          throw new Error("not used in this test");
        },
      },
    });

    // reflects state after only ONE shakedown, not two
    expect(forkRig.resolver.getProperty("fixer-A", "resources")).toBe(6);
    expect(forkRig.resolver.getProperty("target-1", "inflow")).toBe(2);
    expect(forkRig.entities.get("fixer-A")?.properties.reputation).toBe(1);

    // the fork's log inherited exactly one command and can diverge independently
    expect(forkLog.getAll().map((c) => c.sequence)).toEqual([0]);
    forkLog.append({ kind: "phaseAdvance" });
    expect(forkLog.getAll().map((c) => c.sequence)).toEqual([0, 1]);
    expect(log.getAll().map((c) => c.sequence)).toEqual([0, 1]); // parent untouched

    // the fork's rule table is an independent clone
    forkRuleTable.remove("shakedown-bonus");
    expect(forkRuleTable.getForTrigger("action:resolved")).toEqual([]);
    expect(live.ruleTable.getForTrigger("action:resolved")).toHaveLength(1); // parent untouched
  });

  it("gives the fork its own fresh RNG seed, never the parent's — otherwise every post-fork random outcome would be predictable", () => {
    const parentSeed = 123456;
    const log = new EventLog(parentSeed);
    const live = buildRegistrations();
    seedFixtures(live);

    const forks = new ForkRegistry();
    const record = forks.propose({
      id: "fork-reseed",
      parentGameId: "game-1",
      forkPointSequence: -1, // fork from the very start
      description: "checking the fork doesn't inherit the parent's seed",
      proposedBy: "fixer-A",
      invitedSeats: [],
    });
    forks.accept(record.id);

    // the record itself already carries a distinct seed, generated at propose() time
    expect(record.seed).not.toBe(parentSeed);
    expect(typeof record.seed).toBe("number");

    const forkRig = buildRegistrations();
    seedFixtures(forkRig);
    const { log: forkLog } = materializeFork(forks.get("fork-reseed")!, {
      parentLog: log,
      parentRuleTable: live.ruleTable,
      parentSeatMap: new SeatMap(),
      entities: forkRig.entities,
      modifiers: forkRig.modifiers,
      hierarchies: [],
      stacks: [],
      pendingActionRegistry: null,
      lookupAction: () => undefined,
      replayHandlers: {
        performAction: () => ({ ok: true }), // fork point is -1, nothing to replay
        advancePhase: () => ({ ok: true }),
        pass: () => ({ ok: true }),
      },
    });

    // the materialized fork's log carries the fork's seed, not the parent's
    expect(forkLog.seed).toBe(record.seed);
    expect(forkLog.seed).not.toBe(log.seed);
  });

  it("using a snapshot at the fork point replays zero additional commands and gives the same result", () => {
    const log = new EventLog();
    const live = buildRegistrations();
    seedFixtures(live);

    const intent: ActionContext = { performerId: "performer-1", actingFixerId: "fixer-A", targetIds: ["target-1"] };
    performActionAndLog(log, "shakedown", intent, () => performAction(intent, live.actions.get("shakedown")!, live.deps)); // seq 0

    const snapshot = createSnapshot(live.entities, live.modifiers, 0, [], [], null); // reflects state through seq 0 only

    performActionAndLog(log, "shakedown", intent, () => performAction(intent, live.actions.get("shakedown")!, live.deps)); // seq 1

    const forks = new ForkRegistry();
    const record = forks.propose({
      id: "fork-2",
      parentGameId: "game-1",
      forkPointSequence: 0,
      description: "same fork point as the snapshot",
      proposedBy: "fixer-A",
      invitedSeats: [],
    });
    forks.accept(record.id);

    const forkRig = buildRegistrations();
    materializeFork(forks.get("fork-2")!, {
      parentLog: log,
      parentRuleTable: live.ruleTable,
      parentSeatMap: new SeatMap(),
      baseSnapshot: snapshot,
      entities: forkRig.entities,
      modifiers: forkRig.modifiers,
      hierarchies: [],
      stacks: [],
      pendingActionRegistry: null,
      lookupAction: () => undefined,
      replayHandlers: {
        performAction: () => {
          throw new Error("should not need to replay anything — the snapshot already covers the fork point");
        },
        advancePhase: () => {
          throw new Error("not used in this test");
        },
        pass: () => {
          throw new Error("not used in this test");
        },
      },
    });

    expect(forkRig.resolver.getProperty("fixer-A", "resources")).toBe(6);
    expect(forkRig.resolver.getProperty("target-1", "inflow")).toBe(2);
  });

  it("refuses to materialize a fork that hasn't been accepted", () => {
    const log = new EventLog();
    const live = buildRegistrations();
    seedFixtures(live);

    const forks = new ForkRegistry();
    const record = forks.propose({
      id: "fork-3",
      parentGameId: "game-1",
      forkPointSequence: -1,
      description: "d",
      proposedBy: "fixer-A",
      invitedSeats: ["fixer-B"],
    });

    const forkRig = buildRegistrations();
    expect(() =>
      materializeFork(record, {
        parentLog: log,
        parentRuleTable: live.ruleTable,
        parentSeatMap: new SeatMap(),
        entities: forkRig.entities,
        modifiers: forkRig.modifiers,
        hierarchies: [],
      stacks: [],
      pendingActionRegistry: null,
      lookupAction: () => undefined,
        replayHandlers: {
          performAction: () => ({ ok: true }),
          advancePhase: () => ({ ok: true }),
          pass: () => ({ ok: true }),
        },
      }),
    ).toThrow(/must be accepted/);
  });
});
