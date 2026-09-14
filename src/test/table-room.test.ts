import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defineRoom } from "@colyseus/core";
import { boot, ColyseusTestServer } from "@colyseus/testing";
import { TableRoom } from "../network/table-room.ts";

describe("TableRoom: lifecycle via an in-process harness (no real sockets)", () => {
  let server: ColyseusTestServer;
  let port = 22670;

  beforeEach(async () => {
    port += 1;
    server = await boot(
      {
        rooms: { table: defineRoom(TableRoom) },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      port,
    );
  });

  afterEach(async () => {
    await server.shutdown();
  });

  it("assigns seats to distinct identities in seatOrder", async () => {
    const room = await server.createRoom("table", { seatOrder: ["fixer-A", "fixer-B"] });
    const roomInstance = room as unknown as TableRoom;

    const clientA = await server.connectTo(room, { identity: "user-1" });
    const clientB = await server.connectTo(room, { identity: "user-2" });

    expect(roomInstance.seatOf(clientA.sessionId)).toBe("fixer-A");
    expect(roomInstance.seatOf(clientB.sessionId)).toBe("fixer-B");
    expect(roomInstance.state.seatIdentities.get("fixer-A")).toBe("user-1");
    expect(roomInstance.state.seatIdentities.get("fixer-B")).toBe("user-2");
    expect(roomInstance.state.seatConnected.get("fixer-A")).toBe(true);
  });

  it("a fresh connection with an already-seated identity gets the same seat back (identity-keyed persistence)", async () => {
    const room = await server.createRoom("table", { seatOrder: ["fixer-A", "fixer-B"] });
    const roomInstance = room as unknown as TableRoom;

    const first = await server.connectTo(room, { identity: "user-1" });
    expect(roomInstance.seatOf(first.sessionId)).toBe("fixer-A");

    await first.leave(true); // deliberate leave — consented, no reconnection window

    const rejoined = await server.connectTo(room, { identity: "user-1" });
    expect(roomInstance.seatOf(rejoined.sessionId)).toBe("fixer-A"); // same seat, even though it's a brand new session
    expect(roomInstance.state.seatIdentities.get("fixer-A")).toBe("user-1");
  });

  it("rejects a join once every seat is taken by distinct identities", async () => {
    const room = await server.createRoom("table", { seatOrder: ["fixer-A", "fixer-B"] });
    await server.connectTo(room, { identity: "user-1" });
    await server.connectTo(room, { identity: "user-2" });

    await expect(server.connectTo(room, { identity: "user-3" })).rejects.toThrow();
  });

  it("marks a seat disconnected (without releasing it) on a consented leave", async () => {
    const room = await server.createRoom("table", { seatOrder: ["fixer-A"] });
    const roomInstance = room as unknown as TableRoom;
    const client = await server.connectTo(room, { identity: "user-1" });

    await client.leave(true);
    // give the server a tick to process the leave
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(roomInstance.state.seatConnected.get("fixer-A")).toBe(false);
    expect(roomInstance.state.seatIdentities.get("fixer-A")).toBe("user-1"); // ownership untouched
  });

  it("broadcasts a chat message, with seatId/identity/text/timestamp, to every connected client including the sender", async () => {
    const room = await server.createRoom("table", { seatOrder: ["fixer-A", "fixer-B"] });
    const alice = await server.connectTo(room, { identity: "alice" });
    const bob = await server.connectTo(room, { identity: "bob" });

    const aliceReceived = new Promise((resolve) => alice.onMessage("chat", resolve));
    const bobReceived = new Promise((resolve) => bob.onMessage("chat", resolve));
    bob.send("chat", { text: "hey there" });

    const results = (await Promise.all([aliceReceived, bobReceived])) as Array<{
      seatId: string;
      identity: string;
      text: string;
      at: number;
    }>;

    for (const msg of results) {
      expect(msg.seatId).toBe("fixer-B");
      expect(msg.identity).toBe("bob");
      expect(msg.text).toBe("hey there");
      expect(typeof msg.at).toBe("number");
    }
  });

  it("ignores an empty or whitespace-only chat message — no broadcast at all", async () => {
    const room = await server.createRoom("table", { seatOrder: ["fixer-A", "fixer-B"] });
    const alice = await server.connectTo(room, { identity: "alice" });
    const bob = await server.connectTo(room, { identity: "bob" });

    let received = false;
    alice.onMessage("chat", () => {
      received = true;
    });
    bob.send("chat", { text: "   " });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(received).toBe(false);
  });

  it("truncates an overlong chat message rather than rejecting it", async () => {
    const room = await server.createRoom("table", { seatOrder: ["fixer-A", "fixer-B"] });
    const alice = await server.connectTo(room, { identity: "alice" });
    const bob = await server.connectTo(room, { identity: "bob" });

    const received = new Promise((resolve) => alice.onMessage("chat", resolve));
    bob.send("chat", { text: "x".repeat(1000) });
    const msg = (await received) as { text: string };

    expect(msg.text.length).toBe(500);
  });
});
