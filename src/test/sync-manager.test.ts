import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client, defineRoom } from "@colyseus/core";
import { boot, ColyseusTestServer } from "@colyseus/testing";
import { schema, t, StateView } from "@colyseus/schema";
import { createCard, createZone } from "../core/entity.ts";
import { Hierarchy } from "../events/hierarchy.ts";
import { EventBus } from "../events/bus.ts";
import { EntityStore } from "../events/entity-store.ts";
import { EntitySchema } from "../network/schema.ts";
import type { MapSchema } from "@colyseus/schema";
import { SyncManager } from "../network/sync-manager.ts";
import type { EntitySchemaInstance } from "../network/schema.ts";
import { TableRoom, type TableRoomCreateOptions } from "../network/table-room.ts";

const SyncTestState = schema({ entities: t.map(EntitySchema) }, "SyncTestState");

function makeRig(visibleHierarchies?: ReadonlySet<string>) {
  const bus = new EventBus();
  const entities = new EntityStore(bus);
  const state = new SyncTestState();
  const sync = new SyncManager(entities, state.entities as unknown as MapSchema<EntitySchemaInstance>, visibleHierarchies);
  sync.wire(bus);
  return { bus, entities, state, sync };
}

describe("SyncManager: entity mutations mirror onto the room state map", () => {
  it("mirrors entity:created, including base fields", () => {
    const { entities, state } = makeRig();
    const card = createCard("Fence", { properties: { inflow: 5 } });
    entities.add(card);

    expect(state.entities.has(card.id)).toBe(true);
    expect(state.entities.get(card.id)!.properties.get("inflow")).toBe(5);
  });

  it("re-syncs schema fields on tag, property, and zone changes", () => {
    const { entities, state } = makeRig();
    const card = createCard("Fence", { properties: { inflow: 5 } });
    entities.add(card);

    entities.addTag(card.id, "contractor");
    expect(state.entities.get(card.id)!.tags.has("contractor")).toBe(true);

    entities.setProperty(card.id, "inflow", 9);
    expect(state.entities.get(card.id)!.properties.get("inflow")).toBe(9);

    const zone = createZone();
    entities.add(zone);
    entities.moveToZone(card.id, zone.id);
    expect(state.entities.get(card.id)!.zoneId).toBe(zone.id);
  });

  it("removes from room state on entity:removed", () => {
    const { entities, state } = makeRig();
    const card = createCard("Fence");
    entities.add(card);
    entities.remove(card.id);
    expect(state.entities.has(card.id)).toBe(false);
  });
});

describe("SyncManager: opt-in hierarchy visibility", () => {
  it("a hierarchy NOT listed in visibleHierarchies never touches any entity's schema — the default, safe behavior, unchanged from before this feature existed", () => {
    const { entities, state, bus } = makeRig(); // no visibleHierarchies at all — the default
    const hierarchy = new Hierarchy("secret", bus); // wired to the SAME bus SyncManager is listening on
    const card = createCard("Fence");
    entities.add(card);

    hierarchy.setParent(card.id, "some-parent"); // fires hierarchy:parentChanged on the rig's own bus

    expect(state.entities.get(card.id)!.hierarchyParents.size).toBe(0); // untouched — "secret" was never opted in
  });

  it("a hierarchy explicitly listed in visibleHierarchies syncs its parent link onto the child's own schema instance", () => {
    const { entities, state, bus } = makeRig(new Set(["stack"]));
    const hierarchy = new Hierarchy("stack", bus);
    const parent = createCard("Parent");
    const child = createCard("Child");
    entities.add(parent);
    entities.add(child);

    hierarchy.setParent(child.id, parent.id);

    expect(state.entities.get(child.id)!.hierarchyParents.get("stack")).toBe(parent.id);
  });

  it("a root classification (parentId: null) syncs as the null-zone sentinel, matching zoneId's own encoding", () => {
    const { entities, state, bus } = makeRig(new Set(["stack"]));
    const hierarchy = new Hierarchy("stack", bus);
    const card = createCard("Root item");
    entities.add(card);

    hierarchy.setParent(card.id, null);

    expect(state.entities.get(card.id)!.hierarchyParents.get("stack")).toBe(""); // NULL_ZONE_SENTINEL
  });

  it("removal (hierarchy.remove) deletes the key entirely — not just clears its value — since absent-key and empty-string mean genuinely different things", () => {
    const { entities, state, bus } = makeRig(new Set(["stack"]));
    const hierarchy = new Hierarchy("stack", bus);
    const parent = createCard("Parent");
    const child = createCard("Child");
    entities.add(parent);
    entities.add(child);
    hierarchy.setParent(child.id, parent.id);
    expect(state.entities.get(child.id)!.hierarchyParents.has("stack")).toBe(true);

    hierarchy.remove(child.id);

    expect(state.entities.get(child.id)!.hierarchyParents.has("stack")).toBe(false);
  });

  it("multiple hierarchies can be visible at once, tracked independently per name on the same entity", () => {
    const { entities, state, bus } = makeRig(new Set(["stack", "squad"]));
    const stackHierarchy = new Hierarchy("stack", bus);
    const squadHierarchy = new Hierarchy("squad", bus);
    const card = createCard("Multi");
    entities.add(card);

    stackHierarchy.setParent(card.id, "response-to");
    squadHierarchy.setParent(card.id, "squad-leader");

    const parents = state.entities.get(card.id)!.hierarchyParents;
    expect(parents.get("stack")).toBe("response-to");
    expect(parents.get("squad")).toBe("squad-leader");
  });
});

describe("SyncManager: visibility recompute per registered seat", () => {
  it("adds an entity to a seat's view when it's visible, and removes it the moment it becomes hidden from that seat", () => {
    const { entities, sync } = makeRig();
    const view = { add: vi.fn(), remove: vi.fn() } as unknown as StateView;
    sync.registerSeat("fixer-A", view);

    const publicZone = createZone({ visibility: "public" });
    const fixerBZone = createZone({ visibility: "owner-only" });
    entities.add(publicZone);
    entities.add(fixerBZone);
    entities.transferOwnershipTo(fixerBZone.id, "fixer-B");

    const card = createCard("Runner", { zoneId: publicZone.id });
    entities.add(card); // entity:created -> recompute -> visible to fixer-A (public)

    expect(view.add).toHaveBeenCalledWith(expect.objectContaining({ id: card.id }));
    vi.clearAllMocks();

    entities.moveToZone(card.id, fixerBZone.id); // now owned by fixer-B, hidden from fixer-A
    expect(view.remove).toHaveBeenCalledWith(expect.objectContaining({ id: card.id }));
  });

  it("unregisterSeat stops further updates to that seat", () => {
    const { entities, sync } = makeRig();
    const view = { add: vi.fn(), remove: vi.fn() } as unknown as StateView;
    sync.registerSeat("fixer-A", view);
    sync.unregisterSeat("fixer-A");

    entities.add(createCard("Runner"));
    expect(view.add).not.toHaveBeenCalled();
  });
});

// --- end-to-end: a real room proving the wiring is automatic, not something the test does by hand ---

class SyncRoom extends TableRoom {
  private entities!: EntityStore;
  private sync!: SyncManager;

  onCreate(options: TableRoomCreateOptions): void {
    super.onCreate(options);
    const bus = new EventBus();
    this.entities = new EntityStore(bus);
    this.sync = new SyncManager(this.entities, this.state.entities as unknown as MapSchema<EntitySchemaInstance>);
    this.sync.wire(bus);
  }

  onJoin(client: Client, options: { identity: string }): void {
    super.onJoin(client, options);
    const seatId = this.seatOf(client.sessionId)!;
    const view = new StateView();
    client.view = view;
    this.sync.registerSeat(seatId, view);
  }

  addPublicCard(id: string): void {
    this.entities.add(createCard("Public", { id, zoneId: null }));
  }

  addOwnerOnlyCard(id: string, zoneOwnerSeat: string): void {
    const zone = createZone({ visibility: "owner-only" }, { id: `${id}-zone` });
    this.entities.add(zone);
    this.entities.transferOwnershipTo(zone.id, zoneOwnerSeat);
    this.entities.add(createCard("Secret", { id, zoneId: zone.id }));
  }

  reassignZoneOwner(zoneId: string, newOwnerSeat: string): void {
    this.entities.transferOwnershipTo(zoneId, newOwnerSeat);
  }
}

describe("end-to-end: entities created/moved live automatically reach the right connected clients", () => {
  let server: ColyseusTestServer;
  let port = 23500;

  beforeEach(async () => {
    port += 1;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    server = await boot({ rooms: { sync: defineRoom(SyncRoom) } } as any, port);
  });

  afterEach(async () => {
    await server.shutdown();
  });

  it("a public entity created after clients join reaches both of them", async () => {
    const room = await server.createRoom("sync", { seatOrder: ["fixer-A", "fixer-B"] });
    const roomInstance = room as unknown as SyncRoom;
    const clientA = await server.connectTo(room, { identity: "user-A" });
    const clientB = await server.connectTo(room, { identity: "user-B" });

    roomInstance.addPublicCard("card-public");
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(clientA.state.entities.has("card-public")).toBe(true);
    expect(clientB.state.entities.has("card-public")).toBe(true);
  });

  it("an owner-only entity reaches only its owner, and reassigning zone ownership live moves visibility to the new owner", async () => {
    const room = await server.createRoom("sync", { seatOrder: ["fixer-A", "fixer-B"] });
    const roomInstance = room as unknown as SyncRoom;
    const clientA = await server.connectTo(room, { identity: "user-A" });
    const clientB = await server.connectTo(room, { identity: "user-B" });

    roomInstance.addOwnerOnlyCard("card-secret", "fixer-A");
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(clientA.state.entities.has("card-secret")).toBe(true);
    expect(clientB.state.entities.has("card-secret")).toBe(false);

    roomInstance.reassignZoneOwner("card-secret-zone", "fixer-B");
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(clientA.state.entities.has("card-secret")).toBe(false); // revoked live
    expect(clientB.state.entities.has("card-secret")).toBe(true); // granted live
  });
});
