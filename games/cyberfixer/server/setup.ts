/**
 * games/cyberfixer/server/setup.ts — builds the starting state for a
 * new match: an unordered deck pool, empty hand, and empty board per
 * fixer. Fixers are self-owned (ownership: [fixerId]) — this is what
 * lets the FIXER entity itself serve as a valid `performer` for
 * content.ts's "draft" action, which isn't naturally performed through
 * a contractor the way shakedown is.
 *
 * No shuffling happens here — that's the whole point. Each contractor
 * is classified into the deck (see deck.ts — a GAME concept wrapping
 * the engine's Hierarchy) under its owning fixer with NO
 * siblingIndex, an unordered pool; the actual draw order is decided one
 * card at a time, lazily, by Deck.draw (see content.ts's
 * "drawCard"), so no concrete sequence is ever computed or stored ahead
 * of when it's actually needed.
 */

import { createCard, createHand, createTable, createZone } from "../../../src/core/entity.ts";
import { namespacedTag } from "../../../src/core/tags.ts";
import type { EntityStore } from "../../../src/events/entity-store.ts";
import type { Deck } from "./deck.ts";
import type { EntityId } from "../../../src/core/id.ts";
import { CONTRACTOR_TAG, abilityTag, factionTag, boardZoneIdFor, deckZoneIdFor, discardZoneIdFor, handZoneIdFor, type Faction } from "./content.ts";

interface ContractorSpec {
  name: string;
  faction: Faction;
  inflow: number;
  /** How much this contractor contributes to its owner's outflow (spend budget) each turn — see content.ts's header on why this isn't just called "outflow". */
  outflowGrant: number;
  pref?: string;
  weak?: string;
}

/**
 * Each fixer's deck — a modest 5 cards (their 2 previously-hardcoded
 * starting contractors, plus 3 more so "pick 3 at the pregame draft"
 * is an actual choice, not a formality). Stats/names are placeholders,
 * not balanced content — easy to tune or expand later.
 */
const DECKS: Record<"fixer-A" | "fixer-B", ContractorSpec[]> = {
  "fixer-A": [
    { name: "Ace", faction: "corporations", inflow: 3, outflowGrant: 2, pref: "coercion" },
    { name: "Nomad", faction: "gangs", inflow: 3, outflowGrant: 2 },
    { name: "Vex", faction: "shimmer", inflow: 2, outflowGrant: 1 },
    { name: "Ghost", faction: "politics", inflow: 2, outflowGrant: 3 },
    { name: "Rook", faction: "gangs", inflow: 4, outflowGrant: 2 },
  ],
  "fixer-B": [
    { name: "Runner", faction: "shimmer", inflow: 3, outflowGrant: 2 },
    { name: "Sentinel", faction: "politics", inflow: 3, outflowGrant: 2, weak: "coercion" },
    { name: "Cipher", faction: "corporations", inflow: 2, outflowGrant: 1 },
    { name: "Wraith", faction: "gangs", inflow: 2, outflowGrant: 3 },
    { name: "Anchor", faction: "politics", inflow: 4, outflowGrant: 2 },
  ],
};

/** Populates a fresh EntityStore with a table, a public board + discard zone and an owner-only deck + hand zone per fixer, the fixers themselves (self-owned), and their starting contractors classified into the unordered deck pool. */
export function setupMatch(entities: EntityStore, seatOrder: readonly EntityId[], deck: Deck): void {
  const allZoneIds: EntityId[] = [];

  for (const fixerId of seatOrder) {
    const board = createZone({ visibility: "public" }, { id: boardZoneIdFor(fixerId) });
    const discard = createZone({ visibility: "public" }, { id: discardZoneIdFor(fixerId) });
    const deckZone = createZone({ visibility: "owner-only" }, { id: deckZoneIdFor(fixerId), ownership: [fixerId] });
    const handZone = createZone({ visibility: "owner-only" }, { id: handZoneIdFor(fixerId), ownership: [fixerId] });
    for (const zone of [board, discard, deckZone, handZone]) {
      entities.add(zone);
      allZoneIds.push(zone.id);
    }

    // Self-owned: lets the fixer entity itself act as a `performer` for
    // actions with no natural contractor to perform them through (see
    // content.ts's "draft" action).
    entities.add(createHand([], { id: fixerId, ownership: [fixerId], properties: { inflow: 0, outflow: 0 } }));

    const specs = DECKS[fixerId as "fixer-A" | "fixer-B"] ?? [];
    for (const spec of specs) {
      const contractor = createCard(spec.name, {
        // Deterministic, not auto-generated (createCard defaults to
        // crypto.randomUUID() — see core/id.ts). setupMatch runs fresh
        // on every replay too, never through the logged command
        // sequence itself, so anything it creates that a LATER logged
        // command references by id (draft/deploy/shakedown all do) has
        // to come out identical every time setup runs, or replay
        // diverges on the very first command that names a card.
        id: `${fixerId}-card-${spec.name.toLowerCase()}`,
        zoneId: deckZone.id, // still governs visibility (owner-only) — separate from, and unaffected by, the Hierarchy below
        ownership: [fixerId],
        properties: { inflow: spec.inflow, outflowGrant: spec.outflowGrant },
      });
      contractor.tags.add(CONTRACTOR_TAG);
      // Every contractor grants "shakedown" — matches the behavior before
      // shakedown became an ability reached through the generic "activate"
      // action (see content.ts): any contractor could perform it, gated
      // only by performerCondition's hasTag(CONTRACTOR_TAG) check. Now
      // that "activate" requires an explicit ability:<id> tag as proof
      // the card actually grants what's being invoked, this tag is what
      // makes that still true.
      contractor.tags.add(abilityTag("shakedown"));
      contractor.tags.add(abilityTag("claim"));
      contractor.tags.add(abilityTag("countermeasure"));
      contractor.tags.add(factionTag(spec.faction));
      if (spec.pref) contractor.tags.add(namespacedTag("pref", spec.pref));
      if (spec.weak) contractor.tags.add(namespacedTag("weak", spec.weak));
      entities.add(contractor);
      deck.addToPool(contractor.id, fixerId); // no siblingIndex — an unordered pool, not a stored sequence
    }
  }

  entities.add(createTable(allZoneIds, { id: "table-1", properties: { turnCounter: 0, readyCount: 0 } }));
}
