import { describe, expect, it } from "vitest";
import { toEntityView } from "./entity-view.ts";
import { evaluateBoolExpr } from "../../../../../src/query/interpreter.ts";
import { NULL_ZONE_SENTINEL, type EntitySchemaInstance } from "../../../../../src/network/schema.ts";

/**
 * A fake schema instance built from plain JS Set/Map/Array — toEntityView
 * only ever calls generic collection methods (spread, .entries(), .length)
 * that plain JS collections satisfy identically to the real
 * @colyseus/schema classes, so this is a faithful stand-in without
 * needing a real Decoder/Room.
 */
function fakeSchemaInstance(overrides: Partial<{ id: string; kind: string; zoneId: string; tags: string[]; properties: Record<string, number>; ownership: string[]; name: string }>): EntitySchemaInstance {
  return {
    id: overrides.id ?? "card-1",
    kind: overrides.kind ?? "card",
    zoneId: overrides.zoneId ?? NULL_ZONE_SENTINEL,
    tags: new Set(overrides.tags ?? []),
    properties: new Map(Object.entries(overrides.properties ?? {})),
    ownership: overrides.ownership ?? [],
    ...(overrides.name !== undefined ? { name: overrides.name } : {}),
  } as unknown as EntitySchemaInstance;
}

describe("toEntityView", () => {
  it("converts tags/properties/ownership into real Set/Record/Array — not just structurally similar objects", () => {
    const raw = fakeSchemaInstance({
      id: "card-1",
      kind: "card",
      tags: ["contractor", "shaken"],
      properties: { inflow: 3, outflow: 2 },
      ownership: ["fixer-A"],
      name: "Ace",
    });
    const entity = toEntityView(raw);

    expect(entity.id).toBe("card-1");
    expect(entity.kind).toBe("card");
    expect(entity.tags).toBeInstanceOf(Set);
    expect(entity.tags.has("contractor")).toBe(true);
    expect(entity.properties).toEqual({ inflow: 3, outflow: 2 });
    expect(entity.ownership).toEqual(["fixer-A"]);
    expect((entity as { name?: string }).name).toBe("Ace");
  });

  it("decodes the null-zone sentinel back to a real null, not the empty string", () => {
    const raw = fakeSchemaInstance({ zoneId: NULL_ZONE_SENTINEL });
    expect(toEntityView(raw).zoneId).toBeNull();
  });

  it("an empty ownership array becomes undefined, matching how the server itself represents 'no owner'", () => {
    const raw = fakeSchemaInstance({ ownership: [] });
    expect(toEntityView(raw).ownership).toBeUndefined();
  });

  it("omits `name` entirely for kinds that don't carry one (e.g. zone/table/hand)", () => {
    const raw = fakeSchemaInstance({ kind: "zone" });
    expect("name" in toEntityView(raw)).toBe(false);
  });

  it("the converted entity is a REAL Entity value — the shared evaluator runs against it with zero special-casing", () => {
    const raw = fakeSchemaInstance({ id: "card-1", tags: ["contractor"], zoneId: "zone-1" });
    const entity = toEntityView(raw);
    const ctx = { getAllEntities: () => [entity], getEntity: (id: string) => (id === entity.id ? entity : undefined), getProperty: () => undefined };

    expect(evaluateBoolExpr({ op: "hasTag", tag: "contractor" }, entity.id, ctx)).toBe(true);
    expect(evaluateBoolExpr({ op: "inZone", zoneId: "zone-1" }, entity.id, ctx)).toBe(true);
    expect(evaluateBoolExpr({ op: "inZone", zoneId: "some-other-zone" }, entity.id, ctx)).toBe(false);
  });
});
