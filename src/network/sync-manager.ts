/**
 * Layer 9.4 — the sync loop: SyncManager.
 *
 * Subscribes ONCE to EntityStore's bus, via onAny — same pattern as
 * RuleEngine (Layer 5) and wireQuerySubscriptions (Layer 2): one
 * subscriber among several, knowing nothing about the others. This is
 * what turns 9.0 (schema translation) and 9.2 (visibility) into
 * something that actually runs continuously against live gameplay,
 * instead of functions someone has to remember to call by hand.
 *
 * Visibility is recomputed with a full pass (computeVisibleEntityIds
 * over every entity) on every relevant mutation, for every registered
 * seat — not incrementally. A zone's ownership or visibility changing
 * can affect many entities at once (everything currently inside it), so
 * a full recompute is the simplest thing that's always correct; this
 * engine has deferred exactly this kind of optimization before (see
 * memoization in the query layer) until something actually demands it.
 */

import type { Entity } from "../core/entity.ts";
import type { EntityId } from "../core/id.ts";
import type { EventBus } from "../events/bus.ts";
import type { EntityStore } from "../events/entity-store.ts";
import type { GameEvent } from "../events/types.ts";
import type { MapSchema, StateView } from "@colyseus/schema";
import { computeVisibleEntityIds } from "./visibility.ts";
import { applyEntityToSchema, createSchemaForEntity, syncHierarchyParent, type EntitySchemaInstance } from "./schema.ts";
import { ViewSync } from "./view-sync.ts";

export class SyncManager {
  private schemas = new Map<EntityId, EntitySchemaInstance>();
  private viewSyncsBySeat = new Map<EntityId, ViewSync>();

  /**
   * `visibleHierarchies` is opt-in and defaults to none, deliberately —
   * omitting it is a SAFE default (nothing new syncs, identical to
   * behavior before this existed), unlike Snapshot's hierarchies/stacks
   * params, where omission means silent state loss. A hierarchy NOT
   * listed here (cyberfixer's "deck," by design) never has its
   * structure exposed to any client, no matter what else changes.
   */
  constructor(
    private readonly entities: EntityStore,
    private readonly stateEntities: MapSchema<EntitySchemaInstance>,
    private readonly visibleHierarchies: ReadonlySet<string> = new Set(),
  ) {}

  /** Subscribes to the bus. Returns an unsubscribe function. Call once, after construction. */
  wire(bus: EventBus): () => void {
    return bus.onAny((event) => this.handleEvent(event));
  }

  /** Registers a connected seat's StateView so it starts participating in sync, and gives it its initial visible set immediately. */
  registerSeat(seatId: EntityId, view: StateView): void {
    const viewSync = new ViewSync(view);
    this.viewSyncsBySeat.set(seatId, viewSync);
    this.recomputeVisibilityFor(seatId, viewSync);
  }

  /** Stops tracking a seat (e.g. on final disconnect). Does not touch the StateView itself — that's Colyseus's to dispose. */
  unregisterSeat(seatId: EntityId): void {
    this.viewSyncsBySeat.delete(seatId);
  }

  private handleEvent(event: GameEvent): void {
    switch (event.type) {
      case "entity:created": {
        const schemaInstance = createSchemaForEntity(event.entity);
        this.schemas.set(event.entity.id, schemaInstance);
        this.stateEntities.set(event.entity.id, schemaInstance);
        this.recomputeAllVisibility();
        return;
      }
      case "entity:removed": {
        this.schemas.delete(event.entityId);
        this.stateEntities.delete(event.entityId);
        for (const viewSync of this.viewSyncsBySeat.values()) viewSync.forget(event.entityId);
        this.recomputeAllVisibility();
        return;
      }
      case "entity:tagAdded":
      case "entity:tagRemoved":
      case "entity:propertyChanged":
      case "entity:zoneChanged":
      case "entity:ownershipChanged": {
        // Re-sync that entity's schema fields, then recompute visibility
        // for everyone — a zoneChanged/ownershipChanged on a ZONE can
        // affect visibility of every entity currently inside it, not
        // just the entity that changed.
        const entity: Entity | undefined = this.entities.get(event.entityId);
        const schemaInstance = this.schemas.get(event.entityId);
        if (entity && schemaInstance) {
          applyEntityToSchema(schemaInstance, entity);
        }
        this.recomputeAllVisibility();
        return;
      }
      case "hierarchy:parentChanged": {
        // Deliberately NOT gated the same way tag/property changes are —
        // a hierarchy not in visibleHierarchies is skipped entirely,
        // never even touching that entity's schema, so an unlisted
        // hierarchy (cyberfixer's "deck") stays exactly as invisible to
        // every client as it was before this case existed at all.
        if (!this.visibleHierarchies.has(event.hierarchy)) return;
        const schemaInstance = this.schemas.get(event.childId);
        if (schemaInstance) {
          syncHierarchyParent(schemaInstance, event.hierarchy, event.parentId);
        }
        return;
      }
      default:
        return; // modifier/action/rule/phase events don't affect entity mirroring
    }
  }

  private recomputeAllVisibility(): void {
    for (const [seatId, viewSync] of this.viewSyncsBySeat) {
      this.recomputeVisibilityFor(seatId, viewSync);
    }
  }

  private recomputeVisibilityFor(seatId: EntityId, viewSync: ViewSync): void {
    const visible = computeVisibleEntityIds(this.entities.getAllEntities(), (id) => this.entities.get(id), seatId);
    viewSync.update(visible, this.schemas);
  }
}
