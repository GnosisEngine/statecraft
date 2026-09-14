/**
 * games/cyberfixer/server/deck.ts — "deck" as a GAME concept.
 *
 * The engine has no idea what a deck is — it only knows Hierarchy
 * (Layer 2): parent links, sibling order, and the unordered-pool trick
 * (no siblingIndex at all) that makes genuinely undecided draw order
 * possible. "Deck" as retired from the engine on purpose (see
 * core/entity.ts's note on EntityKind): not every game has one, and the
 * ones that do want different things from it — this file is where
 * "deck," specifically "each fixer's undrawn pool of contractors,"
 * becomes a real, named thing in THIS game's own code. Nothing here is
 * generic engine machinery; it's a thin wrapper giving this game's own
 * vocabulary a home, over a Hierarchy it doesn't own or construct.
 */

import type { EntityId } from "../../../src/core/id.ts";
import type { Hierarchy } from "../../../src/events/hierarchy.ts";
import type { SeededRandom } from "../../../src/persistence/seeded-random.ts";

/** Name of the Hierarchy a Deck wraps — see content.ts's buildContent, which constructs and registers it. */
export const DECK_HIERARCHY_NAME = "deck";

/** RandomRegistry domain for one fixer's draw stream — isolated so no other action anywhere in the match can perturb what this fixer draws next (see the design conversation this came out of: a single shared stream would let unrelated random-consuming actions shift what a fixer's own deck produces). */
export function deckRandomDomain(fixerId: EntityId): string {
  return `${fixerId}:deck`;
}

export class Deck {
  constructor(private readonly hierarchy: Hierarchy) {}

  /** Adds a card to `fixerId`'s undrawn pool — unordered (no siblingIndex), genuinely undecided draw order until it's actually drawn. */
  addToPool(cardId: EntityId, fixerId: EntityId): void {
    this.hierarchy.setParent(cardId, fixerId);
  }

  /** Removes a card from the pool without drawing it — e.g. drafting it straight onto the board, bypassing the draw step entirely. */
  removeFromPool(cardId: EntityId): void {
    this.hierarchy.remove(cardId);
  }

  /** Draws one card uniformly at random from `fixerId`'s pool, consuming `random` — should be that fixer's own isolated RandomRegistry stream (see deckRandomDomain / room.ts), never a shared one. Returns undefined if the pool is empty. */
  draw(fixerId: EntityId, random: SeededRandom): EntityId | undefined {
    return this.hierarchy.drawRandom(fixerId, random);
  }

  /** How many cards remain in `fixerId`'s undrawn pool. */
  remainingCount(fixerId: EntityId): number {
    return this.hierarchy.childrenOf(fixerId).length;
  }

  /** Every card currently in `fixerId`'s undrawn pool — unordered-pool members have no meaningful order among themselves, so don't rely on the array's order. */
  poolIds(fixerId: EntityId): EntityId[] {
    return this.hierarchy.childrenOf(fixerId);
  }

  /** True if `cardId` isn't currently classified in ANY fixer's pool at all — e.g. after being drawn or drafted straight off the top. */
  isUnclassified(cardId: EntityId): boolean {
    return this.hierarchy.getParent(cardId) === undefined;
  }
}
