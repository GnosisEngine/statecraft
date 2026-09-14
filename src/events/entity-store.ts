/**
 * Layer 2 — EntityStore.
 *
 * The single place entity mutation is allowed to happen. Every mutation
 * method here does exactly two things: apply the change, then emit the
 * corresponding GameEvent. Nothing upstream (actions, rules) should ever
 * reach into an Entity object and mutate a field directly — going through
 * the store is what guarantees every state change is observable on the
 * bus, which is what Layers 1 (query subscriptions), 5 (rule triggers) and
 * 7 (event log) all depend on.
 *
 * Also implements QueryContext (Layer 1) directly, since "all entities
 * currently in the game" and "an entity's raw property" are exactly what
 * the store already holds.
 */

import {
  revertOwnership,
  transferOwnership,
  type Entity,
} from "../core/entity.ts";
import type { EntityId } from "../core/id.ts";
import type { QueryContext } from "../query/interpreter.ts";
import type { EventBus } from "./bus.ts";

export class UnknownEntityError extends Error {
  constructor(entityId: EntityId) {
    super(`Unknown entity: ${entityId}`);
  }
}

export class EntityStore implements QueryContext {
  private entities = new Map<EntityId, Entity>();

  constructor(private readonly bus: EventBus) {}

  // --- QueryContext -------------------------------------------------

  getAllEntities(): Iterable<Entity> {
    return this.entities.values();
  }

  getEntity(entityId: EntityId): Entity | undefined {
    return this.entities.get(entityId);
  }

  getProperty(entityId: EntityId, prop: string): number | undefined {
    return this.entities.get(entityId)?.properties[prop];
  }

  // --- basic access ---------------------------------------------------

  get(entityId: EntityId): Entity | undefined {
    return this.entities.get(entityId);
  }

  private mustGet(entityId: EntityId): Entity {
    const e = this.entities.get(entityId);
    if (!e) throw new UnknownEntityError(entityId);
    return e;
  }

  // --- mutation: lifecycle ---------------------------------------------

  add(entity: Entity): void {
    this.entities.set(entity.id, entity);
    this.bus.emit({ type: "entity:created", entity });
  }

  /**
   * Adds an entity WITHOUT emitting entity:created. For snapshot/replay
   * restoration only: materializing prior state isn't a new game event,
   * and emitting entity:created for every entity in a snapshot would
   * fire the same rule/subscription cascade as if a huge number of
   * entities had all just been created simultaneously in live play —
   * which they weren't.
   */
  loadRaw(entity: Entity): void {
    this.entities.set(entity.id, entity);
  }

  remove(entityId: EntityId): void {
    const e = this.mustGet(entityId);
    this.entities.delete(entityId);
    this.bus.emit({ type: "entity:removed", entityId, kind: e.kind });
  }

  // --- mutation: tags ---------------------------------------------------

  addTag(entityId: EntityId, tag: string): void {
    const e = this.mustGet(entityId);
    if (e.tags.has(tag)) return; // no-op, no event — nothing actually changed
    e.tags.add(tag);
    this.bus.emit({ type: "entity:tagAdded", entityId, tag });
  }

  removeTag(entityId: EntityId, tag: string): void {
    const e = this.mustGet(entityId);
    if (!e.tags.has(tag)) return;
    e.tags.delete(tag);
    this.bus.emit({ type: "entity:tagRemoved", entityId, tag });
  }

  // --- mutation: properties ---------------------------------------------

  /**
   * The no-op check compares against the RAW stored value (e.properties[prop],
   * which is undefined if never set), not a ??0-defaulted one. Those are
   * genuinely different states for any property whose mere PRESENCE
   * carries meaning (e.g. a "discardedAt" turn-stamp, where 0 is a real,
   * meaningful first value, not "not set yet") — comparing against a
   * defaulted value would silently treat "never set" and "explicitly set
   * to 0" as the same no-op, dropping a real write. A property already
   * genuinely stored as 0 being set to 0 again still correctly no-ops.
   */
  setProperty(entityId: EntityId, prop: string, value: number): void {
    const e = this.mustGet(entityId);
    const oldValue = e.properties[prop];
    if (oldValue === value) return;
    e.properties[prop] = value;
    this.bus.emit({ type: "entity:propertyChanged", entityId, prop, oldValue: oldValue ?? 0, newValue: value });
  }

  // --- mutation: zone membership -----------------------------------------

  moveToZone(entityId: EntityId, zoneId: EntityId | null): void {
    const e = this.mustGet(entityId);
    if (e.zoneId === zoneId) return;
    const oldZoneId = e.zoneId;
    e.zoneId = zoneId;
    this.bus.emit({ type: "entity:zoneChanged", entityId, oldZoneId, newZoneId: zoneId });
  }

  // --- mutation: ownership ------------------------------------------------

  transferOwnershipTo(entityId: EntityId, newOwner: EntityId): void {
    const e = this.mustGet(entityId);
    e.ownership = transferOwnership(e, newOwner);
    this.bus.emit({ type: "entity:ownershipChanged", entityId, ownership: e.ownership });
  }

  revertOwnershipOf(entityId: EntityId): void {
    const e = this.mustGet(entityId);
    e.ownership = revertOwnership(e);
    this.bus.emit({ type: "entity:ownershipChanged", entityId, ownership: e.ownership });
  }
}
