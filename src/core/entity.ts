/**
 * Layer 0 — Core Data Model.
 *
 * Plain data shapes only. No behavior lives here — property resolution
 * (Layer 3), action legality (Layer 4), and rules (Layer 5) all operate ON
 * these shapes, they don't extend them with methods. Keeping entities as
 * plain serializable data is what makes snapshotting, replay, and forking
 * possible: an Entity is exactly what gets written to a snapshot.
 */

import type { EntityId } from "./id.ts";

/**
 * "deck" was here once — an EntityKind with an ordered cardOrder array,
 * shuffled at setup. Retired: "deck" is a GAME concept (not every game
 * has one, and the ones that do want genuinely different things from it
 * — a fully-revealed pile needs no hiding at all, a hidden draw pool
 * needs the unordered-pool trick cardOrder can't express), so the
 * engine has no opinion about it anymore. A game builds "deck" as its
 * own content, referencing Hierarchy (Layer 2) directly — see
 * games/cyberfixer/server/deck.ts for the worked example.
 */
export type EntityKind = "card" | "token" | "hand" | "zone" | "table";

/**
 * Ownership is a stack, not a flat field. The top of the stack is the
 * current owner; the full stack is the history (relevant for effects like
 * "return to original owner" and for forensic/replay analysis).
 * Push on transfer, pop on revert. Never splice/rewrite history.
 */
export type OwnershipStack = EntityId[]; // stack of fixer/player ids, index 0 = original owner, last = current

/**
 * Base numeric properties, before any modifier stack is applied.
 * Layer 3 resolves these into their "live" computed values; this is just
 * the raw stored base.
 */
export type BaseProperties = Record<string, number>;

/**
 * Tags are the single boolean-fact system. A "status" (tapped, flipped,
 * revealed) is just a tag. Presence = true, absence = false. No separate
 * boolean-property machinery.
 */
export type Tags = Set<string>;

export interface EntityBase {
  id: EntityId;
  kind: EntityKind;
  tags: Tags;
  properties: BaseProperties;
  /**
   * Current containing zone, or null if not placed anywhere (e.g. still in
   * a deck's internal order, or not yet instantiated onto the table).
   * This is the field `inZone` queries read.
   */
  zoneId: EntityId | null;
  /** Present on entities that can be owned (cards, tokens). Absent (undefined) otherwise. */
  ownership?: OwnershipStack;
}

export interface CardEntity extends EntityBase {
  kind: "card";
  name: string;
}

export interface TokenEntity extends EntityBase {
  kind: "token";
  name: string;
}

export interface HandEntity extends EntityBase {
  kind: "hand";
  /** A hand IS a player/fixer. cardIds are the cards currently held. */
  cardIds: EntityId[];
}

export interface ZoneEntity extends EntityBase {
  kind: "zone";
  snappable: boolean;
  favoritable: boolean;
  /** Who can see what's in this zone. Enforced at the network layer (Layer 9). */
  visibility: "public" | "owner-only" | "hidden";
}

export interface TableEntity extends EntityBase {
  kind: "table";
  /** ids of top-level zones/hands directly on the table (and anything a game classifies here, e.g. a deck-holding fixer) */
  childIds: EntityId[];
}

export type Entity =
  | CardEntity
  | TokenEntity
  | HandEntity
  | ZoneEntity
  | TableEntity;

// --- constructors -----------------------------------------------------

import { newEntityId } from "./id.ts";

function baseFields(kind: EntityKind, overrides?: Partial<EntityBase>): EntityBase {
  return {
    id: newEntityId(),
    kind,
    tags: new Set(),
    properties: {},
    zoneId: null,
    ...overrides,
  };
}

export function createCard(name: string, overrides?: Partial<EntityBase>): CardEntity {
  return { ...baseFields("card", overrides), kind: "card", name };
}

export function createToken(name: string, overrides?: Partial<EntityBase>): TokenEntity {
  return { ...baseFields("token", overrides), kind: "token", name };
}

export function createHand(cardIds: EntityId[] = [], overrides?: Partial<EntityBase>): HandEntity {
  return { ...baseFields("hand", overrides), kind: "hand", cardIds };
}

export function createZone(
  opts: { snappable?: boolean; favoritable?: boolean; visibility?: ZoneEntity["visibility"] } = {},
  overrides?: Partial<EntityBase>,
): ZoneEntity {
  return {
    ...baseFields("zone", overrides),
    kind: "zone",
    snappable: opts.snappable ?? false,
    favoritable: opts.favoritable ?? false,
    visibility: opts.visibility ?? "public",
  };
}

export function createTable(childIds: EntityId[] = [], overrides?: Partial<EntityBase>): TableEntity {
  return { ...baseFields("table", overrides), kind: "table", childIds };
}

// --- ownership helpers --------------------------------------------------

/** Returns the current (top-of-stack) owner, or undefined if never owned. */
export function currentOwner(entity: EntityBase): EntityId | undefined {
  return entity.ownership?.[entity.ownership.length - 1];
}

/** Pushes a new owner onto the stack (immutable — returns a new stack). */
export function transferOwnership(entity: EntityBase, newOwner: EntityId): OwnershipStack {
  return [...(entity.ownership ?? []), newOwner];
}

/** Pops the current owner, reverting to the previous one (immutable). */
export function revertOwnership(entity: EntityBase): OwnershipStack {
  const stack = entity.ownership ?? [];
  return stack.slice(0, -1);
}

// --- serialization --------------------------------------------------------
// Entities are plain data except for `tags`, which is a Set and doesn't
// survive JSON.stringify natively. These two functions are the canonical
// wire/snapshot format used by Layer 7 (persistence) and Layer 9 (network).
//
// Every mutable nested field (properties, ownership, and the per-kind
// arrays — cardIds, childIds) needs its own explicit copy, not
// just a spread of the entity itself: `{...entity}` only copies top-level
// keys, so a nested object or array field stays the SAME reference as the
// live entity's. That's fine for a same-turn round-trip, but a snapshot
// specifically needs to survive the live entity continuing to mutate
// afterward (see Layer 7) — an aliased properties object silently
// corrupts the snapshot the moment live play keeps going.

type SerializedOf<E extends Entity> = Omit<E, "tags"> & { tags: string[] };

export type SerializedEntity =
  | SerializedOf<CardEntity>
  | SerializedOf<TokenEntity>
  | SerializedOf<HandEntity>
  | SerializedOf<ZoneEntity>
  | SerializedOf<TableEntity>;

function copyMutableBaseFields(source: {
  properties: BaseProperties;
  ownership?: OwnershipStack;
}): Pick<EntityBase, "properties" | "ownership"> {
  return {
    properties: { ...source.properties },
    ownership: source.ownership ? [...source.ownership] : undefined,
  };
}

export function serializeEntity(entity: Entity): SerializedEntity {
  const base = { ...entity, tags: [...entity.tags], ...copyMutableBaseFields(entity) };
  switch (entity.kind) {
    case "hand":
      return { ...base, cardIds: [...entity.cardIds] } as SerializedEntity;
    case "table":
      return { ...base, childIds: [...entity.childIds] } as SerializedEntity;
    default:
      return base as SerializedEntity;
  }
}

export function deserializeEntity(data: SerializedEntity): Entity {
  const base = { ...data, tags: new Set(data.tags), ...copyMutableBaseFields(data) };
  switch (data.kind) {
    case "hand":
      return { ...base, cardIds: [...data.cardIds] } as Entity;
    case "table":
      return { ...base, childIds: [...data.childIds] } as Entity;
    default:
      return base as Entity;
  }
}
