import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client, defineRoom } from "@colyseus/core";
import { boot, ColyseusTestServer } from "@colyseus/testing";
import { createCard, createHand } from "../core/entity.ts";
import { EventBus } from "../events/bus.ts";
import { EntityStore } from "../events/entity-store.ts";
import { ModifierStore } from "../properties/modifier-store.ts";
import { PropertyResolver } from "../properties/property-resolver.ts";
import { ActionRegistry, type ActionDefinition } from "../actions/action-definition.ts";
import { EffectHandlerRegistry } from "../actions/effect-handler.ts";
import { performAction, type PerformActionDeps } from "../actions/pipeline.ts";
import { ALWAYS_TRUE_QUERY, PhaseHandlerRegistry, type PhaseDefinition } from "../phases/phase-definition.ts";
import { TurnCycle } from "../phases/turn-cycle.ts";
import { SubscriptionRegistry } from "../query/subscriptions.ts";
import { TableRoom, type TableRoomCreateOptions } from "../network/table-room.ts";
import { validateActionIntent, validateActiveTurn, validatePhaseAdvanceIntent, type RawActionIntent } from "../network/intent.ts";
import { SeededRandom } from "../persistence/seeded-random.ts";

describe("validateActionIntent", () => {
  function makeEntities() {
    const entities = new EntityStore(new EventBus());
    const ownContractor = createCard("Ace", { id: "performer-own", ownership: ["fixer-A"] });
    const othersContractor = createCard("Runner", { id: "performer-other", ownership: ["fixer-B"] });
    entities.add(ownContractor);
    entities.add(othersContractor);
    return entities;
  }

  it("accepts an intent through a performer the sender actually controls, and always sets actingFixerId to the sender's seat", () => {
    const entities = makeEntities();
    const raw: RawActionIntent = { actionId: "shakedown", performerId: "performer-own", targetIds: ["target-1"] };
    const result = validateActionIntent(raw, "fixer-A", (id) => entities.get(id));
    expect(result).toEqual({
      ok: true,
      actionId: "shakedown",
      intent: { performerId: "performer-own", actingFixerId: "fixer-A", targetIds: ["target-1"], params: undefined },
    });
  });

  it("rejects an intent through a performer the sender does NOT control — the core forgery case", () => {
    const entities = makeEntities();
    const raw: RawActionIntent = { actionId: "shakedown", performerId: "performer-other", targetIds: [] };
    const result = validateActionIntent(raw, "fixer-A", (id) => entities.get(id));
    expect(result).toEqual({
      ok: false,
      reason: `seat "fixer-A" does not control performer "performer-other"`,
    });
  });

  it("rejects an intent naming a performer that doesn't exist", () => {
    const entities = makeEntities();
    const raw: RawActionIntent = { actionId: "shakedown", performerId: "no-such-entity", targetIds: [] };
    const result = validateActionIntent(raw, "fixer-A", (id) => entities.get(id));
    expect(result).toEqual({ ok: false, reason: "unknown performer: no-such-entity" });
  });
});

describe("validatePhaseAdvanceIntent", () => {
  it("accepts a request from the currently active fixer", () => {
    expect(validatePhaseAdvanceIntent("fixer-A", "fixer-A")).toEqual({ ok: true });
  });

  it("rejects a request from anyone else — no forcing along someone else's turn", () => {
    expect(validatePhaseAdvanceIntent("fixer-B", "fixer-A")).toEqual({
      ok: false,
      reason: `it is not seat "fixer-B"'s turn (active fixer is "fixer-A")`,
    });
  });
});

describe("validateActiveTurn (the general check, also used to gate action submission)", () => {
  it("is the exact same check validatePhaseAdvanceIntent wraps", () => {
    expect(validateActiveTurn("fixer-A", "fixer-A")).toEqual(validatePhaseAdvanceIntent("fixer-A", "fixer-A"));
    expect(validateActiveTurn("fixer-B", "fixer-A")).toEqual(validatePhaseAdvanceIntent("fixer-B", "fixer-A"));
  });
});

// --- end-to-end: a real room proving intent forgery is actually rejected, not just in theory ---

class GameRoom extends TableRoom {
  private entities!: EntityStore;
  private actions!: ActionRegistry;
  private deps!: PerformActionDeps;
  private turnCycle!: TurnCycle;

  onCreate(options: TableRoomCreateOptions): void {
    super.onCreate(options);

    const bus = new EventBus();
    this.entities = new EntityStore(bus);
    const modifiers = new ModifierStore(bus);
    const resolver = new PropertyResolver(this.entities, modifiers);
    const handlers = new EffectHandlerRegistry();
    this.actions = new ActionRegistry();

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
    this.actions.register(shakedown);
    handlers.register("shakedownEffect", (ctx, api) => {
      for (const targetId of ctx.targetIds) api.entities.addTag(targetId, "shaken");
    });

    const random = new SeededRandom(1);
    this.deps = { entities: this.entities, resolver, modifiers, handlers, bus, random };

    this.entities.add(createHand([], { id: "fixer-A", properties: { resources: 10 } }));
    this.entities.add(createHand([], { id: "fixer-B", properties: { resources: 10 } }));

    const performerA = createCard("Ace", { id: "performer-A", ownership: ["fixer-A"] });
    performerA.tags.add("contractor");
    const performerB = createCard("Runner", { id: "performer-B", ownership: ["fixer-B"] });
    performerB.tags.add("contractor");
    this.entities.add(performerA);
    this.entities.add(performerB);

    const phases: PhaseDefinition[] = [{ id: "main", gateSubject: "activeFixer", completionGate: ALWAYS_TRUE_QUERY }];
    this.turnCycle = new TurnCycle(phases, ["fixer-A", "fixer-B"], "table-1", {
      entities: this.entities,
      modifiers,
      random,
      resolver,
      registry: new SubscriptionRegistry(),
      handlers: new PhaseHandlerRegistry(),
      bus,
    });
    this.turnCycle.start();

    this.onMessage("action", (client: Client, message: RawActionIntent) => {
      const seatId = this.seatOf(client.sessionId);
      if (!seatId) return;
      const validated = validateActionIntent(message, seatId, (id) => this.entities.get(id));
      if (!validated.ok) {
        client.send("action-result", { ok: false, reason: validated.reason });
        return;
      }
      const definition = this.actions.get(validated.actionId);
      if (!definition) {
        client.send("action-result", { ok: false, reason: `unknown action: ${validated.actionId}` });
        return;
      }
      const result = performAction(validated.intent, definition, this.deps);
      client.send("action-result", result);
    });

    this.onMessage("phaseAdvance", (client: Client) => {
      const seatId = this.seatOf(client.sessionId);
      if (!seatId) return;
      const validated = validatePhaseAdvanceIntent(seatId, this.turnCycle.activeFixerId);
      if (!validated.ok) {
        client.send("phase-result", { ok: false, reason: validated.reason });
        return;
      }
      client.send("phase-result", this.turnCycle.tryAdvance());
    });
  }
}

async function waitForMessage<T>(room: { onMessage(type: string, cb: (msg: T) => void): void }, type: string): Promise<T> {
  return new Promise((resolve) => room.onMessage(type, resolve));
}

describe("end-to-end: intent ingestion rejects forged senders on a real room", () => {
  let server: ColyseusTestServer;
  let port = 23400;

  beforeEach(async () => {
    port += 1;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    server = await boot({ rooms: { game: defineRoom(GameRoom) } } as any, port);
  });

  afterEach(async () => {
    await server.shutdown();
  });

  it("rejects fixer-A submitting an action through fixer-B's performer", async () => {
    const room = await server.createRoom("game", { seatOrder: ["fixer-A", "fixer-B"] });
    const clientA = await server.connectTo(room, { identity: "user-A" });
    await server.connectTo(room, { identity: "user-B" });

    const resultPromise = waitForMessage<{ ok: boolean; reason?: string }>(clientA, "action-result");
    clientA.send("action", { actionId: "shakedown", performerId: "performer-B", targetIds: [] });
    const result = await resultPromise;

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/does not control performer/);
  });

  it("accepts fixer-A submitting a legitimate action through their own performer", async () => {
    const room = await server.createRoom("game", { seatOrder: ["fixer-A", "fixer-B"] });
    const clientA = await server.connectTo(room, { identity: "user-A" });
    await server.connectTo(room, { identity: "user-B" });

    const resultPromise = waitForMessage<{ ok: boolean }>(clientA, "action-result");
    clientA.send("action", { actionId: "shakedown", performerId: "performer-A", targetIds: ["performer-B"] });
    const result = await resultPromise;

    expect(result.ok).toBe(true);
  });

  it("rejects fixer-B trying to advance the phase when it's fixer-A's turn", async () => {
    const room = await server.createRoom("game", { seatOrder: ["fixer-A", "fixer-B"] });
    await server.connectTo(room, { identity: "user-A" });
    const clientB = await server.connectTo(room, { identity: "user-B" });

    const resultPromise = waitForMessage<{ ok: boolean; reason?: string }>(clientB, "phase-result");
    clientB.send("phaseAdvance", {});
    const result = await resultPromise;

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/not seat "fixer-B"'s turn/);
  });

  it("accepts fixer-A advancing the phase on their own turn", async () => {
    const room = await server.createRoom("game", { seatOrder: ["fixer-A", "fixer-B"] });
    const clientA = await server.connectTo(room, { identity: "user-A" });
    await server.connectTo(room, { identity: "user-B" });

    const resultPromise = waitForMessage<{ ok: boolean }>(clientA, "phase-result");
    clientA.send("phaseAdvance", {});
    const result = await resultPromise;

    expect(result.ok).toBe(true);
  });
});
