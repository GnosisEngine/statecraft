/**
 * Layer 9.2 — Visibility filtering: ViewSync.
 *
 * Takes successive "what's currently visible" snapshots (from
 * computeVisibleEntityIds) and turns them into StateView.add()/remove()
 * calls — only for what actually changed, same sync-not-replace
 * discipline as applyEntityToSchema in Layer 9.0. One ViewSync per
 * connected client/seat.
 */

import type { StateView } from "@colyseus/schema";
import type { EntityId } from "../core/id.ts";
import type { EntitySchemaInstance } from "./schema.ts";

export class ViewSync {
  private visible = new Set<EntityId>();

  constructor(private readonly view: StateView) {}

  /** Reconciles the view against a freshly computed visible-id set. */
  update(currentlyVisibleIds: ReadonlySet<EntityId>, schemas: ReadonlyMap<EntityId, EntitySchemaInstance>): void {
    for (const id of this.visible) {
      if (!currentlyVisibleIds.has(id)) {
        const instance = schemas.get(id);
        if (instance) this.view.remove(instance);
      }
    }
    for (const id of currentlyVisibleIds) {
      if (!this.visible.has(id)) {
        const instance = schemas.get(id);
        if (instance) this.view.add(instance);
      }
    }
    this.visible = new Set(currentlyVisibleIds);
  }

  /**
   * Drops bookkeeping for an entity that's been deleted outright (not
   * just hidden). Deleting the entity from its parent MapSchema already
   * retracts it from every client structurally — there's nothing to
   * `view.remove()` — this just stops our internal `visible` set from
   * going stale and referencing an id nothing will ever re-add.
   */
  forget(id: EntityId): void {
    this.visible.delete(id);
  }
}
