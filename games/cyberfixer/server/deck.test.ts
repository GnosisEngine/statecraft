import { describe, expect, it } from "vitest";
import { EventBus } from "../../../src/events/bus.ts";
import { Hierarchy } from "../../../src/events/hierarchy.ts";
import { SeededRandom } from "../../../src/persistence/seeded-random.ts";
import { Deck, deckRandomDomain } from "./deck.ts";

function makeDeck(): { deck: Deck; hierarchy: Hierarchy } {
  const hierarchy = new Hierarchy("deck", new EventBus());
  return { deck: new Deck(hierarchy), hierarchy };
}

describe("Deck", () => {
  it("addToPool classifies a card under its fixer, unordered (no siblingIndex)", () => {
    const { deck, hierarchy } = makeDeck();
    deck.addToPool("card-1", "fixer-A");
    expect(hierarchy.getParent("card-1")).toBe("fixer-A");
  });

  it("removeFromPool un-classifies a card entirely, without drawing it", () => {
    const { deck } = makeDeck();
    deck.addToPool("card-1", "fixer-A");
    deck.removeFromPool("card-1");
    expect(deck.isUnclassified("card-1")).toBe(true);
  });

  it("draw pulls one card uniformly from the fixer's pool and removes it", () => {
    const { deck } = makeDeck();
    deck.addToPool("only-card", "fixer-A");
    const drawn = deck.draw("fixer-A", new SeededRandom(1));
    expect(drawn).toBe("only-card");
    expect(deck.isUnclassified("only-card")).toBe(true);
  });

  it("draw returns undefined on an empty pool, without throwing", () => {
    const { deck } = makeDeck();
    expect(deck.draw("empty-fixer", new SeededRandom(1))).toBeUndefined();
  });

  it("remainingCount and poolIds reflect the current pool, shrinking as cards are drawn/removed", () => {
    const { deck } = makeDeck();
    deck.addToPool("a", "fixer-A");
    deck.addToPool("b", "fixer-A");
    deck.addToPool("c", "fixer-A");
    expect(deck.remainingCount("fixer-A")).toBe(3);
    expect(deck.poolIds("fixer-A").sort()).toEqual(["a", "b", "c"]);

    deck.removeFromPool("a");
    deck.draw("fixer-A", new SeededRandom(1));
    expect(deck.remainingCount("fixer-A")).toBe(1);
  });

  it("isUnclassified is false for a card still in a pool, true for one never added or already removed", () => {
    const { deck } = makeDeck();
    deck.addToPool("in-pool", "fixer-A");
    expect(deck.isUnclassified("in-pool")).toBe(false);
    expect(deck.isUnclassified("never-added")).toBe(true);
  });
});

describe("deckRandomDomain", () => {
  it("is a stable, per-fixer domain string", () => {
    expect(deckRandomDomain("fixer-A")).toBe("fixer-A:deck");
    expect(deckRandomDomain("fixer-A")).not.toBe(deckRandomDomain("fixer-B"));
  });
});
