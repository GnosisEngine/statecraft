import { describe, expect, it } from "vitest";
import { createCard, createZone, transferOwnership, type ZoneEntity } from "../core/entity.ts";
import { computeVisibility, computeVisibleEntityIds } from "../network/visibility.ts";

function ownedZone(visibility: ZoneEntity["visibility"], ownerId: string): ZoneEntity {
  let zone = createZone({ visibility });
  zone = { ...zone, ownership: transferOwnership(zone, ownerId) };
  return zone;
}

describe("computeVisibility", () => {
  it("a public zone is visible to anyone", () => {
    const zone = createZone({ visibility: "public" });
    expect(computeVisibility(zone, "fixer-A")).toBe(true);
    expect(computeVisibility(zone, "fixer-B")).toBe(true);
  });

  it("a hidden zone is visible to no one", () => {
    const zone = createZone({ visibility: "hidden" });
    expect(computeVisibility(zone, "fixer-A")).toBe(false);
  });

  it("an owner-only zone is visible only to its current owner", () => {
    const zone = ownedZone("owner-only", "fixer-A");
    expect(computeVisibility(zone, "fixer-A")).toBe(true);
    expect(computeVisibility(zone, "fixer-B")).toBe(false);
  });

  it("an owner-only zone with no owner is visible to no one", () => {
    const zone = createZone({ visibility: "owner-only" });
    expect(computeVisibility(zone, "fixer-A")).toBe(false);
  });

  it("no containing zone defaults visible (nothing to hide)", () => {
    expect(computeVisibility(undefined, "fixer-A")).toBe(true);
  });
});

describe("computeVisibleEntityIds", () => {
  it("computes the full visible set for a requesting seat across public/owner-only/hidden zones", () => {
    const publicZone = createZone({ visibility: "public" });
    const fixerAZone = ownedZone("owner-only", "fixer-A");
    const fixerBZone = ownedZone("owner-only", "fixer-B");
    const hiddenZone = createZone({ visibility: "hidden" });

    const publicCard = createCard("Street Cred", { zoneId: publicZone.id });
    const fixerACard = createCard("Fixer A's hand", { zoneId: fixerAZone.id });
    const fixerBCard = createCard("Fixer B's hand", { zoneId: fixerBZone.id });
    const hiddenCard = createCard("Deck order", { zoneId: hiddenZone.id });
    const looseToken = createCard("Not in any zone"); // zoneId: null

    const allEntities = [publicZone, fixerAZone, fixerBZone, hiddenZone, publicCard, fixerACard, fixerBCard, hiddenCard, looseToken];
    const byId = new Map(allEntities.map((e) => [e.id, e]));
    const getEntity = (id: string) => byId.get(id);

    const visibleToA = computeVisibleEntityIds(allEntities, getEntity, "fixer-A");

    expect(visibleToA.has(publicCard.id)).toBe(true);
    expect(visibleToA.has(fixerACard.id)).toBe(true);
    expect(visibleToA.has(fixerBCard.id)).toBe(false);
    expect(visibleToA.has(hiddenCard.id)).toBe(false);
    expect(visibleToA.has(looseToken.id)).toBe(true);
    // the zones themselves have no containing zone, so they default visible too
    expect(visibleToA.has(publicZone.id)).toBe(true);
    expect(visibleToA.has(hiddenZone.id)).toBe(true);

    const visibleToB = computeVisibleEntityIds(allEntities, getEntity, "fixer-B");
    expect(visibleToB.has(fixerACard.id)).toBe(false);
    expect(visibleToB.has(fixerBCard.id)).toBe(true);
  });
});
