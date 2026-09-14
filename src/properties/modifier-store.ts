/**
 * Layer 3 — ModifierStore.
 *
 * Holds active modifiers and indexes them by (entityId, prop) for fast
 * resolution lookup. Mirrors EntityStore's pattern: mutation methods apply
 * the change then emit an event — nothing reaches in and edits a modifier
 * or the index directly.
 *
 * Listens to its OWN bus for entity:removed and cleans up every modifier
 * still targeting that entity — this is deliberately self-contained
 * (ModifierStore wires its own cleanup by listening to the bus itself)
 * rather than EntityStore reaching forward into Layer 3 to do it, which
 * would be a backwards, lower-layer-knows-about-a-higher-one dependency.
 * Before this existed, a modifier targeting a removed entity survived
 * forever — an orphaned leak accumulating in getAll() (and therefore in
 * every future Snapshot) for as long as the match ran. Removing an
 * entity that was never modified is a normal, harmless no-op here.
 */

import type { EntityId } from "../core/id.ts";
import type { EventBus } from "../events/bus.ts";
import type { Modifier } from "./modifier.ts";

function targetKey(entityId: EntityId, prop: string): string {
  return `${entityId}:${prop}`;
}

export class ModifierStore {
  private modifiers = new Map<string, Modifier>();
  private byTarget = new Map<string, Set<string>>();

  constructor(private readonly bus: EventBus) {
    bus.on("entity:removed", (event) => this.cleanupForEntity(event.entityId));
  }

  private cleanupForEntity(entityId: EntityId): void {
    for (const modifier of [...this.modifiers.values()]) {
      if (modifier.targetEntityId === entityId) {
        this.remove(modifier.id);
      }
    }
  }

  add(modifier: Modifier): void {
    this.modifiers.set(modifier.id, modifier);
    const key = targetKey(modifier.targetEntityId, modifier.prop);
    const set = this.byTarget.get(key) ?? new Set();
    set.add(modifier.id);
    this.byTarget.set(key, set);
    this.bus.emit({ type: "modifier:added", modifier });
  }

  remove(modifierId: string): void {
    const modifier = this.modifiers.get(modifierId);
    if (!modifier) return;
    this.modifiers.delete(modifierId);
    this.byTarget.get(targetKey(modifier.targetEntityId, modifier.prop))?.delete(modifierId);
    this.bus.emit({ type: "modifier:removed", modifier });
  }

  get(modifierId: string): Modifier | undefined {
    return this.modifiers.get(modifierId);
  }

  /** All active modifiers, in no particular order — for snapshotting. */
  getAll(): Modifier[] {
    return [...this.modifiers.values()];
  }

  /** Adds a modifier WITHOUT emitting modifier:added. Snapshot/replay restoration only — see EntityStore.loadRaw for why. */
  loadRaw(modifier: Modifier): void {
    this.modifiers.set(modifier.id, modifier);
    const key = targetKey(modifier.targetEntityId, modifier.prop);
    const set = this.byTarget.get(key) ?? new Set();
    set.add(modifier.id);
    this.byTarget.set(key, set);
  }

  /** Active modifiers targeting entityId's prop, sorted by priority ascending (resolution order). */
  getModifiersFor(entityId: EntityId, prop: string): Modifier[] {
    const ids = this.byTarget.get(targetKey(entityId, prop));
    if (!ids || ids.size === 0) return [];
    return [...ids].map((id) => this.modifiers.get(id)!).sort((a, b) => a.priority - b.priority);
  }
}
