/**
 * Layer 9.0 — Schema mirroring.
 *
 * Colyseus Schema classes mirroring core/entity.ts's shapes, plus the
 * translation functions from our actual source of truth (Entity, as held
 * by EntityStore) onto them. This file is pure data-shape translation —
 * no room, no client, no bus wiring. That's 9.1+ (room lifecycle) and 9.4
 * (the live sync loop that calls applyEntityToSchema in response to bus
 * events). Nothing here assumes a room exists.
 *
 * Uses @colyseus/schema v5's non-decorator `schema()`/`t` builder API
 * rather than the `@type()` decorator API — same reasoning as everywhere
 * else in this codebase: plain data/functions over decorators, and it
 * avoids turning on experimentalDecorators project-wide for one dependency.
 *
 * Colyseus primitive fields have no "null" variant (only `t.ref()` types
 * can be undefined) — `zoneId: null` is written as the empty string `""`
 * on the wire. NULL_ZONE_SENTINEL / readZoneId below are the encode/decode
 * ends of that one deliberate compromise.
 */

import { schema, t, type SchemaType } from "@colyseus/schema";
import type { ArraySchema, MapSchema, SetSchema } from "@colyseus/schema";
import type { BaseProperties, Entity, OwnershipStack } from "../core/entity.ts";
import type { EntityId } from "../core/id.ts";

export const NULL_ZONE_SENTINEL = "";

export const EntitySchema = schema(
  {
    id: t.string(),
    kind: t.string(),
    zoneId: t.string().default(NULL_ZONE_SENTINEL),
    tags: t.set("string"),
    properties: t.map("number"),
    ownership: t.array("string"),
    /**
     * Per-hierarchy parent links — a hierarchy shows up here ONLY if a
     * game has explicitly opted it into sync (SyncManager's
     * `visibleHierarchies`); an unlisted hierarchy (e.g. cyberfixer's
     * "deck," deliberately hidden by design) never touches this map at
     * all. Three states per hierarchy NAME, mirroring Hierarchy.getParent
     * itself: key ABSENT = not currently classified in that hierarchy;
     * key present as NULL_ZONE_SENTINEL = classified as a root; key
     * present as a real id = that entity's parent in that hierarchy.
     */
    hierarchyParents: t.map("string"),
  },
  "Entity",
);

export const CardSchema = EntitySchema.extend({ name: t.string() }, "Card");
export const TokenSchema = EntitySchema.extend({ name: t.string() }, "Token");
export const HandSchema = EntitySchema.extend({ cardIds: t.array("string") }, "Hand");
export const ZoneSchema = EntitySchema.extend(
  {
    snappable: t.boolean(),
    favoritable: t.boolean(),
    visibility: t.string(),
  },
  "Zone",
);
export const TableSchema = EntitySchema.extend({ childIds: t.array("string") }, "Table");

export type EntitySchemaInstance =
  | SchemaType<typeof CardSchema>
  | SchemaType<typeof TokenSchema>
  | SchemaType<typeof HandSchema>
  | SchemaType<typeof ZoneSchema>
  | SchemaType<typeof TableSchema>;

const SCHEMA_CONSTRUCTORS = {
  card: CardSchema,
  token: TokenSchema,
  hand: HandSchema,
  zone: ZoneSchema,
  table: TableSchema,
} as const;

/** Reads zoneId back, decoding the null sentinel. */
export function readZoneId(target: EntitySchemaInstance): EntityId | null {
  return target.zoneId === NULL_ZONE_SENTINEL ? null : target.zoneId;
}

/**
 * Applies one hierarchy's parent-link change for a single entity onto
 * its schema instance — called by SyncManager only for hierarchy names
 * the game has explicitly opted into sync (see hierarchyParents' own
 * doc comment on EntitySchema for the three-state mapping this
 * maintains). `parentId` matches hierarchy:parentChanged's own field
 * exactly: undefined = no longer classified (delete the key entirely,
 * not just clear its value — an absent key and an empty-string value
 * mean genuinely different things here), null = a root, a real id =
 * that entity's parent.
 */
export function syncHierarchyParent(target: EntitySchemaInstance, hierarchyName: string, parentId: EntityId | null | undefined): void {
  if (parentId === undefined) {
    target.hierarchyParents.delete(hierarchyName);
  } else {
    target.hierarchyParents.set(hierarchyName, parentId === null ? NULL_ZONE_SENTINEL : parentId);
  }
}

// --- collection sync helpers ------------------------------------------
// Sets/maps (tags/properties) get a real diff — add/remove/update only
// what changed — since those are the common high-frequency single-field
// mutations (one tag, one property) where a granular sync meaningfully
// reduces what goes out on the wire. Arrays (ownership,
// cardIds, childIds) are order-sensitive and typically change wholesale
// (a push/pop, a reshuffle) — clear-and-rewrite is simplest and correct
// for those; a positional diff would be needless complexity here.

function syncSet(target: SetSchema<string>, source: ReadonlySet<string>): void {
  for (const value of [...target]) {
    if (!source.has(value)) target.delete(value);
  }
  for (const value of source) {
    if (!target.has(value)) target.add(value);
  }
}

function syncMap(target: MapSchema<number>, source: Readonly<BaseProperties>): void {
  for (const key of [...target.keys()]) {
    if (!(key in source)) target.delete(key);
  }
  for (const [key, value] of Object.entries(source)) {
    if (target.get(key) !== value) target.set(key, value);
  }
}

function syncArray(target: ArraySchema<string>, source: readonly string[]): void {
  target.clear();
  target.push(...source);
}

function syncOwnership(target: ArraySchema<string>, ownership: OwnershipStack | undefined): void {
  syncArray(target, ownership ?? []);
}

// --- translation --------------------------------------------------------

function applyBaseFields(target: EntitySchemaInstance, entity: Entity): void {
  target.id = entity.id;
  target.kind = entity.kind;
  target.zoneId = entity.zoneId ?? NULL_ZONE_SENTINEL;
  syncSet(target.tags, entity.tags);
  syncMap(target.properties, entity.properties);
  syncOwnership(target.ownership, entity.ownership);
}

/**
 * Copies current Entity state onto an EXISTING schema instance's fields,
 * via the sync helpers above (so mutating an already-attached instance —
 * the case that matters for real Colyseus diffing in 9.4 — produces a
 * small diff rather than looking like a full replacement).
 */
export function applyEntityToSchema(target: EntitySchemaInstance, entity: Entity): void {
  applyBaseFields(target, entity);
  switch (entity.kind) {
    case "card":
    case "token":
      (target as SchemaType<typeof CardSchema>).name = entity.name;
      break;
    case "hand":
      syncArray((target as SchemaType<typeof HandSchema>).cardIds, entity.cardIds);
      break;
    case "zone": {
      const zoneTarget = target as SchemaType<typeof ZoneSchema>;
      zoneTarget.snappable = entity.snappable;
      zoneTarget.favoritable = entity.favoritable;
      zoneTarget.visibility = entity.visibility;
      break;
    }
    case "table":
      syncArray((target as SchemaType<typeof TableSchema>).childIds, entity.childIds);
      break;
  }
}

/** Builds a brand-new schema instance for an entity that doesn't have one yet. */
export function createSchemaForEntity(entity: Entity): EntitySchemaInstance {
  const target = new SCHEMA_CONSTRUCTORS[entity.kind]();
  applyEntityToSchema(target, entity);
  return target;
}
