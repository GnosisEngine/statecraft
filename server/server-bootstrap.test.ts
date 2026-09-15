import { afterEach, beforeEach, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { defineRoom, type RegisteredHandler } from "@colyseus/core";
import { boot, ColyseusTestServer } from "@colyseus/testing";
import type { EventLog } from "../src/persistence/event-log.ts";
import type { Snapshot } from "../src/persistence/snapshot.ts";
import { discoverGames } from "./discover-games.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GAMES_ROOT = path.join(__dirname, "..", "games");
const COLYSEUS_SDK_BROWSER_BUNDLE = path.join(__dirname, "..", "node_modules", "@colyseus", "sdk", "dist", "colyseus.js");

/**
 * Builds the exact same Colyseus config server/index.ts does — same
 * discoverGames() call, same room registration, same initializeExpress
 * wiring — so this test proves the REAL bootstrap path, not a
 * hand-simplified stand-in of it.
 */
async function bootRealServer(port: number): Promise<{ server: ColyseusTestServer; games: Awaited<ReturnType<typeof discoverGames>> }> {
  const games = await discoverGames(GAMES_ROOT);
  const rooms: Record<string, RegisteredHandler> = {};
  for (const game of games) {
    rooms[game.name] = defineRoom(game.RoomClass, { seatOrder: game.seatOrder });
  }

  const server = await boot(
    {
      rooms,
      initializeExpress: (app: express.Express) => {
        app.get("/vendor/colyseus.js", (_req, res) => res.sendFile(COLYSEUS_SDK_BROWSER_BUNDLE));
        app.get("/games", (_req, res) => {
          res.json(games.map((g) => ({ name: g.name, displayName: g.displayName, url: `/games/${g.name}/` })));
        });
        for (const game of games) {
          app.use(`/games/${game.name}`, express.static(game.clientDir));
        }
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    port,
  );

  return { server, games };
}

/** Drafts each fixer's starting 3 (by name) and readies both up — the match only leaves the lobby once every fixer has done both. Returns the drafted card entities so tests can act through them. */
async function draftAndReadyBoth(alice: { state: { entities: Map<string, unknown> }; send: Function; onMessage: Function }, bob: { state: { entities: Map<string, unknown> }; send: Function; onMessage: Function }) {
  const aliceCards = [...alice.state.entities.values()] as Array<{ id: string; kind: string; name?: string }>;
  const ace = aliceCards.find((e) => e.name === "Ace")!;
  const nomad = aliceCards.find((e) => e.name === "Nomad")!;
  const vex = aliceCards.find((e) => e.name === "Vex")!;
  const aliceDraft = new Promise((resolve) => alice.onMessage("action-result", resolve));
  alice.send("action", { actionId: "draft", performerId: "fixer-A", targetIds: [ace.id, nomad.id, vex.id] });
  await aliceDraft;

  const bobCards = [...bob.state.entities.values()] as Array<{ id: string; kind: string; name?: string }>;
  const runner = bobCards.find((e) => e.name === "Runner")!;
  const sentinel = bobCards.find((e) => e.name === "Sentinel")!;
  const cipher = bobCards.find((e) => e.name === "Cipher")!;
  const bobDraft = new Promise((resolve) => bob.onMessage("action-result", resolve));
  bob.send("action", { actionId: "draft", performerId: "fixer-B", targetIds: [runner.id, sentinel.id, cipher.id] });
  await bobDraft;

  const aliceReady = new Promise((resolve) => alice.onMessage("action-result", resolve));
  alice.send("action", { actionId: "ready", performerId: "fixer-A", targetIds: [] });
  await aliceReady;

  const bobReady = new Promise((resolve) => bob.onMessage("action-result", resolve));
  bob.send("action", { actionId: "ready", performerId: "fixer-B", targetIds: [] });
  await bobReady;
  await new Promise((resolve) => setTimeout(resolve, 100));

  return { ace, nomad, vex, runner, sentinel, cipher };
}

describe("full server bootstrap: discovery + static serving + a live game, in one process", () => {
  let server: ColyseusTestServer;
  let port = 23800;

  beforeEach(async () => {
    port += 1;
    ({ server } = await bootRealServer(port));
  });

  afterEach(async () => {
    await server.shutdown();
  });

  it("serves the /games listing", async () => {
    const res = await server.http.get("/games");
    expect(res.statusCode).toBe(200);
    expect(res.data).toEqual(expect.arrayContaining([expect.objectContaining({ name: "cyberfixer", url: "/games/cyberfixer/" })]));
  });

  it("serves the shared colyseus.js browser bundle", async () => {
    const res = await server.http.get("/vendor/colyseus.js");
    expect(res.statusCode).toBe(200);
    expect(String(res.data)).toContain("Colyseus");
  });

  it("serves cyberfixer's own client assets at /games/cyberfixer", async () => {
    const html = await server.http.get("/games/cyberfixer/index.html");
    expect(html.statusCode).toBe(200);
    expect(String(html.data)).toContain("Cyber Fixer");

    const js = await server.http.get("/games/cyberfixer/main.js");
    expect(js.statusCode).toBe(200);
    expect(String(js.data)).toContain("joinOrCreate");
  });

  it("logs every confirmed command (including the auto-triggered lobby->playing transition) and takes a snapshot on cadence — the WIRING itself, not the underlying replay mechanism (already proven by determinism.test.ts)", async () => {
    const room = await server.createRoom("cyberfixer", {});
    const alice = await server.connectTo(room, { identity: "alice" });
    const bob = await server.connectTo(room, { identity: "bob" });
    await new Promise((resolve) => setTimeout(resolve, 100));

    const internals = room as unknown as { log: EventLog; lastSnapshot: Snapshot | null };
    expect(internals.log.length).toBe(0);
    expect(internals.lastSnapshot).toBeNull();

    await draftAndReadyBoth(alice, bob);

    // 2 drafts + 2 readies + 2 auto-triggered phaseAdvances (pregame ->
    // upkeep, then upkeep -> main — upkeep auto-advances the instant its
    // own gate is satisfied, since it's fully automatic and needs no
    // player input; see room.ts's autoAdvanceThroughAutomaticPhases) =
    // 6 confirmed commands.
    expect(internals.log.length).toBe(6);
    expect(internals.log.getAll().map((c) => c.entry.kind)).toEqual(["action", "action", "action", "action", "phaseAdvance", "phaseAdvance"]);

    // SNAPSHOT_INTERVAL is 5 — exactly one snapshot should have been taken by now
    expect(internals.lastSnapshot).not.toBeNull();
    expect(internals.lastSnapshot!.atSequence).toBe(4); // log.length - 1 at the moment it was taken
    expect(internals.lastSnapshot!.hierarchies.some((h) => h.name === "deck")).toBe(true);
  });

  it("a rejected action is never logged", async () => {
    const room = await server.createRoom("cyberfixer", {});
    const alice = await server.connectTo(room, { identity: "alice" });
    await server.connectTo(room, { identity: "bob" });
    await new Promise((resolve) => setTimeout(resolve, 100));

    const internals = room as unknown as { log: EventLog };

    const resultPromise = new Promise((resolve) => alice.onMessage("action-result", resolve));
    // illegal before drafting/the lobby has even opened
    alice.send("action", { actionId: "activate", performerId: "fixer-A", targetIds: [], params: { abilityId: "shakedown" } });
    const result = (await resultPromise) as { ok: boolean };

    expect(result.ok).toBe(false);
    expect(internals.log.length).toBe(0); // rejected — never logged, never counted toward snapshot cadence
  });

  it("the lobby: turn-gated actions are rejected until BOTH fixers have drafted and readied up", async () => {
    const room = await server.createRoom("cyberfixer", {});
    const alice = await server.connectTo(room, { identity: "alice" });
    const bob = await server.connectTo(room, { identity: "bob" });
    await new Promise((resolve) => setTimeout(resolve, 100));

    // no active-turn tag exists yet — the match hasn't left pregame
    const activeTagged = (state: { entities: Map<string, { kind: string; id: string; tags: Set<string> }> }) =>
      [...state.entities.values()].filter((e) => e.kind === "hand" && e.tags.has("active-turn")).map((e) => e.id);
    expect(activeTagged(alice.state)).toEqual([]);

    // a turn-gated action submitted before the lobby closes is rejected, not silently queued
    // (the message is now generic — "timing condition not met" — since this rejection now
    // comes from ActionDefinition.timingCondition inside the action pipeline itself, not a
    // room-level special case with its own specific wording; see content.ts's shakedown)
    const aliceCards = [...alice.state.entities.values()] as Array<{ id: string; name?: string }>;
    const ace = aliceCards.find((e) => e.name === "Ace")!;
    const earlyResult = new Promise((resolve) => alice.onMessage("action-result", resolve));
    alice.send("action", { actionId: "activate", performerId: ace.id, targetIds: [], params: { abilityId: "shakedown" } });
    expect(await earlyResult).toMatchObject({ ok: false, reason: "timing condition not met" });

    await draftAndReadyBoth(alice, bob);

    // now the match has left pregame — fixer-A (first in seatOrder) is the active fixer
    expect(activeTagged(alice.state)).toEqual(["fixer-A"]);
    expect(activeTagged(bob.state)).toEqual(["fixer-A"]);
  });

  it("plays a real game: two clients join, draft, ready up, deploy, submit a shakedown, and see synced state update", async () => {
    const room = await server.createRoom("cyberfixer", {});
    const alice = await server.connectTo(room, { identity: "alice" });
    const bob = await server.connectTo(room, { identity: "bob" });
    await new Promise((resolve) => setTimeout(resolve, 100));

    // each fixer sees their OWN deck (owner-only visibility) — not the opponent's
    const aliceCards = [...alice.state.entities.values()].filter((e: { kind: string }) => e.kind === "card");
    expect(aliceCards.length).toBeGreaterThan(0);
    const aceBeforeDraft = aliceCards.find((e: { name?: string }) => e.name === "Ace")!;
    expect(bob.state.entities.get(aceBeforeDraft.id)).toBeUndefined(); // bob can't see alice's deck contents

    const { ace, runner } = await draftAndReadyBoth(alice, bob);

    // now both drafted contractors are on the public board — visible to both clients
    const bobsViewOfAce = [...bob.state.entities.values()].find((e: { id: string }) => e.id === ace.id);
    expect(bobsViewOfAce).toBeDefined();

    const resultPromise = new Promise((resolve) => alice.onMessage("action-result", resolve));
    alice.send("action", { actionId: "activate", performerId: ace.id, targetIds: [runner.id], params: { abilityId: "shakedown" } });
    const result = await resultPromise;

    // Proposed and pushed onto the shared stack — main phase is
    // interactive now, so this is legal/cost-paid but NOT yet resolved.
    expect(result).toMatchObject({ ok: true });
    await new Promise((resolve) => setTimeout(resolve, 100));

    const bobsViewBeforePass = [...bob.state.entities.values()].find((e: { id: string }) => e.id === runner.id) as { tags: Set<string> };
    expect([...bobsViewBeforePass.tags]).not.toContain("shaken"); // NOT yet — nobody has passed

    // Both fixers pass — nothing new to react to, so the pending
    // shakedown actually resolves now.
    const resolutionPromise = new Promise((resolve) => bob.onMessage("resolution-result", resolve));
    alice.send("pass", {});
    bob.send("pass", {});
    await resolutionPromise;
    await new Promise((resolve) => setTimeout(resolve, 100));

    // the target's resolved inflow dropped, and both clients' synced state reflects it
    const bobsView = [...bob.state.entities.values()].find((e: { id: string }) => e.id === runner.id) as { tags: Set<string> };
    expect([...bobsView.tags]).toContain("shaken");
  });

  it("respondingTo: a second proposal can respond to an already-pending one (the 'Hedge Fund' pattern — a fixer responding to their own play), and a stale/invalid respondingTo is rejected with a clear reason", async () => {
    const room = await server.createRoom("cyberfixer", {});
    const alice = await server.connectTo(room, { identity: "alice" });
    const bob = await server.connectTo(room, { identity: "bob" });
    await new Promise((resolve) => setTimeout(resolve, 100));

    const { ace, runner } = await draftAndReadyBoth(alice, bob);
    const sentinel = [...alice.state.entities.values()].find((e: { name?: string }) => e.name === "Sentinel")! as { id: string };

    const firstResultPromise = new Promise((resolve) => alice.onMessage("action-result", resolve));
    alice.send("action", { actionId: "activate", performerId: ace.id, targetIds: [runner.id], params: { abilityId: "shakedown" } });
    await firstResultPromise;
    await new Promise((resolve) => setTimeout(resolve, 100));

    const firstPending = [...alice.state.entities.values()].find((e: { tags: Set<string> }) => e.tags.has("pending-action")) as { id: string };
    expect(firstPending).toBeDefined();

    // Alice responds to her OWN pending proposal — legal by design (see
    // room.ts's own proposeAndPush: no ownership check on respondingTo,
    // content's targetQuery is what would restrict this in real cards).
    const secondResultPromise = new Promise((resolve) => alice.onMessage("action-result", resolve));
    alice.send("action", {
      actionId: "activate",
      performerId: ace.id,
      targetIds: [sentinel.id],
      params: { abilityId: "shakedown" },
      respondingTo: firstPending.id,
    });
    const secondResult = (await secondResultPromise) as { ok: boolean };
    expect(secondResult.ok).toBe(true);

    // A stale/invalid respondingTo — something that was never pending at all
    const badResultPromise = new Promise((resolve) => alice.onMessage("action-result", resolve));
    alice.send("action", {
      actionId: "activate",
      performerId: ace.id,
      targetIds: [runner.id],
      params: { abilityId: "shakedown" },
      respondingTo: "not-actually-pending",
    });
    const badResult = (await badResultPromise) as { ok: boolean; reason?: string };
    expect(badResult.ok).toBe(false);
    expect(badResult.reason).toContain("is not currently pending");
  });

  it("rejects an action submitted by the fixer whose turn it ISN'T — actions are turn-gated, not just phase advancement", async () => {
    const room = await server.createRoom("cyberfixer", {});
    const alice = await server.connectTo(room, { identity: "alice" }); // joins first -> seated as fixer-A, the active fixer once playing begins
    const bob = await server.connectTo(room, { identity: "bob" }); // seated as fixer-B, NOT active
    await new Promise((resolve) => setTimeout(resolve, 100));

    const { ace, runner } = await draftAndReadyBoth(alice, bob);

    const resultPromise = new Promise((resolve) => bob.onMessage("action-result", resolve));
    bob.send("action", { actionId: "activate", performerId: runner.id, targetIds: [ace.id], params: { abilityId: "shakedown" } });
    const result = (await resultPromise) as { ok: boolean; reason?: string };

    expect(result.ok).toBe(false);
    // "timing condition not met" now, not the old room-level "not seat X's turn"
    // wording — same rejection, now enforced by ActionDefinition.timingCondition
    // inside the pipeline itself, so it applies uniformly wherever performAction
    // is called, not just through this room's own message handler.
    expect(result.reason).toBe("timing condition not met");
  });

  it("tags exactly the active fixer with 'active-turn', and the tag moves when the turn advances", async () => {
    const room = await server.createRoom("cyberfixer", {});
    const alice = await server.connectTo(room, { identity: "alice" }); // fixer-A, active once playing begins
    const bob = await server.connectTo(room, { identity: "bob" }); // fixer-B
    await new Promise((resolve) => setTimeout(resolve, 100));

    const activeTagged = (state: { entities: Map<string, { kind: string; id: string; tags: Set<string> }> }) =>
      [...state.entities.values()].filter((e) => e.kind === "hand" && e.tags.has("active-turn")).map((e) => e.id);

    await draftAndReadyBoth(alice, bob);
    expect(activeTagged(alice.state)).toEqual(["fixer-A"]);
    expect(activeTagged(bob.state)).toEqual(["fixer-A"]);

    const phaseResultPromise = new Promise((resolve) => alice.onMessage("phase-result", resolve));
    alice.send("phaseAdvance", {});
    const phaseResult = await phaseResultPromise;
    expect(phaseResult).toMatchObject({ ok: true });
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(activeTagged(alice.state)).toEqual(["fixer-B"]);
    expect(activeTagged(bob.state)).toEqual(["fixer-B"]);
  });

  it("a real bid war, over the actual network: two competing claims on the SAME target, at different bid amounts — the higher one wins ownership, and the loser fizzles on its own re-validation once the target's already been won", async () => {
    const room = await server.createRoom("cyberfixer", {});
    const alice = await server.connectTo(room, { identity: "alice" });
    const bob = await server.connectTo(room, { identity: "bob" });
    await new Promise((resolve) => setTimeout(resolve, 100));

    const { ace, runner } = await draftAndReadyBoth(alice, bob);

    // Alice proposes a LOW claim on Bob's Runner first...
    const lowBidPromise = new Promise((resolve) => alice.onMessage("action-result", resolve));
    alice.send("action", { actionId: "activate", performerId: ace.id, targetIds: [runner.id], params: { abilityId: "claim", bidAmount: 1 } });
    const lowBid = await lowBidPromise;
    expect(lowBid).toMatchObject({ ok: true });

    // ...then, before anyone passes, raises with a SECOND, higher claim
    // on the identical target — both are now genuinely pending at once.
    // (1 + 3 = 4, safely within fixer-A's total outflow budget of 5 —
    // Ace/Nomad/Vex's own outflowGrant of 2+2+1 — so this fails on its
    // own legality, not on being unaffordable.)
    const highBidPromise = new Promise((resolve) => alice.onMessage("action-result", resolve));
    alice.send("action", { actionId: "activate", performerId: ace.id, targetIds: [runner.id], params: { abilityId: "claim", bidAmount: 3 } });
    const highBid = await highBidPromise;
    expect(highBid).toMatchObject({ ok: true });
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Runner is still Bob's — NEITHER claim has resolved yet, both are
    // just pending proposals so far
    const runnerBeforeResolution = [...bob.state.entities.values()].find((e: { id: string }) => e.id === runner.id) as { ownership: string[] };
    expect(runnerBeforeResolution.ownership.at(-1)).toBe("fixer-B");

    // Both fixers pass — with nothing new to react to, resolution
    // begins. The bid-aware policy resolves the HIGHER commitment
    // first, regardless of which claim was proposed first.
    const firstResolutionPromise = new Promise((resolve) => bob.onMessage("resolution-result", resolve));
    alice.send("pass", {});
    bob.send("pass", {});
    const firstResolution = await firstResolutionPromise;
    expect(firstResolution).toMatchObject({ fizzled: false, actionId: "activate" });
    await new Promise((resolve) => setTimeout(resolve, 100));

    const runnerAfterFirstResolution = [...bob.state.entities.values()].find((e: { id: string }) => e.id === runner.id) as { ownership: string[] };
    expect(runnerAfterFirstResolution.ownership.at(-1)).toBe("fixer-A"); // the HIGHER bid (5) won, not whichever was proposed first

    // The remaining, lower claim is still pending — but it can no
    // longer legally resolve: Runner is now owned by fixer-A, so
    // "not ownedBy the acting fixer" (Alice) no longer holds.
    // resolveEffect's own re-validation ("Protection") catches this
    // automatically — no special-casing needed for "what if I already
    // won the bid war with a different proposal."
    const secondResolutionPromise = new Promise((resolve) => bob.onMessage("resolution-result", resolve));
    alice.send("pass", {});
    bob.send("pass", {});
    const secondResolution = await secondResolutionPromise;
    expect(secondResolution).toMatchObject({ fizzled: true });
  });

  it("Countermeasure, the first real Reflex-genre card, over the actual network: proposing a shakedown against a countermeasure-bearing Operative automatically proposes a real, paid retaliation — no manual action from the defender at all", async () => {
    const room = await server.createRoom("cyberfixer", {});
    const alice = await server.connectTo(room, { identity: "alice" });
    const bob = await server.connectTo(room, { identity: "bob" });
    await new Promise((resolve) => setTimeout(resolve, 100));

    const { ace, runner } = await draftAndReadyBoth(alice, bob);

    const shakedownPromise = new Promise((resolve) => alice.onMessage("action-result", resolve));
    alice.send("action", { actionId: "activate", performerId: ace.id, targetIds: [runner.id], params: { abilityId: "shakedown" } });
    const shakedownResult = await shakedownPromise;
    expect(shakedownResult).toMatchObject({ ok: true });
    await new Promise((resolve) => setTimeout(resolve, 100));

    // The reflex should have fired automatically — a second pending
    // item now exists, targeting Ace (the shakedown's own performer),
    // that NEITHER client explicitly proposed.
    const pendingOnBob = [...bob.state.entities.values()].filter((e: { tags: Set<string> }) => e.tags.has("pending-action")) as { id: string; ownership: string[] }[];
    expect(pendingOnBob.length).toBe(2); // the shakedown itself, plus the automatic countermeasure response
    const retaliation = pendingOnBob.find((e) => e.ownership.at(-1) === "fixer-B");
    expect(retaliation).toBeDefined(); // proposed on fixer-B's behalf, automatically, by the reflex rule — not by Bob's own client

    // Bob's own outflow actually dropped — the retaliation genuinely
    // paid its normal cost, exactly as CARDS.md's own Reflex text says
    // ("no action required... you still pay its normal cost"), not a
    // free ability.
    const bobFixer = [...bob.state.entities.values()].find((e: { id: string }) => e.id === "fixer-B") as { properties: Map<string, number> };
    expect(bobFixer.properties.get("outflow")).toBeLessThan(5); // Runner/Sentinel/Cipher's own combined outflowGrant, minus the retaliation's own cost

    // Resolve everything — both pending items, whichever order the
    // resolution policy picks — and confirm BOTH effects actually land:
    // Runner is shaken (the original shakedown), AND Ace is flagged
    // (the automatic countermeasure).
    alice.send("pass", {});
    bob.send("pass", {});
    await new Promise((resolve) => setTimeout(resolve, 100));
    alice.send("pass", {});
    bob.send("pass", {});
    await new Promise((resolve) => setTimeout(resolve, 100));

    const runnerAfter = [...bob.state.entities.values()].find((e: { id: string }) => e.id === runner.id) as { tags: Set<string> };
    const aceAfter = [...bob.state.entities.values()].find((e: { id: string }) => e.id === ace.id) as { tags: Set<string> };
    expect(runnerAfter.tags.has("shaken")).toBe(true);
    expect(aceAfter.tags.has("flagged-by-countermeasure")).toBe(true);
  });
});
