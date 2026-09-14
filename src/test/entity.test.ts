import { describe, expect, it } from "vitest";
import {
  createCard,
  createZone,
  currentOwner,
  deserializeEntity,
  revertOwnership,
  serializeEntity,
  transferOwnership,
} from "../core/entity.ts";

describe("entity identity", () => {
  it("assigns unique ids", () => {
    const a = createCard("Razor");
    const b = createCard("Razor");
    expect(a.id).not.toBe(b.id);
  });

  it("starts untagged and unzoned", () => {
    const c = createCard("Razor");
    expect(c.tags.size).toBe(0);
    expect(c.zoneId).toBeNull();
  });
});

describe("ownership stack", () => {
  it("has no current owner until transferred", () => {
    const c = createCard("Razor");
    expect(currentOwner(c)).toBeUndefined();
  });

  it("push/pop is immutable and preserves history", () => {
    const c = createCard("Razor");
    const afterFirst = transferOwnership(c, "fixer-A");
    const withFirst = { ...c, ownership: afterFirst };

    expect(currentOwner(withFirst)).toBe("fixer-A");

    const afterSecond = transferOwnership(withFirst, "fixer-B");
    const withSecond = { ...withFirst, ownership: afterSecond };

    expect(currentOwner(withSecond)).toBe("fixer-B");
    expect(withSecond.ownership).toEqual(["fixer-A", "fixer-B"]);

    const reverted = revertOwnership(withSecond);
    expect(reverted).toEqual(["fixer-A"]);
    // original stack untouched
    expect(withSecond.ownership).toEqual(["fixer-A", "fixer-B"]);
  });
});

describe("serialization round-trip", () => {
  it("preserves tags through serialize/deserialize", () => {
    const z = createZone({ snappable: true, visibility: "owner-only" });
    z.tags.add("battlefield");

    const wire = serializeEntity(z);
    expect(Array.isArray(wire.tags)).toBe(true);

    const back = deserializeEntity(wire);
    expect(back.tags instanceof Set).toBe(true);
    expect(back.tags.has("battlefield")).toBe(true);
    expect(back).toEqual(z);
  });
});
