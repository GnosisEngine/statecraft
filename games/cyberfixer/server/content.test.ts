import { describe, expect, it } from "vitest";
import { createCard } from "../../../src/core/entity.ts";
import { EventBus } from "../../../src/events/bus.ts";
import { evaluateBoolExpr } from "../../../src/query/interpreter.ts";
import { EntityStore } from "../../../src/events/entity-store.ts";
import { ModifierStore } from "../../../src/properties/modifier-store.ts";
import { PropertyResolver } from "../../../src/properties/property-resolver.ts";
import { SeededRandom, deriveSeed } from "../../../src/persistence/seeded-random.ts";
import { RandomRegistry } from "../../../src/persistence/random-registry.ts";
import { RuleEngine } from "../../../src/rules/rule-engine.ts";
import { performAction, proposeAction, type PerformActionDeps } from "../../../src/actions/pipeline.ts";
import type { ActionDefinition } from "../../../src/actions/action-definition.ts";
import { gameConfig } from "../game.config.ts";
import {
  buildContent,
  recomputeInflow,
  boardZoneIdFor,
  deckZoneIdFor,
  discardZoneIdFor,
  handZoneIdFor,
  CONTRACT_TAG,
  CONTRACT_TYPE_TAG_PREFIX,
} from "./content.ts";
import { deckRandomDomain } from "./deck.ts";
import { setupMatch } from "./setup.ts";

const TEST_MASTER_SEED = 1;

function makeRig() {
  const bus = new EventBus();
  const entities = new EntityStore(bus);
  const modifiers = new ModifierStore(bus);
  const content = buildContent(gameConfig.seatOrder, bus, entities);
  const resolver = new PropertyResolver(entities, modifiers, content.queryFunctions, content.bounds, content.hierarchies);
  const randomRegistry = new RandomRegistry();
  for (const fixerId of gameConfig.seatOrder) {
    randomRegistry.register(deckRandomDomain(fixerId), new SeededRandom(deriveSeed(TEST_MASTER_SEED, deckRandomDomain(fixerId))));
  }
  const ruleEngine = new RuleEngine(content.ruleTable, content.ruleHandlers, entities, modifiers, resolver, new SeededRandom(TEST_MASTER_SEED), randomRegistry);
  ruleEngine.wire(bus);
  setupMatch(entities, gameConfig.seatOrder, content.deck);
  // Mirrors what room.ts does before turnCycle.start(): inflow must be
  // seeded for real before anyone's outflow budget (bounded by inflow)
  // gets reset, or it would cap at a stale placeholder.
  recomputeInflow(gameConfig.seatOrder, entities, resolver);
  // This rig deliberately never constructs a real Match/TurnCycle (see
  // startTurn's own synthetic events below) — but draft/ready now
  // require phase:pregame to be tagged (see content.ts's own
  // timingCondition on both), which a real Match.start() would set via
  // pregame's own phase:started. Emitted here, once, so every test
  // using this rig starts in the same state a real match would.
  bus.emit({ type: "phase:started", phaseId: "pregame", subjectId: "table-1" });
  const deps: PerformActionDeps = {
    entities,
    resolver,
    modifiers,
    handlers: content.effectHandlers,
    bus,
    random: new SeededRandom(TEST_MASTER_SEED),
    randomRegistry,
  };
  return { bus, entities, resolver, content, deps };
}

/** Fires the same event a real turn start would (see room.ts / TurnCycle) — resets `fixerId`'s outflow budget, ticks the draw rule, etc. */
function startTurn(bus: EventBus, fixerId: string) {
  // Emits BOTH phases in sequence, matching the real upkeep -> main
  // transition — reset-outflow-budget, sync-active-turn, draw-card,
  // increment-turn-counter, tick-contract-penalties, and
  // recompute-contracts are all scoped to phaseId === "upkeep" (see
  // content.ts's own phase restructuring); deploy/shakedown's own
  // timingCondition additionally requires phase:main to be tagged on
  // the table (see sync-current-phase) before either is legal — a test
  // calling startTurn wants to land somewhere agency actually works,
  // not stuck mid-upkeep.
  bus.emit({ type: "phase:started", phaseId: "upkeep", subjectId: fixerId });
  bus.emit({ type: "phase:started", phaseId: "main", subjectId: fixerId });
}

function findByName(entities: EntityStore, name: string) {
  return [...entities.getAllEntities()].find((e) => (e as { name?: string }).name === name)!;
}

/** Drafts exactly the 3 named cards for `fixerId` — the deck is shuffled, so tests pick by name, not position. */
function draft(entities: EntityStore, content: ReturnType<typeof buildContent>, deps: PerformActionDeps, fixerId: string, names: string[]) {
  const targetIds = names.map((name) => findByName(entities, name).id);
  return performAction({ performerId: fixerId, actingFixerId: fixerId, targetIds }, content.actions.get("draft")!, deps);
}

/** Places a contract card directly in play — contracts aren't dealt via the deck yet (see content.ts's header), so tests place them the same way setupMatch used to place starting contractors. */
function placeContract(entities: EntityStore, fixerId: string, contractId: string, defId: string) {
  const card = createCard(`Contract: ${defId}`, {
    id: contractId,
    zoneId: `${fixerId}-board`,
    ownership: [fixerId],
  });
  card.tags.add(CONTRACT_TAG);
  card.tags.add(`${CONTRACT_TYPE_TAG_PREFIX}${defId}`);
  entities.add(card);
  return card;
}

describe("setupMatch", () => {
  it("gives each fixer 5 contractors in an unordered deck pool, empty hand/board, and correct zone visibility", () => {
    const { entities, resolver, content } = makeRig();
    for (const fixerId of gameConfig.seatOrder) {
      expect(content.deck.poolIds(fixerId)).toHaveLength(5);

      const deckZone = entities.get(deckZoneIdFor(fixerId));
      const handZone = entities.get(handZoneIdFor(fixerId));
      const board = entities.get(boardZoneIdFor(fixerId));
      expect((deckZone as { visibility?: string })?.visibility).toBe("owner-only");
      expect((handZone as { visibility?: string })?.visibility).toBe("owner-only");
      expect((board as { visibility?: string })?.visibility).toBe("public");

      // nothing is in play yet — inflow/outflow are both 0 until drafting happens
      expect(resolver.getProperty(fixerId, "inflow")).toBe(0);
      expect(resolver.getProperty(fixerId, "outflow")).toBe(0);
    }
  });

  it("fixers are self-owned, so they can act as a performer for actions with no natural contractor (e.g. draft)", () => {
    const { entities } = makeRig();
    const fixer = entities.get("fixer-A");
    expect(fixer?.ownership).toEqual(["fixer-A"]);
  });
});

describe("draft: pregame, pick exactly 3 from your own deck straight onto your board", () => {
  it("moves the 3 chosen cards onto the board, removes them from the deck, and tags the fixer drafted", () => {
    const { entities, resolver, content, deps } = makeRig();
    const result = draft(entities, content, deps, "fixer-A", ["Ace", "Nomad", "Vex"]);

    expect(result.ok).toBe(true);
    expect(findByName(entities, "Ace").zoneId).toBe(boardZoneIdFor("fixer-A"));
    expect(findByName(entities, "Nomad").zoneId).toBe(boardZoneIdFor("fixer-A"));
    expect(findByName(entities, "Vex").zoneId).toBe(boardZoneIdFor("fixer-A"));

    const remaining = content.deck.poolIds("fixer-A");
    expect(remaining).toHaveLength(2); // 5 - 3 drafted
    expect(remaining).not.toContain(findByName(entities, "Ace").id);

    expect(entities.get("fixer-A")?.tags.has("drafted")).toBe(true);
    // inflow now reflects the 3 drafted contractors
    expect(resolver.getProperty("fixer-A", "inflow")).toBeGreaterThan(0);
  });

  it("works regardless of whose turn it is — draft is not turn-gated", () => {
    const { entities, content, deps } = makeRig();
    // fixer-B drafts even though fixer-A is the active fixer at match start
    const result = draft(entities, content, deps, "fixer-B", ["Runner", "Sentinel", "Cipher"]);
    expect(result.ok).toBe(true);
  });

  it("rejects drafting a second time", () => {
    const { entities, content, deps } = makeRig();
    draft(entities, content, deps, "fixer-A", ["Ace", "Nomad", "Vex"]);
    const second = draft(entities, content, deps, "fixer-A", ["Ghost", "Rook", "Ace"]);
    expect(second.ok).toBe(false);
  });

  it("rejects picking a card from someone else's deck", () => {
    const { entities, content, deps } = makeRig();
    const result = draft(entities, content, deps, "fixer-A", ["Ace", "Nomad", "Runner"]); // Runner belongs to fixer-B
    expect(result.ok).toBe(false);
  });

  it("rejects picking anything other than exactly 3", () => {
    const { entities, content, deps } = makeRig();
    const two = draft(entities, content, deps, "fixer-A", ["Ace", "Nomad"]);
    expect(two.ok).toBe(false);
  });
});

describe("draw-card: automatic, once per turn, only after drafting", () => {
  it("does not draw before the fixer has drafted", () => {
    const { entities, bus } = makeRig();
    startTurn(bus, "fixer-A");
    const handZone = handZoneIdFor("fixer-A");
    const inHand = [...entities.getAllEntities()].filter((e) => e.zoneId === handZone);
    expect(inHand).toHaveLength(0);
  });

  it("draws exactly one card from the remaining pool into hand, once per turn, after drafting", () => {
    const { entities, content, deps, bus } = makeRig();
    draft(entities, content, deps, "fixer-A", ["Ace", "Nomad", "Vex"]);
    const poolBefore = content.deck.poolIds("fixer-A");
    expect(poolBefore).toHaveLength(2); // 5 - 3 drafted

    startTurn(bus, "fixer-A");

    const poolAfter = content.deck.poolIds("fixer-A");
    expect(poolAfter).toHaveLength(1); // one drawn
    const drawnId = poolBefore.find((id) => !poolAfter.includes(id))!;
    expect(entities.get(drawnId)?.zoneId).toBe(handZoneIdFor("fixer-A"));
    // drawn card is no longer classified in the deck hierarchy at all
    expect(content.deck.isUnclassified(drawnId)).toBe(true);
  });

  it("draw order is genuinely undecided ahead of time — deriving the SAME seed twice draws the SAME card (determinism), but nothing before the draw reveals which one that will be", () => {
    // two independent rigs, same fixed test seed — the deck pool holds no
    // order at all before the draw, only Hierarchy.drawRandom decides it,
    // consuming the fixer's own isolated stream
    const rigA = makeRig();
    draft(rigA.entities, rigA.content, rigA.deps, "fixer-A", ["Ace", "Nomad", "Vex"]);
    startTurn(rigA.bus, "fixer-A");
    const drawnA = rigA.content.deck.poolIds("fixer-A");

    const rigB = makeRig();
    draft(rigB.entities, rigB.content, rigB.deps, "fixer-A", ["Ace", "Nomad", "Vex"]);
    startTurn(rigB.bus, "fixer-A");
    const drawnB = rigB.content.deck.poolIds("fixer-A");

    // same names drafted, same test seed -> the SAME remaining pool composition
    const namesRemaining = (entities: EntityStore, ids: string[]) => ids.map((id) => (entities.get(id) as { name?: string })?.name).sort();
    expect(namesRemaining(rigA.entities, drawnA)).toEqual(namesRemaining(rigB.entities, drawnB));
  });

  it("does nothing (no error) once the deck is empty", () => {
    const { content, deps, entities, bus } = makeRig();
    draft(entities, content, deps, "fixer-A", ["Ace", "Nomad", "Vex"]);
    startTurn(bus, "fixer-A"); // draws 1 of 2 remaining
    startTurn(bus, "fixer-A"); // draws the last 1
    expect(() => startTurn(bus, "fixer-A")).not.toThrow(); // pool now empty — should just no-op
    expect(content.deck.poolIds("fixer-A")).toHaveLength(0);
  });
});

describe("deploy: play a card from hand onto the board, spending outflow", () => {
  it("moves the card to the board and costs outflow", () => {
    const { entities, resolver, content, deps, bus } = makeRig();
    draft(entities, content, deps, "fixer-A", ["Ace", "Nomad", "Vex"]);
    startTurn(bus, "fixer-A"); // resets outflow to 4 (Ace 2 + Nomad 2 + Vex 1 = 5, capped... let's just check post-draw
    const ghostOrRook = [...entities.getAllEntities()].find((e) => e.zoneId === handZoneIdFor("fixer-A"))!;

    const outflowBefore = resolver.getProperty("fixer-A", "outflow");
    const result = performAction({ performerId: ghostOrRook.id, actingFixerId: "fixer-A", targetIds: [] }, content.actions.get("deploy")!, deps);

    expect(result).toEqual({ ok: true, adjustedCost: 2, capability: "neutral" });
    expect(ghostOrRook.zoneId).toBe(boardZoneIdFor("fixer-A"));
    expect(resolver.getProperty("fixer-A", "outflow")).toBe(outflowBefore! - 2);
  });

  it("rejects deploying a card that isn't currently in any hand (e.g. still in the deck)", () => {
    const { entities, content, deps } = makeRig();
    draft(entities, content, deps, "fixer-A", ["Ace", "Nomad", "Vex"]);
    const stillInDeck = [...entities.getAllEntities()].find((e) => e.zoneId === deckZoneIdFor("fixer-A"))!;

    const result = performAction(
      { performerId: stillInDeck.id, actingFixerId: "fixer-A", targetIds: [] },
      content.actions.get("deploy")!,
      deps,
    );
    expect(result.ok).toBe(false);
  });
});

describe("shakedown action + metric/defeat rule chain", () => {
  function draftBoth(rig: ReturnType<typeof makeRig>) {
    draft(rig.entities, rig.content, rig.deps, "fixer-A", ["Ace", "Nomad", "Vex"]);
    draft(rig.entities, rig.content, rig.deps, "fixer-B", ["Runner", "Sentinel", "Cipher"]);
  }

  it("costs outflow, debuffs the target's inflow, and recomputes inflow but not outflow", () => {
    const rig = makeRig();
    const { bus, entities, resolver, content, deps } = rig;
    draftBoth(rig);
    startTurn(bus, "fixer-A");
    const ace = findByName(entities, "Ace"); // fixer-A, pref:coercion
    const runner = findByName(entities, "Runner"); // fixer-B

    const result = performAction(
      { performerId: ace.id, actingFixerId: "fixer-A", targetIds: [runner.id], params: { abilityId: "shakedown" } },
      content.actions.get("activate")!,
      deps,
    );

    expect(result).toEqual({ ok: true, adjustedCost: 2, capability: "preferred" }); // Ace prefers coercion: floor(4/2)=2 — delegated through activate's category()
    expect(runner.tags.has("shaken")).toBe(true);
    expect(resolver.getProperty(runner.id, "inflow")).toBe(0); // 3 - 3

    expect(entities.get("fixer-B")?.properties.inflow).toBe(5); // Runner's 0 + Sentinel's 3 + Cipher's 2
  });

  it("rejects targeting a contractor that hasn't been drafted onto the board yet", () => {
    const rig = makeRig();
    const { bus, entities, content, deps } = rig;
    draft(entities, content, deps, "fixer-A", ["Ace", "Nomad", "Vex"]);
    startTurn(bus, "fixer-A");
    const ace = findByName(entities, "Ace");
    const stillInFixerBsDeck = findByName(entities, "Runner"); // fixer-B hasn't drafted at all

    const result = performAction(
      { performerId: ace.id, actingFixerId: "fixer-A", targetIds: [stillInFixerBsDeck.id], params: { abilityId: "shakedown" } },
      content.actions.get("activate")!,
      deps,
    );
    expect(result.ok).toBe(false);
  });

  it("rejects a shakedown against a fixer's own contractor", () => {
    const rig = makeRig();
    const { bus, entities, content, deps } = rig;
    draftBoth(rig);
    startTurn(bus, "fixer-A");
    const ace = findByName(entities, "Ace");
    const nomad = findByName(entities, "Nomad"); // also fixer-A's

    const result = performAction(
      { performerId: ace.id, actingFixerId: "fixer-A", targetIds: [nomad.id], params: { abilityId: "shakedown" } },
      content.actions.get("activate")!,
      deps,
    );
    expect(result.ok).toBe(false);
  });
});

describe("ready: pregame lobby gate", () => {
  it("rejects readying up before drafting", () => {
    const { content, deps } = makeRig();
    const result = performAction({ performerId: "fixer-A", actingFixerId: "fixer-A", targetIds: [] }, content.actions.get("ready")!, deps);
    expect(result.ok).toBe(false);
  });

  it("succeeds after drafting, increments readyCount, and rejects a second ready", () => {
    const { entities, resolver, content, deps } = makeRig();
    draft(entities, content, deps, "fixer-A", ["Ace", "Nomad", "Vex"]);

    const first = performAction({ performerId: "fixer-A", actingFixerId: "fixer-A", targetIds: [] }, content.actions.get("ready")!, deps);
    expect(first.ok).toBe(true);
    expect(resolver.getProperty("table-1", "readyCount")).toBe(1);
    expect(entities.get("fixer-A")?.tags.has("ready")).toBe(true);

    const second = performAction({ performerId: "fixer-A", actingFixerId: "fixer-A", targetIds: [] }, content.actions.get("ready")!, deps);
    expect(second.ok).toBe(false);
    expect(resolver.getProperty("table-1", "readyCount")).toBe(1); // unchanged
  });

  it("the pregame gate opens only once EVERY fixer has readied up", () => {
    const { entities, resolver, content, deps } = makeRig();
    draft(entities, content, deps, "fixer-A", ["Ace", "Nomad", "Vex"]);
    draft(entities, content, deps, "fixer-B", ["Runner", "Sentinel", "Cipher"]);
    performAction({ performerId: "fixer-A", actingFixerId: "fixer-A", targetIds: [] }, content.actions.get("ready")!, deps);

    const gate = content.pregamePhase.completionGate;
    const table = entities.get("table-1")!;
    expect(evaluateBoolExpr(gate, table.id, resolver)).toBe(false); // only 1 of 2 ready

    performAction({ performerId: "fixer-B", actingFixerId: "fixer-B", targetIds: [] }, content.actions.get("ready")!, deps);
    expect(evaluateBoolExpr(gate, table.id, resolver)).toBe(true);
  });
});

describe("contracts", () => {
  it("pays base + bonus while its condition holds (no AI anywhere in play) — recomputed at the next upkeep, not immediately", () => {
    const { bus, entities, resolver, content, deps } = makeRig();
    draft(entities, content, deps, "fixer-A", ["Ace", "Nomad", "Vex"]);
    draft(entities, content, deps, "fixer-B", ["Runner", "Sentinel", "Cipher"]);
    startTurn(bus, "fixer-A");
    const contract = placeContract(entities, "fixer-A", "contract-1", "no-ai-bonus");

    const ace = findByName(entities, "Ace");
    const runner = findByName(entities, "Runner");
    performAction({ performerId: ace.id, actingFixerId: "fixer-A", targetIds: [runner.id], params: { abilityId: "shakedown" } }, content.actions.get("activate")!, deps);

    // contracts recompute at upkeep — a discrete, once-per-turn reckoning,
    // not a continuous reaction to every action (see content.ts's own
    // recompute-contracts binding for why) — so this needs one more
    // upkeep to actually take effect.
    startTurn(bus, "fixer-A");
    expect(resolver.getProperty(contract.id, "inflow")).toBe(6); // 1 base + 5 bonus, no AI in play
  });

  it("cancels, zeroes its own contribution, discards, and applies the penalty at the next upkeep after an AI enters play — never mid-turn, and never counterable, since it doesn't go through the stack at all", () => {
    const { bus, entities, resolver, content, deps } = makeRig();
    draft(entities, content, deps, "fixer-A", ["Ace", "Nomad", "Vex"]);
    draft(entities, content, deps, "fixer-B", ["Runner", "Sentinel", "Cipher"]);
    startTurn(bus, "fixer-A");
    const contract = placeContract(entities, "fixer-A", "contract-1", "no-ai-bonus");

    const aiUnit = createCard("Rogue AI", { zoneId: boardZoneIdFor("fixer-B"), ownership: ["fixer-B"] });
    aiUnit.tags.add("ai");
    entities.add(aiUnit);

    const ace = findByName(entities, "Ace");
    const runner = findByName(entities, "Runner");
    performAction({ performerId: ace.id, actingFixerId: "fixer-A", targetIds: [runner.id], params: { abilityId: "shakedown" } }, content.actions.get("activate")!, deps);

    // the AI is already in play, but cancellation hasn't happened YET —
    // it's not "instant" anymore, it waits for the next upkeep
    expect(contract.zoneId).toBe(boardZoneIdFor("fixer-A"));

    startTurn(bus, "fixer-A");
    expect(contract.zoneId).toBe(discardZoneIdFor("fixer-A"));
    expect(resolver.getProperty(contract.id, "inflow")).toBe(0);
  });

  it("the cancellation penalty expires after exactly 3 turns since discard — not 2, not 4", () => {
    const { bus, entities, resolver, content, deps } = makeRig();
    draft(entities, content, deps, "fixer-A", ["Ace", "Nomad", "Vex"]);
    draft(entities, content, deps, "fixer-B", ["Runner", "Sentinel", "Cipher"]);
    startTurn(bus, "fixer-A");
    placeContract(entities, "fixer-A", "contract-1", "no-ai-bonus");
    const aiUnit = createCard("Rogue AI", { zoneId: boardZoneIdFor("fixer-B"), ownership: ["fixer-B"] });
    aiUnit.tags.add("ai");
    entities.add(aiUnit);

    const ace = findByName(entities, "Ace");
    const runner = findByName(entities, "Runner");
    performAction({ performerId: ace.id, actingFixerId: "fixer-A", targetIds: [runner.id], params: { abilityId: "shakedown" } }, content.actions.get("activate")!, deps);

    const emitTurn = () => startTurn(bus, "fixer-A");
    emitTurn(); // the upkeep where cancellation/discard/penalty actually happen
    const inflowAfterDiscard = resolver.getProperty("fixer-A", "inflow")!;
    emitTurn();
    expect(resolver.getProperty("fixer-A", "inflow")).toBe(inflowAfterDiscard);
    emitTurn();
    expect(resolver.getProperty("fixer-A", "inflow")).toBe(inflowAfterDiscard);
    emitTurn();
    expect(resolver.getProperty("fixer-A", "inflow")).toBe(inflowAfterDiscard + 1); // penalty (-1) removed
  });
});

describe("pass-priority mechanism: the simplified, non-rotating pass tracker", () => {
  it("allFixersPassed is false until BOTH fixers have passed, true once they have — a plain fold, not a stateful counter", () => {
    const { entities, resolver, content } = makeRig();
    const table = entities.get("table-1")!;

    expect(evaluateBoolExpr(content.allFixersPassed, table.id, resolver)).toBe(false); // nobody's passed yet
    entities.addTag("fixer-A", "passed-priority");
    expect(evaluateBoolExpr(content.allFixersPassed, table.id, resolver)).toBe(false); // only one of two
    entities.addTag("fixer-B", "passed-priority");
    expect(evaluateBoolExpr(content.allFixersPassed, table.id, resolver)).toBe(true); // both now
  });

  it("pushing a new item onto the shared stack clears BOTH fixers' passed-priority — a fresh proposal means everyone gets a fresh chance to react", () => {
    const { entities, resolver, content } = makeRig();
    const table = entities.get("table-1")!;
    entities.addTag("fixer-A", "passed-priority");
    entities.addTag("fixer-B", "passed-priority");
    expect(evaluateBoolExpr(content.allFixersPassed, table.id, resolver)).toBe(true);

    entities.add(createCard("Grievance", { id: "grievance" }));
    content.stack.push("grievance", null);

    expect(entities.get("fixer-A")?.tags.has("passed-priority")).toBe(false);
    expect(entities.get("fixer-B")?.tags.has("passed-priority")).toBe(false);
    expect(evaluateBoolExpr(content.allFixersPassed, table.id, resolver)).toBe(false);
  });

  it("'Filibuster': resolving something that exposes NOTHING new still clears passed-priority — the actual bug this fix targets. Binding the reset only to the exposedAfter* events would have missed this exact case, since neither of them fires when a standalone root resolves", () => {
    const { entities, resolver, content } = makeRig();
    const table = entities.get("table-1")!;
    entities.add(createCard("Standalone", { id: "standalone" }));
    content.stack.push("standalone", null); // a root with no children — resolving it exposes nothing

    entities.addTag("fixer-A", "passed-priority");
    entities.addTag("fixer-B", "passed-priority");
    expect(evaluateBoolExpr(content.allFixersPassed, table.id, resolver)).toBe(true);

    content.stack.resolveNext(content.resolutionPolicy, resolver);

    // if the reset were bound only to stack:exposedAfterResolution, this
    // would still read true here — nothing would have cleared it, and a
    // NEXT pending item (if one existed) would silently auto-resolve
    // without either fixer getting a real chance to react to the board
    // having just changed.
    expect(evaluateBoolExpr(content.allFixersPassed, table.id, resolver)).toBe(false);
  });

  it("resolving an item that DOES expose a new leaf still only takes one reset, and the newly-exposed item requires its own fresh round of passing before it can resolve", () => {
    const { entities, resolver, content } = makeRig();
    const table = entities.get("table-1")!;
    entities.add(createCard("Root grievance", { id: "root" }));
    entities.add(createCard("Response", { id: "response" }));
    content.stack.push("root", null);
    content.stack.push("response", "root"); // response buries root — root is no longer a leaf

    entities.addTag("fixer-A", "passed-priority");
    entities.addTag("fixer-B", "passed-priority");
    content.stack.resolveNext(content.resolutionPolicy, resolver); // resolves "response", exposing "root"

    expect(content.stack.leaves()).toEqual(["root"]);
    expect(evaluateBoolExpr(content.allFixersPassed, table.id, resolver)).toBe(false); // reset — root needs its own fresh round
  });
});


describe("'Reflex': a rule can react to a pass itself — entity:tagAdded fires for passed-priority like any other tag, no special engine hook needed", () => {
  it("a rule bound to entity:tagAdded (matched on tag === 'passed-priority') fires when a fixer passes, and can push a new item as its own reaction — even AFTER the rule engine is already wired, proving rules aren't a fixed snapshot taken at wire() time", () => {
    const { entities, resolver, content } = makeRig();
    const table = entities.get("table-1")!;

    let reflexFired = 0;
    content.ruleTable.add({
      id: "reflex-test-only",
      trigger: "entity:tagAdded",
      match: (event) => event.tag === "passed-priority",
      effect: "reflexEffect",
    });
    content.ruleHandlers.register("reflexEffect", (_event, api) => {
      reflexFired++;
      api.entities.add(createCard("Reflex response", { id: "reflex-response" }));
      content.stack.push("reflex-response", null);
    });

    entities.addTag("fixer-A", "passed-priority"); // fixer-A passes

    expect(reflexFired).toBe(1);
    expect(content.stack.leaves()).toEqual(["reflex-response"]);

    // the reflex's OWN push fires the SAME reset rule any other push
    // does — clearing passed-priority for BOTH fixers, including
    // fixer-A, whose own pass is what triggered this in the first
    // place. That's correct, not a bug: a genuinely new item just
    // appeared, so everyone — even whoever caused it — gets a fresh
    // chance to react to it.
    expect(entities.get("fixer-A")?.tags.has("passed-priority")).toBe(false);
    expect(evaluateBoolExpr(content.allFixersPassed, table.id, resolver)).toBe(false);
  });
});

describe("'Deadlock': if something is ever pending on the shared stack during upkeep, its own completionGate correctly blocks advancement — the same gate every turn phase shares, not a special case", () => {
  it("upkeep's completionGate reads true when nothing is pending, and false the instant anything is pushed onto the shared stack — even though, by design, nothing in current content ever pushes during upkeep at all", () => {
    const { entities, resolver, content } = makeRig();
    const table = entities.get("table-1")!;
    const upkeepPhase = content.turnPhases.find((p) => p.id === "upkeep")!;

    expect(evaluateBoolExpr(upkeepPhase.completionGate, table.id, resolver)).toBe(true); // nothing pending — upkeep CAN complete

    // Hypothetically: some future rule pushes onto the shared stack
    // during upkeep (nothing today does this — upkeep is fully
    // automatic by design — but Stack itself has no idea which phase
    // is currently active, so nothing stops it mechanically).
    entities.add(createCard("Rogue upkeep push", { id: "rogue-push" }));
    content.stack.push("rogue-push", null);

    expect(evaluateBoolExpr(upkeepPhase.completionGate, table.id, resolver)).toBe(false); // now correctly blocked

    content.stack.resolveNext(content.resolutionPolicy, resolver);
    expect(evaluateBoolExpr(upkeepPhase.completionGate, table.id, resolver)).toBe(true); // and correctly unblocked once it drains
  });

  it("main and end share the identical gate — the same stackDepth check, not three separately-maintained conditions that could drift out of sync with each other", () => {
    const { entities, resolver, content } = makeRig();
    const table = entities.get("table-1")!;
    const upkeepPhase = content.turnPhases.find((p) => p.id === "upkeep")!;
    const mainPhase = content.turnPhases.find((p) => p.id === "main")!;
    const endPhase = content.turnPhases.find((p) => p.id === "end")!;

    entities.add(createCard("Pending item", { id: "pending-item" }));
    content.stack.push("pending-item", null);

    expect(evaluateBoolExpr(upkeepPhase.completionGate, table.id, resolver)).toBe(false);
    expect(evaluateBoolExpr(mainPhase.completionGate, table.id, resolver)).toBe(false);
    expect(evaluateBoolExpr(endPhase.completionGate, table.id, resolver)).toBe(false);
  });
});

describe("'has-active-response' tag: the Option-1 answer to 'nothing else is currently responding to me'", () => {
  it("tags an item the moment something is pushed responding to it, and untags it once that response resolves and exposes it again", () => {
    const { entities, resolver, content } = makeRig();
    entities.add(createCard("Root", { id: "root" }));
    entities.add(createCard("Response", { id: "response" }));
    content.stack.push("root", null);
    expect(entities.get("root")?.tags.has("has-active-response")).toBe(false);

    content.stack.push("response", "root");
    expect(entities.get("root")?.tags.has("has-active-response")).toBe(true);

    content.stack.resolveNext(content.resolutionPolicy, resolver); // resolves "response" — root is exposed
    expect(entities.get("root")?.tags.has("has-active-response")).toBe(false);
  });

  it("countering (not just resolving) a response also correctly untags its former target", () => {
    const { entities, resolver, content } = makeRig();
    entities.add(createCard("Root", { id: "root" }));
    entities.add(createCard("Response", { id: "response" }));
    content.stack.push("root", null);
    content.stack.push("response", "root");
    expect(entities.get("root")?.tags.has("has-active-response")).toBe(true);

    content.stack.counter("response");
    expect(entities.get("root")?.tags.has("has-active-response")).toBe(false);
  });

  it("reparenting a response away from its target untags the target it left, and tags the new one it now responds to", () => {
    const { entities, content } = makeRig();
    entities.add(createCard("Root A", { id: "root-a" }));
    entities.add(createCard("Root B", { id: "root-b" }));
    entities.add(createCard("Response", { id: "response" }));
    content.stack.push("root-a", null);
    content.stack.push("root-b", null);
    content.stack.push("response", "root-a");
    expect(entities.get("root-a")?.tags.has("has-active-response")).toBe(true);
    expect(entities.get("root-b")?.tags.has("has-active-response")).toBe(false);

    content.stack.reparent("response", "root-b");
    expect(entities.get("root-a")?.tags.has("has-active-response")).toBe(false);
    expect(entities.get("root-b")?.tags.has("has-active-response")).toBe(true);
  });

  it("THE SPLICE CASE this whole design turned on: countering a NON-leaf item with multiple children splices them up to the grandparent — which must become tagged even though NEITHER stack:pushed NOR stack:reparented fires for that step", () => {
    const { entities, content } = makeRig();
    entities.add(createCard("Grandparent", { id: "grandparent" }));
    entities.add(createCard("Middle", { id: "middle" }));
    entities.add(createCard("Child A", { id: "child-a" }));
    entities.add(createCard("Child B", { id: "child-b" }));
    content.stack.push("grandparent", null);
    content.stack.push("middle", "grandparent");
    content.stack.push("child-a", "middle");
    content.stack.push("child-b", "middle"); // "middle" now has TWO children

    expect(entities.get("grandparent")?.tags.has("has-active-response")).toBe(true); // has "middle"
    expect(entities.get("middle")?.tags.has("has-active-response")).toBe(true); // has child-a AND child-b

    // counter "middle" — child-a and child-b both splice up to "grandparent"
    content.stack.counter("middle");

    // "middle"'s OWN tag is left stale (still true) — nothing in this
    // design ever explicitly clears it, because the exposure event
    // that fires here is about "middle"'s FORMER PARENT (grandparent),
    // not about "middle" itself, and grandparent still has children
    // after the splice, so no exposure event fires at all in this
    // specific case. This is harmless in real play: room.ts always
    // fully removes a pending-item placeholder entity from EntityStore
    // once it's resolved or countered, so a stale tag on an entity
    // that no longer exists at all can never be observed by anything.
    expect(entities.get("middle")?.tags.has("has-active-response")).toBe(true);
    expect(entities.get("grandparent")?.tags.has("has-active-response")).toBe(true); // STILL true — now via child-a/child-b directly, caught only because this binds to hierarchy:parentChanged, not stack:pushed/reparented
    expect(content.stack.leaves().sort()).toEqual(["child-a", "child-b"]);
  });

  it("the actual targetQuery this tag exists for: 'you may only target something nothing else is currently responding to' now works exactly like active-turn/phase:main/passed-priority already do", () => {
    const { entities, deps, content } = makeRig();
    entities.add(createCard("Contested", { id: "contested" }));
    entities.add(createCard("Uncontested", { id: "uncontested" }));
    content.stack.push("contested", null);
    content.stack.push("uncontested", null);
    entities.add(createCard("Response", { id: "response" }));
    content.stack.push("response", "contested"); // now something responds to "contested"

    const onlyUncontested: ActionDefinition = {
      id: "only-uncontested-target",
      category: () => "test",
      targetsOwn: true,
      targetsOthers: true,
      targetQuery: () => ({ op: "not", expr: { op: "hasTag", tag: "has-active-response" } }),
      effect: "noopUncontestedEffect",
    };
    content.actions.register(onlyUncontested);
    content.effectHandlers.register("noopUncontestedEffect", () => {});
    entities.add(createCard("Performer", { id: "performer", ownership: ["fixer-A"] }));

    const legal = proposeAction({ performerId: "performer", actingFixerId: "fixer-A", targetIds: ["uncontested"] }, onlyUncontested, deps);
    expect(legal.ok).toBe(true);

    const illegal = proposeAction({ performerId: "performer", actingFixerId: "fixer-A", targetIds: ["contested"] }, onlyUncontested, deps);
    expect(illegal.ok).toBe(false);
  });
});
