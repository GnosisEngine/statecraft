import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client, Room, defineRoom } from "@colyseus/core";
import { boot, ColyseusTestServer } from "@colyseus/testing";
import { schema, t, StateView } from "@colyseus/schema";
import { createCard, createZone, transferOwnership, type Entity, type ZoneEntity } from "../core/entity.ts";
import { createSchemaForEntity, EntitySchema, type EntitySchemaInstance } from "../network/schema.ts";
import { computeVisibleEntityIds } from "../network/visibility.ts";
import { ViewSync } from "../network/view-sync.ts";

describe("ViewSync: diffing against a StateView (no room needed)", () => {
  it("adds newly-visible entities and removes ones no longer visible, leaving unchanged ones alone", () => {
    const view = { add: vi.fn(), remove: vi.fn() } as unknown as StateView;
    const sync = new ViewSync(view);

    const a = createSchemaForEntity(createCard("A", { id: "a" }));
    const b = createSchemaForEntity(createCard("B", { id: "b" }));
    const c = createSchemaForEntity(createCard("C", { id: "c" }));
    const schemas = new Map<string, EntitySchemaInstance>([
      ["a", a],
      ["b", b],
      ["c", c],
    ]);

    sync.update(new Set(["a", "b"]), schemas);
    expect(view.add).toHaveBeenCalledTimes(2);
    expect(view.add).toHaveBeenCalledWith(a);
    expect(view.add).toHaveBeenCalledWith(b);
    expect(view.remove).not.toHaveBeenCalled();

    vi.clearAllMocks();
    sync.update(new Set(["b", "c"]), schemas); // a removed, c added, b unchanged
    expect(view.remove).toHaveBeenCalledTimes(1);
    expect(view.remove).toHaveBeenCalledWith(a);
    expect(view.add).toHaveBeenCalledTimes(1);
    expect(view.add).toHaveBeenCalledWith(c);
  });
});

// --- end-to-end: a real Colyseus room proving per-client filtering actually holds ---

const TestRoomState = schema({ entities: t.map(EntitySchema).view() }, "TestRoomState");

interface Fixture {
  entities: Entity[];
  schemas: Map<string, EntitySchemaInstance>;
}

function buildFixture(): Fixture {
  const publicZone = createZone({ visibility: "public" }, { id: "zone-public" });
  let fixerAZone: ZoneEntity = createZone({ visibility: "owner-only" }, { id: "zone-A" });
  fixerAZone = { ...fixerAZone, ownership: transferOwnership(fixerAZone, "fixer-A") };
  const hiddenZone = createZone({ visibility: "hidden" }, { id: "zone-hidden" });

  const publicCard = createCard("Street Cred", { id: "card-public", zoneId: publicZone.id });
  const fixerACard = createCard("Fixer A's hand", { id: "card-A", zoneId: fixerAZone.id });
  const hiddenCard = createCard("Deck order", { id: "card-hidden", zoneId: hiddenZone.id });

  const entities = [publicZone, fixerAZone, hiddenZone, publicCard, fixerACard, hiddenCard];
  const schemas = new Map(entities.map((e) => [e.id, createSchemaForEntity(e)]));
  return { entities, schemas };
}

class TestRoom extends Room<{ state: InstanceType<typeof TestRoomState> }> {
  private fixture!: Fixture;

  onCreate(): void {
    this.setState(new TestRoomState());
    this.fixture = buildFixture();
    for (const [id, schemaInstance] of this.fixture.schemas) {
      this.state.entities.set(id, schemaInstance);
    }
  }

  onJoin(client: Client, options: { identity: string }): void {
    const view = new StateView();
    client.view = view;
    const sync = new ViewSync(view);
    const byId = new Map(this.fixture.entities.map((e) => [e.id, e]));
    const visible = computeVisibleEntityIds(this.fixture.entities, (id) => byId.get(id), options.identity);
    sync.update(visible, this.fixture.schemas);
  }
}

describe("end-to-end: per-client visibility filtering via a real room", () => {
  let server: ColyseusTestServer;
  let port = 23100;

  beforeEach(async () => {
    port += 1;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    server = await boot({ rooms: { test: defineRoom(TestRoom) } } as any, port);
  });

  afterEach(async () => {
    await server.shutdown();
  });

  it("each client's synced state only contains what they're allowed to see", async () => {
    const room = await server.createRoom("test", {});
    const fixerA = await server.connectTo(room, { identity: "fixer-A" });
    const fixerB = await server.connectTo(room, { identity: "fixer-B" });
    await new Promise((resolve) => setTimeout(resolve, 100));

    const aVisible = [...fixerA.state.entities.keys()].sort();
    const bVisible = [...fixerB.state.entities.keys()].sort();

    // fixer-A: the public zone/card, their own owner-only zone/card — never the hidden zone/card
    expect(aVisible).toContain("card-public");
    expect(aVisible).toContain("card-A");
    expect(aVisible).not.toContain("card-hidden");

    // fixer-B: only the public entities — not fixer-A's owner-only card, never hidden
    expect(bVisible).toContain("card-public");
    expect(bVisible).not.toContain("card-A");
    expect(bVisible).not.toContain("card-hidden");
  });
});
