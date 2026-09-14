/**
 * Layer 1 — Query Engine: hierarchy registry.
 *
 * A Hierarchy is a named, standalone tree — never a field on Entity, so
 * nothing about an entity itself says which trees it's in. This is the
 * narrow READ interface Layer 1 needs (mirrors how PropertyResolver
 * exposes a narrow EntityLookup instead of depending on the concrete
 * mutable EntityStore class) — the actual mutable Hierarchy class, which
 * needs an EventBus to announce changes, lives at Layer 2
 * (events/hierarchy.ts) and implements this.
 *
 * `zoneId` on Entity is untouched by any of this, deliberately — it
 * stays the engine-native mechanism Layer 9's visibility computation
 * reads. This registry is purely ADDITIVE: for game-defined trees
 * (squads, attachments, command structure) that never need to
 * auto-sync or drive visibility.
 */

import type { EntityId } from "../core/id.ts";

export interface HierarchyLookup {
  readonly name: string;
  /** undefined = this entity was never classified in this hierarchy at all; null = classified as a root (no parent). */
  getParent(childId: EntityId): EntityId | null | undefined;
  isDescendantOf(childId: EntityId, ancestorId: EntityId, maxDepth?: number): boolean;
}

export type HierarchyResolution = { ok: true; hierarchy: HierarchyLookup } | { ok: false; reason: string };

export class HierarchyRegistry {
  private hierarchies = new Map<string, HierarchyLookup>();

  register(hierarchy: HierarchyLookup): void {
    this.hierarchies.set(hierarchy.name, hierarchy);
  }

  /**
   * name omitted -> the ONE registered hierarchy, if there's exactly
   * one; explicit and unambiguous otherwise. Both evaluateBoolExpr and
   * extractBoolExprDependencies call this SAME method, so they can never
   * disagree about what counts as ambiguous. Adding a second hierarchy
   * to a game that previously omitted the name everywhere means every
   * one of those queries starts throwing here, all at once — loud and
   * immediate on purpose, not a silently-wrong pick of whichever
   * hierarchy happened to be registered first.
   */
  resolve(name?: string): HierarchyResolution {
    if (name !== undefined) {
      const hierarchy = this.hierarchies.get(name);
      return hierarchy ? { ok: true, hierarchy } : { ok: false, reason: `no hierarchy registered for "${name}"` };
    }
    if (this.hierarchies.size === 1) {
      return { ok: true, hierarchy: [...this.hierarchies.values()][0]! };
    }
    if (this.hierarchies.size === 0) {
      return { ok: false, reason: "no hierarchies are registered for this game" };
    }
    const names = [...this.hierarchies.keys()].join(", ");
    return { ok: false, reason: `hierarchy name required — ${this.hierarchies.size} are registered (${names}) and none can be assumed` };
  }
}
