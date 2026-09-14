/**
 * Layer 3 — PropertyResolver.
 *
 * Implements Layer 1's QueryContext, same as EntityStore does, but
 * getProperty here returns the fully-resolved value (base + modifier
 * stack, then clamped against any registered bound) instead of the raw
 * base. Anywhere in the engine that currently passes an EntityStore as a
 * QueryContext can pass a PropertyResolver instead and every BoolExpr/
 * NumExpr — including the inflow/outflow folds used in game content —
 * transparently starts seeing live, buffed values with no change to the
 * expression trees themselves.
 *
 * Three capabilities are optional (constructor params 3-5), so every
 * existing `new PropertyResolver(entities, modifiers)` call stays valid
 * unchanged: a QueryFunctionRegistry (needed only if a game's queries use
 * the `call` op), a PropertyBoundsRegistry (needed only if a game
 * wants a property clamped, e.g. outflow capped at inflow), and a
 * HierarchyRegistry (needed only if a game's queries use
 * `childOf`/`descendantOf`).
 */

import type { Entity } from "../core/entity.ts";
import type { EntityId } from "../core/id.ts";
import type { QueryContext } from "../query/interpreter.ts";
import type { QueryFunction, QueryFunctionRegistry } from "../query/functions.ts";
import type { HierarchyRegistry, HierarchyResolution } from "../query/hierarchy-registry.ts";
import { applyModifier } from "./modifier.ts";
import type { ModifierStore } from "./modifier-store.ts";
import type { PropertyBoundsRegistry, PropertyBoundValue } from "./property-bounds.ts";

/** The slice of EntityStore this needs — kept narrow so tests don't need a real EntityStore. */
export interface EntityLookup {
  get(entityId: EntityId): Entity | undefined;
  getAllEntities(): Iterable<Entity>;
}

export class PropertyResolver implements QueryContext {
  /** Tracks entityId:prop pairs currently being resolved, to catch a bound-reference cycle (e.g. two properties each capped at the other) as a clear error instead of infinite recursion. */
  private resolving = new Set<string>();

  constructor(
    private readonly entities: EntityLookup,
    private readonly modifiers: ModifierStore,
    private readonly queryFunctions?: QueryFunctionRegistry,
    private readonly bounds?: PropertyBoundsRegistry,
    private readonly hierarchies?: HierarchyRegistry,
  ) {}

  getAllEntities(): Iterable<Entity> {
    return this.entities.getAllEntities();
  }

  getEntity(entityId: EntityId): Entity | undefined {
    return this.entities.get(entityId);
  }

  getQueryFunction(name: string): QueryFunction | undefined {
    return this.queryFunctions?.get(name);
  }

  resolveHierarchy(name?: string): HierarchyResolution {
    return this.hierarchies?.resolve(name) ?? { ok: false, reason: "no hierarchies are registered for this game" };
  }

  /**
   * Resolves base + active modifiers in priority order, then clamps
   * against any registered bound for this property name. Returns
   * undefined only when the entity itself doesn't exist — an entity with
   * no base value and no modifiers for `prop` resolves to 0, same
   * fallback Layer 1 already uses for raw properties.
   */
  getProperty(entityId: EntityId, prop: string): number | undefined {
    const entity = this.entities.get(entityId);
    if (!entity) return undefined;

    const key = `${entityId}:${prop}`;
    if (this.resolving.has(key)) {
      throw new Error(
        `PropertyResolver: cycle detected resolving "${prop}" on ${entityId} — a bound (min/max) reference chain loops back on itself.`,
      );
    }

    const base = entity.properties[prop] ?? 0;
    const mods = this.modifiers.getModifiersFor(entityId, prop);
    let value = mods.reduce((v, mod) => applyModifier(v, mod), base);

    const bound = this.bounds?.get(prop);
    if (bound) {
      this.resolving.add(key);
      try {
        if (bound.min !== undefined) value = Math.max(value, this.resolveBoundValue(entityId, bound.min));
        if (bound.max !== undefined) value = Math.min(value, this.resolveBoundValue(entityId, bound.max));
      } finally {
        this.resolving.delete(key);
      }
    }

    return value;
  }

  private resolveBoundValue(entityId: EntityId, bound: PropertyBoundValue): number {
    if (typeof bound === "number") return bound;
    return this.getProperty(entityId, bound.refProp) ?? 0;
  }
}
