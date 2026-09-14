import { describe, expect, it } from "vitest";
import {
  createCard,
  createHand,
  createTable,
  createToken,
  createZone,
} from "../core/entity.ts";
import {
  CardSchema,
  HandSchema,
  NULL_ZONE_SENTINEL,
  TableSchema,
  TokenSchema,
  ZoneSchema,
  applyEntityToSchema,
  createSchemaForEntity,
  readZoneId,
} from "../network/schema.ts";

describe("createSchemaForEntity: base fields common to every kind", () => {
  it("captures id, kind, zoneId (via the null sentinel), tags, properties, and ownership", () => {
    const zone = createZone();
    const card = createCard("Fence", {
      zoneId: zone.id,
      properties: { inflow: 5, outflow: 2 },
      ownership: ["fixer-A", "fixer-B"],
    });
    card.tags.add("contractor");
    card.tags.add("shaken");

    const wire = createSchemaForEntity(card);

    expect(wire).toBeInstanceOf(CardSchema);
    expect(wire.id).toBe(card.id);
    expect(wire.kind).toBe("card");
    expect(wire.zoneId).toBe(zone.id);
    expect(readZoneId(wire)).toBe(zone.id);
    expect([...wire.tags].sort()).toEqual(["contractor", "shaken"]);
    expect(wire.properties.get("inflow")).toBe(5);
    expect(wire.properties.get("outflow")).toBe(2);
    expect([...wire.ownership]).toEqual(["fixer-A", "fixer-B"]);
  });

  it("encodes a null zoneId as the sentinel, and readZoneId decodes it back to null", () => {
    const card = createCard("Loose");
    const wire = createSchemaForEntity(card);
    expect(wire.zoneId).toBe(NULL_ZONE_SENTINEL);
    expect(readZoneId(wire)).toBeNull();
  });

  it("an unowned entity (no ownership stack) encodes as an empty array", () => {
    const card = createCard("Unowned");
    const wire = createSchemaForEntity(card);
    expect([...wire.ownership]).toEqual([]);
  });
});

describe("createSchemaForEntity: per-kind extra fields", () => {
  it("card/token carry name", () => {
    const card = createCard("Razor");
    const token = createToken("Chip");
    expect(createSchemaForEntity(card)).toBeInstanceOf(CardSchema);
    expect((createSchemaForEntity(card) as InstanceType<typeof CardSchema>).name).toBe("Razor");
    expect(createSchemaForEntity(token)).toBeInstanceOf(TokenSchema);
    expect((createSchemaForEntity(token) as InstanceType<typeof TokenSchema>).name).toBe("Chip");
  });

  it("hand carries cardIds", () => {
    const hand = createHand(["card-1", "card-2"]);
    const wire = createSchemaForEntity(hand) as InstanceType<typeof HandSchema>;
    expect(wire).toBeInstanceOf(HandSchema);
    expect([...wire.cardIds]).toEqual(["card-1", "card-2"]);
  });

  it("zone carries snappable/favoritable/visibility", () => {
    const zone = createZone({ snappable: true, favoritable: false, visibility: "owner-only" });
    const wire = createSchemaForEntity(zone) as InstanceType<typeof ZoneSchema>;
    expect(wire).toBeInstanceOf(ZoneSchema);
    expect(wire.snappable).toBe(true);
    expect(wire.favoritable).toBe(false);
    expect(wire.visibility).toBe("owner-only");
  });

  it("table carries childIds", () => {
    const table = createTable(["zone-1", "zone-2"]);
    const wire = createSchemaForEntity(table) as InstanceType<typeof TableSchema>;
    expect(wire).toBeInstanceOf(TableSchema);
    expect([...wire.childIds]).toEqual(["zone-1", "zone-2"]);
  });
});

describe("applyEntityToSchema: updating an existing instance syncs rather than replaces", () => {
  it("adds/removes exactly the tags that changed", () => {
    const card = createCard("Fence");
    card.tags.add("contractor");
    card.tags.add("shaken");
    const wire = createSchemaForEntity(card);

    card.tags.delete("shaken");
    card.tags.add("flagged");
    applyEntityToSchema(wire, card);

    expect([...wire.tags].sort()).toEqual(["contractor", "flagged"]);
  });

  it("updates changed properties, adds new ones, removes deleted ones, and leaves untouched ones alone", () => {
    const card = createCard("Fence", { properties: { inflow: 5, outflow: 2 } });
    const wire = createSchemaForEntity(card);

    card.properties.inflow = 9; // changed
    delete card.properties.outflow; // removed
    card.properties.reputation = 1; // new
    applyEntityToSchema(wire, card);

    expect(wire.properties.get("inflow")).toBe(9);
    expect(wire.properties.has("outflow")).toBe(false);
    expect(wire.properties.get("reputation")).toBe(1);
  });

  it("re-applying identical state doesn't error and leaves values stable", () => {
    const card = createCard("Fence", { properties: { inflow: 5 } });
    const wire = createSchemaForEntity(card);
    applyEntityToSchema(wire, card);
    applyEntityToSchema(wire, card);
    expect(wire.properties.get("inflow")).toBe(5);
  });
});
