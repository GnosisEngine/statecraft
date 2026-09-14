/**
 * End-to-end proof that a real cyberfixer match — draft, ready (the
 * lobby transition), automatic draws, shakedown, turn advancement —
 * replays bit-for-bit from a logged command sequence. This is
 * specifically the test that was missing when the hand/deck/RNG-domain
 * work landed: every piece was unit-tested in isolation (Hierarchy's
 * drawRandom, deriveSeed's stream independence, RandomRegistry), but
 * nothing had proven the actual end-to-end claim — that THIS game,
 * played for real, reproduces the same drawn cards in the same order
 * from the same seed.
 *
 * Builds the same stack room.ts does (RuleEngine, PropertyResolver with
 * every registry, TurnCycle/Match, per-fixer isolated deck streams) but
 * without the Colyseus/network layer — that layer is orthogonal to
 * determinism, which lives entirely in the action pipeline / rule
 * engine / phase runner, exactly what this rig exercises directly.
 */

import { describe, expect, it } from "vitest";
import { EventBus } from "../../../src/events/bus.ts";
import { EntityStore } from "../../../src/events/entity-store.ts";
import { ModifierStore } from "../../../src/properties/modifier-store.ts";
import { PropertyResolver } from "../../../src/properties/property-resolver.ts";
import { SeededRandom, deriveSeed } from "../../../src/persistence/seeded-random.ts";
import { RandomRegistry } from "../../../src/persistence/random-registry.ts";
import { RuleEngine } from "../../../src/rules/rule-engine.ts";
import { performAction, type ActionResult, type PerformActionDeps } from "../../../src/actions/pipeline.ts";
import type { ActionContext } from "../../../src/actions/action-definition.ts";
import { PhaseHandlerRegistry } from "../../../src/phases/phase-definition.ts";
import { TurnCycle } from "../../../src/phases/turn-cycle.ts";
import { Match } from "../../../src/phases/match.ts";
import { SubscriptionRegistry } from "../../../src/query/subscriptions.ts";
import { wireQuerySubscriptions } from "../../../src/events/subscriptions-wiring.ts";
import { EventLog } from "../../../src/persistence/event-log.ts";
import { performActionAndLog, advancePhaseAndLog, replayCommands } from "../../../src/persistence/replay.ts";
import { gameConfig } from "../game.config.ts";
import { buildContent, recomputeInflow } from "./content.ts";
import { deckRandomDomain } from "./deck.ts";
import { setupMatch } from "./setup.ts";

/** Builds the full real-game stack — same construction room.ts does, minus the network layer — given a master seed, so two rigs from the same seed are meant to diverge from nothing but replay itself. */
function makeFullRig(masterSeed: number) {
  const bus = new EventBus();
  const entities = new EntityStore(bus);
  const modifiers = new ModifierStore(bus);
  const random = new SeededRandom(masterSeed);
  const randomRegistry = new RandomRegistry();
  for (const fixerId of gameConfig.seatOrder) {
    randomRegistry.register(deckRandomDomain(fixerId), new SeededRandom(deriveSeed(masterSeed, deckRandomDomain(fixerId))));
  }

  const content = buildContent(gameConfig.seatOrder, bus, entities);
  const resolver = new PropertyResolver(entities, modifiers, content.queryFunctions, content.bounds, content.hierarchies);
  const ruleEngine = new RuleEngine(content.ruleTable, content.ruleHandlers, entities, modifiers, resolver, random, randomRegistry);
  ruleEngine.wire(bus);

  setupMatch(entities, gameConfig.seatOrder, content.deck);
  recomputeInflow(gameConfig.seatOrder, entities, resolver);

  const deps: PerformActionDeps = { entities, resolver, modifiers, handlers: content.effectHandlers, bus, random, randomRegistry };

  const registry = new SubscriptionRegistry();
  wireQuerySubscriptions(bus, registry);
  const phaseRunnerDeps = {
    entities,
    modifiers,
    random,
    randomRegistry,
    resolver,
    registry,
    handlers: new PhaseHandlerRegistry(),
    bus,
    hierarchies: content.hierarchies,
  };
  const turnCycle = new TurnCycle(content.turnPhases, gameConfig.seatOrder, "table-1", phaseRunnerDeps);
  const match = new Match(content.pregamePhase, content.postgamePhase, turnCycle, "table-1", phaseRunnerDeps);
  match.start();

  return { entities, resolver, content, deps, match };
}

function findByName(entities: EntityStore, name: string) {
  return [...entities.getAllEntities()].find((e) => (e as { name?: string }).name === name)!;
}

/** Mirrors room.ts's own orchestration: after a "ready" succeeds, if the lobby gate is now satisfied, seed inflow for real and advance the match — logged as its own phaseAdvance command, exactly like room.ts's actual tryAdvance() call. */
function readyAndMaybeAdvance(
  rig: ReturnType<typeof makeFullRig>,
  log: EventLog,
  fixerId: string,
): ActionResult {
  const result = performActionAndLog(
    log,
    "ready",
    { performerId: fixerId, actingFixerId: fixerId, targetIds: [] },
    () => performAction({ performerId: fixerId, actingFixerId: fixerId, targetIds: [] }, rig.content.actions.get("ready")!, rig.deps),
  );
  if (result.ok && rig.match.stage === "pregame" && rig.match.canAdvance()) {
    recomputeInflow(gameConfig.seatOrder, rig.entities, rig.resolver);
    advancePhaseAndLog(log, () => rig.match.tryAdvance()); // pregame -> upkeep (turnPhases[0])
    advancePhaseAndLog(log, () => rig.match.tryAdvance()); // upkeep -> main — agency (deploy/activate) is only legal here now, see phase:main gating
  }
  return result;
}

/** Plays a full, realistic sequence — draft, ready (through the lobby), a shakedown, a turn advance, another shakedown, another turn advance — logging every command. Returns the log and a snapshot of the facts a replay needs to reproduce exactly, including which specific cards ended up where (the actual point of this test). */
function playFullSequence(rig: ReturnType<typeof makeFullRig>, log: EventLog) {
  const aliceCards = ["Ace", "Nomad", "Vex"].map((n) => findByName(rig.entities, n).id);
  performActionAndLog(log, "draft", { performerId: "fixer-A", actingFixerId: "fixer-A", targetIds: aliceCards }, () =>
    performAction({ performerId: "fixer-A", actingFixerId: "fixer-A", targetIds: aliceCards }, rig.content.actions.get("draft")!, rig.deps),
  );
  const bobCards = ["Runner", "Sentinel", "Cipher"].map((n) => findByName(rig.entities, n).id);
  performActionAndLog(log, "draft", { performerId: "fixer-B", actingFixerId: "fixer-B", targetIds: bobCards }, () =>
    performAction({ performerId: "fixer-B", actingFixerId: "fixer-B", targetIds: bobCards }, rig.content.actions.get("draft")!, rig.deps),
  );

  readyAndMaybeAdvance(rig, log, "fixer-A");
  readyAndMaybeAdvance(rig, log, "fixer-B"); // this is the one that opens the lobby gate and starts "playing" — fixer-A's first automatic draw happens here

  const ace = findByName(rig.entities, "Ace");
  const runner = findByName(rig.entities, "Runner");
  const shakedownIntent: ActionContext = { performerId: ace.id, actingFixerId: "fixer-A", targetIds: [runner.id], params: { abilityId: "shakedown" } };
  performActionAndLog(log, "activate", shakedownIntent, () => performAction(shakedownIntent, rig.content.actions.get("activate")!, rig.deps));

  advancePhaseAndLog(log, () => rig.match.tryAdvance()); // fixer-A: main -> end
  advancePhaseAndLog(log, () => rig.match.tryAdvance()); // fixer-A: end -> fixer-B's upkeep (fixer-B's first automatic draw happens here)
  advancePhaseAndLog(log, () => rig.match.tryAdvance()); // fixer-B: upkeep -> main — agency is only legal here

  // Cipher specifically, not Sentinel — Sentinel carries weak:coercion,
  // which raises shakedown's cost from 4 to 6 (ceil(4*1.5)), and this was
  // a genuine, previously-uncaught bug: fixer-B only has 5 outflow at
  // this point, so that shakedown was silently failing on cost — this
  // test simply never asserted the action actually succeeded until the
  // hardened assertions below were added. Cipher has neither pref nor
  // weak tag, so its cost stays at the base 4, which fixer-B can afford.
  const cipher = findByName(rig.entities, "Cipher");
  const nomad = findByName(rig.entities, "Nomad");
  const shakedownIntent2: ActionContext = { performerId: cipher.id, actingFixerId: "fixer-B", targetIds: [nomad.id], params: { abilityId: "shakedown" } };
  performActionAndLog(log, "activate", shakedownIntent2, () => performAction(shakedownIntent2, rig.content.actions.get("activate")!, rig.deps));

  // Deliberately stops here, without a second phaseAdvance back to
  // fixer-A: fixer-A's pool started at 2 (5 - 3 drafted) and has had
  // exactly ONE draw so far. A second draw would fully exhaust it,
  // making the final hand contents the same regardless of draw order
  // or seed (whatever's left once a 2-card pool is fully drained is
  // always both cards) — which would make this test pass even if
  // replay were silently broken. Stopping at one draw keeps WHICH of
  // the two remaining cards ended up drawn a genuinely seed-dependent
  // fact, which is the actual thing worth proving reproduces exactly.

  return captureFacts(rig);
}

/** Every fact a correct replay must reproduce exactly — WHICH cards ended up where (the randomness-dependent part), not just that some number of cards moved. */
function captureFacts(rig: ReturnType<typeof makeFullRig>) {
  const handCardNames = (fixerId: string) =>
    [...rig.entities.getAllEntities()]
      .filter((e) => e.kind === "card" && e.zoneId === `${fixerId}-hand-zone`)
      .map((e) => (e as { name?: string }).name)
      .sort();

  const poolRemaining = (fixerId: string) => rig.content.deck.remainingCount(fixerId);

  return {
    aliceHand: handCardNames("fixer-A"),
    bobHand: handCardNames("fixer-B"),
    alicePoolRemaining: poolRemaining("fixer-A"),
    bobPoolRemaining: poolRemaining("fixer-B"),
    aliceInflow: rig.resolver.getProperty("fixer-A", "inflow"),
    bobInflow: rig.resolver.getProperty("fixer-B", "inflow"),
    nomadShaken: findByName(rig.entities, "Nomad").tags.has("shaken"),
    runnerShaken: findByName(rig.entities, "Runner").tags.has("shaken"),
    turnCounter: rig.resolver.getProperty("table-1", "turnCounter"),
  };
}

describe("end-to-end determinism: a real cyberfixer match replays bit-for-bit", () => {
  it("replaying the logged command sequence against a FRESH, identically-seeded rig reproduces every fact — including which specific cards were drawn", () => {
    const MASTER_SEED = 20260909;
    const log = new EventLog(MASTER_SEED);

    const live = makeFullRig(MASTER_SEED);
    const liveFacts = playFullSequence(live, log);

    // Sanity check the scenario is actually exercising real randomness,
    // not vacuously "empty pool draws nothing" — if these are ever 0,
    // the test below would pass without proving anything.
    expect(liveFacts.aliceHand.length).toBeGreaterThan(0);
    expect(liveFacts.bobHand.length).toBeGreaterThan(0);
    // And a second sanity check, added after a real bug: toEqual(liveFacts)
    // below only catches DIVERGENCE between live and replay — it can't
    // catch "both runs consistently failed the same way" (e.g. every
    // shakedown silently rejected in both, still "equal"). That's exactly
    // what happened here once: a rig using a real Match/TurnCycle without
    // going through CyberFixerRoom's own tagging never set "active-turn"
    // at all, so every shakedown attempt was silently rejected, and this
    // test still passed. Asserting the actual outcome, not just
    // consistency between two runs, is what would have caught it.
    expect(liveFacts.nomadShaken).toBe(true);
    expect(liveFacts.runnerShaken).toBe(true);

    const replayed = makeFullRig(MASTER_SEED); // SAME seed — this is the whole point
    replayCommands(log.getAll(), {
      performAction: (actionId, intent) => performAction(intent, replayed.content.actions.get(actionId)!, replayed.deps),
      advancePhase: () => replayed.match.tryAdvance(),
      pass: () => {
        throw new Error("no pass commands exist in this sequence yet — this determinism suite doesn't exercise the pass-priority mechanism");
      },
    });
    const replayedFacts = captureFacts(replayed);

    expect(replayedFacts).toEqual(liveFacts);
  });

  it("a DIFFERENT master seed produces a DIFFERENT outcome — proving the match above wasn't coincidental (e.g. an unseeded fallback that always draws the same thing regardless of seed)", () => {
    const log1 = new EventLog(111);
    const rig1 = makeFullRig(111);
    const facts1 = playFullSequence(rig1, log1);

    const log2 = new EventLog(222);
    const rig2 = makeFullRig(222);
    const facts2 = playFullSequence(rig2, log2);

    // at least one seed-dependent fact differs — if every seed produced
    // identical hands, that would mean the draw isn't actually seeded
    expect(facts1.aliceHand).not.toEqual(facts2.aliceHand);
  });
});
