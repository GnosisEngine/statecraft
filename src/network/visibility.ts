/**
 * Layer 9.2 — Visibility filtering: the decision logic.
 *
 * This is the actual enforcement point for "clients are dumb viewports":
 * whether a given seat can see a given entity is decided HERE, in pure
 * functions with no Colyseus import at all — fully testable without
 * booting a room. view-sync.ts is the thin glue that turns this decision
 * into real StateView add()/remove() calls.
 *
 * Visibility is a property of an entity's CONTAINING ZONE, not of the
 * entity itself — matching the original design ("zones... have
 * visibility"). An entity with no zone (zoneId === null) has nothing to
 * hide behind, so it defaults visible.
 *
 * Scope, stated plainly: this is entity-level, all-or-nothing visibility.
 * A finer-grained need — "opponent has 5 cards in hand, but you can't see
 * which ones" (visible count, hidden identity) — is a real thing card
 * games want, and Colyseus's field-level @view() tags could support it,
 * but it's a genuinely separate, more complex design (masking within an
 * entity rather than across entities) and isn't built here.
 */

import { currentOwner, type Entity, type ZoneEntity } from "../core/entity.ts";
import type { EntityId } from "../core/id.ts";

function asZone(entity: Entity | undefined): ZoneEntity | undefined {
  return entity?.kind === "zone" ? entity : undefined;
}

/** Can `requestingSeatId` see something contained in `zone`? `zone` undefined means "no containing zone" — defaults visible. */
export function computeVisibility(zone: ZoneEntity | undefined, requestingSeatId: EntityId): boolean {
  if (!zone) return true;
  switch (zone.visibility) {
    case "public":
      return true;
    case "hidden":
      return false;
    case "owner-only":
      return currentOwner(zone) === requestingSeatId;
  }
}

/**
 * Full recompute: every entity id currently visible to `requestingSeatId`,
 * given the complete current entity set and a zone lookup. A full
 * recompute (not an incremental diff) — ViewSync (view-sync.ts) is what
 * turns successive calls to this into add()/remove() diffs against a
 * client's StateView.
 */
export function computeVisibleEntityIds(
  entities: Iterable<Entity>,
  getEntity: (id: EntityId) => Entity | undefined,
  requestingSeatId: EntityId,
): Set<EntityId> {
  const visible = new Set<EntityId>();
  for (const entity of entities) {
    if (entity.zoneId === null) {
      visible.add(entity.id);
      continue;
    }
    const zone = asZone(getEntity(entity.zoneId));
    if (computeVisibility(zone, requestingSeatId)) {
      visible.add(entity.id);
    }
  }
  return visible;
}
