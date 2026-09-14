/**
 * Layer 2 — Hierarchy.
 *
 * A named, standalone tree of parent links, sibling order, and
 * classification — never a field on Entity, so the same entity can
 * participate in several independent hierarchies at once without
 * needing to track which ones itself. Classification IS the parent
 * link: an entity absent from the internal map simply isn't part of
 * this tree at all, no separate membership list needed.
 *
 * "Children" are always computed by scanning for `parentId === X`, never
 * stored as an array on the parent — that's the whole point versus the
 * old per-kind cardOrder/cardIds/childIds arrays this generalizes past:
 * adding a hundredth child costs nothing extra, and no parent-side array
 * ever needs rewriting just to move one child.
 *
 * Implements Layer 1's HierarchyLookup (the narrow read interface
 * evaluateBoolExpr/extractBoolExprDependencies actually touch) — same
 * split as EntityStore (Layer 2, mutation + events) implementing
 * PropertyResolver's narrow EntityLookup (Layer 3, reads only).
 */

import type { EntityId } from "../core/id.ts";
import type { HierarchyLookup } from "../query/hierarchy-registry.ts";
import type { SeededRandom } from "../persistence/seeded-random.ts";
import type { EventBus } from "./bus.ts";

/**
 * Wire/snapshot format for one Hierarchy. `entries` uses an object per
 * child (not a [childId, parentId, siblingIndex] tuple) specifically so
 * an absent siblingIndex stays ABSENT through a real JSON.stringify/
 * parse round-trip — a tuple's undefined slot would silently become
 * null, indistinguishable from "explicitly no order" once genuinely
 * serialized, not just held in memory.
 */
export interface SerializedHierarchy {
  name: string;
  entries: Array<{ childId: EntityId; parentId: EntityId | null; siblingIndex?: number }>;
}

export class Hierarchy implements HierarchyLookup {
  readonly name: string;
  private parentOf = new Map<EntityId, EntityId | null>();
  private siblingIndexOf = new Map<EntityId, number>();

  constructor(name: string, private readonly bus: EventBus) {
    this.name = name;
  }

  /**
   * Classifies `childId` under `parentId` (null = a root of this tree).
   * No-op guard compares against the RAW stored value (map.get, which
   * is undefined for "never classified") — the same lesson learned the
   * hard way with EntityStore.setProperty's old `?? 0` bug: undefined
   * and null are genuinely different states here (never classified vs.
   * explicitly a root), and collapsing them would silently drop the
   * first real classification of an entity as a root.
   */
  setParent(childId: EntityId, parentId: EntityId | null, siblingIndex?: number): void {
    const oldParent = this.parentOf.get(childId);
    const oldIndex = this.siblingIndexOf.get(childId);
    if (oldParent === parentId && (siblingIndex === undefined || siblingIndex === oldIndex)) return;

    this.parentOf.set(childId, parentId);
    if (siblingIndex !== undefined) this.siblingIndexOf.set(childId, siblingIndex);
    this.bus.emit({
      type: "hierarchy:parentChanged",
      hierarchy: this.name,
      childId,
      parentId,
      siblingIndex: this.siblingIndexOf.get(childId),
    });
  }

  /** Removes `childId` from this hierarchy entirely — distinct from setParent(childId, null), which still classifies it (as a root). After this, getParent returns undefined again. */
  remove(childId: EntityId): void {
    if (!this.parentOf.has(childId)) return;
    this.parentOf.delete(childId);
    this.siblingIndexOf.delete(childId);
    this.bus.emit({ type: "hierarchy:parentChanged", hierarchy: this.name, childId, parentId: undefined });
  }

  /**
   * Draws one entity uniformly at random from the UNORDERED pool of
   * `parentId`'s children — those with no explicit siblingIndex at all,
   * genuinely undecided order, not the "sorts as if index 0" fallback
   * childrenOf uses for ordered listings. Removes the drawn entity from
   * this hierarchy (via remove — the caller reclassifies it wherever
   * it's actually going, e.g. into a hand with a real siblingIndex
   * there). Deliberately NOT "shuffle once, then pop index 0": no
   * concrete draw order is ever computed or stored for the remainder,
   * so nothing — a memory read, a snapshot — can reveal the future
   * sequence before each draw actually happens. Mathematically
   * identical in distribution to a full upfront shuffle (this is
   * exactly what Fisher-Yates' own correctness proof already relies
   * on), and still reproducible on replay: one RNG call per draw,
   * consumed in the same relative order as the original game produced.
   */
  drawRandom(parentId: EntityId | null, random: SeededRandom): EntityId | undefined {
    const pool = [...this.parentOf.entries()]
      .filter(([childId, p]) => p === parentId && this.siblingIndexOf.get(childId) === undefined)
      .map(([childId]) => childId);
    if (pool.length === 0) return undefined;
    const drawn = pool[random.nextInt(pool.length)]!;
    this.remove(drawn);
    return drawn;
  }

  getParent(childId: EntityId): EntityId | null | undefined {
    return this.parentOf.get(childId);
  }

  /** Computed, sorted by siblingIndex (entities with no explicit index sort as 0, i.e. first). Never a stored array. */
  childrenOf(parentId: EntityId | null): EntityId[] {
    return [...this.parentOf.entries()]
      .filter(([, p]) => p === parentId)
      .sort((a, b) => (this.siblingIndexOf.get(a[0]) ?? 0) - (this.siblingIndexOf.get(b[0]) ?? 0))
      .map(([id]) => id);
  }

  /**
   * Walks up from childId's OWN parent (childId is never its own
   * descendant) looking for ancestorId, with a visited-set that throws
   * loudly the moment a cycle is detected — rather than silently
   * returning false only once maxDepth happens to be exhausted, which
   * would make a genuine authoring bug (A's parent is B, B's parent is
   * A) indistinguishable from "not an ancestor." Exceeding maxDepth on
   * a genuinely long, ACYCLIC chain (no cycle detected) returns false,
   * not a throw — that's an ordinary bounded-search outcome, not a bug.
   */
  isDescendantOf(childId: EntityId, ancestorId: EntityId, maxDepth = 64): boolean {
    const visited = new Set<EntityId>();
    let current = this.parentOf.get(childId);
    let depth = 0;
    while (current !== undefined && current !== null && depth < maxDepth) {
      if (current === ancestorId) return true;
      if (visited.has(current)) {
        throw new Error(`Hierarchy "${this.name}": cycle detected walking ancestors of "${childId}" (revisited "${current}").`);
      }
      visited.add(current);
      current = this.parentOf.get(current);
      depth++;
    }
    return false;
  }

  /** Captures the full state of this hierarchy — every classification and sibling index — for Snapshot (Layer 7). */
  serialize(): SerializedHierarchy {
    const entries: SerializedHierarchy["entries"] = [];
    for (const [childId, parentId] of this.parentOf.entries()) {
      const siblingIndex = this.siblingIndexOf.get(childId);
      entries.push(siblingIndex === undefined ? { childId, parentId } : { childId, parentId, siblingIndex });
    }
    return { name: this.name, entries };
  }

  /**
   * Replaces this hierarchy's ENTIRE state from a snapshot — clears
   * whatever was there first, same "restoring prior state, not a new
   * live mutation" principle as EntityStore/ModifierStore's own loadRaw
   * (see snapshot.ts's header): fires no hierarchy:parentChanged events,
   * since nothing actually just changed from the game's point of view,
   * it's being reconstructed. Throws on a name mismatch rather than
   * silently loading one hierarchy's data into a differently-named
   * instance — a caller bug that would otherwise corrupt state quietly.
   */
  loadRaw(data: SerializedHierarchy): void {
    if (data.name !== this.name) {
      throw new Error(`Hierarchy.loadRaw: data is for hierarchy "${data.name}", but this is "${this.name}" — pass the matching Hierarchy instance.`);
    }
    this.parentOf.clear();
    this.siblingIndexOf.clear();
    for (const entry of data.entries) {
      this.parentOf.set(entry.childId, entry.parentId);
      if (entry.siblingIndex !== undefined) this.siblingIndexOf.set(entry.childId, entry.siblingIndex);
    }
  }
}
