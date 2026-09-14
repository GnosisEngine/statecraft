/**
 * Layer 3 — PropertyBounds.
 *
 * A bound on a property name, applied after modifier resolution. Either
 * side can be a literal number OR a reference to another property on the
 * SAME entity, resolved live — a static number can't express "outflow's
 * ceiling is whatever this entity's inflow currently is," since that
 * changes over the course of a game. Bounds are declared per PROPERTY
 * NAME, not per entity: "outflow caps at inflow" applies to every entity
 * that has both properties, not one specific card.
 */

export type PropertyBoundValue = number | { refProp: string };

export interface PropertyBound {
  min?: PropertyBoundValue;
  max?: PropertyBoundValue;
}

export class PropertyBoundsRegistry {
  private bounds = new Map<string, PropertyBound>();

  set(prop: string, bound: PropertyBound): void {
    this.bounds.set(prop, bound);
  }

  get(prop: string): PropertyBound | undefined {
    return this.bounds.get(prop);
  }
}
