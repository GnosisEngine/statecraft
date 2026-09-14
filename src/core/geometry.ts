/**
 * Core — geometry.
 *
 * Distance metrics for board-position zones (x/y/z as ordinary
 * properties — no new entity concept, just a convention: the property
 * named "x" means x). Lives in core/, not query/ or actions/, because
 * BOTH of those depend on it and neither should depend on the other:
 * the withinDistance Query op (Layer 1) needs it for reactive rule
 * conditions, and plain-code action targetQuery helpers (Layer 4-ish
 * content) need it for movement legality. One distanceBetween
 * implementation, two consumers — see query/interpreter.ts's
 * "withinDistance" case and entitiesWithinRange below.
 *
 * z is optional throughout: omit it for a square/orthogonal grid, use
 * cube coordinates (x + y + z = 0) for a hex grid — "hex" distance is
 * the standard max-of-three-axis-deltas formula for that representation.
 */

import type { Entity } from "./entity.ts";
import type { EntityId } from "./id.ts";

export interface BoardPoint {
  x: number;
  y: number;
  z?: number;
}

export type DistanceMetric = "chebyshev" | "manhattan" | "hex";

/**
 * chebyshev: square-grid distance including diagonals (a king's move) —
 * the natural default for "adjacent" on a standard grid.
 * manhattan: square-grid distance, orthogonal moves only (a rook's move,
 * no diagonal shortcuts).
 * hex: cube-coordinate hex-grid distance.
 */
export function distanceBetween(a: BoardPoint, b: BoardPoint, metric: DistanceMetric = "chebyshev"): number {
  const dx = Math.abs(a.x - b.x);
  const dy = Math.abs(a.y - b.y);
  switch (metric) {
    case "manhattan":
      return dx + dy;
    case "hex":
      return Math.max(dx, dy, Math.abs((a.z ?? 0) - (b.z ?? 0)));
    case "chebyshev":
      return Math.max(dx, dy);
  }
}

function pointOf(entity: Entity): BoardPoint {
  return { x: entity.properties.x ?? 0, y: entity.properties.y ?? 0, z: entity.properties.z };
}

/**
 * Every entity (typically zones) within `maxDistance` of `from`, reading
 * x/y/z straight off each entity's own properties. The plain-code
 * counterpart to the withinDistance Query op — this is what an action's
 * targetQuery calls to build a legal-destination list at propose time
 * (see the module doc comment above for why targeting and reactive rule
 * conditions each need their own shape here, both backed by the same
 * distanceBetween).
 */
export function entitiesWithinRange(
  entities: Iterable<Entity>,
  from: BoardPoint,
  maxDistance: number,
  metric: DistanceMetric = "chebyshev",
): EntityId[] {
  const result: EntityId[] = [];
  for (const entity of entities) {
    if (distanceBetween(from, pointOf(entity), metric) <= maxDistance) {
      result.push(entity.id);
    }
  }
  return result;
}
