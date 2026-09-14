/**
 * client-solid/src/sdk/entity-view.ts — framework-agnostic.
 *
 * Wraps the raw Colyseus-synced entity map into something that
 * implements the SERVER's own QueryContext (src/query/interpreter.ts) —
 * so `evaluateBoolExpr`/`selectEntities`, the exact same pure functions
 * the server uses to decide legality, can run CLIENT-SIDE for instant
 * UX (e.g. highlighting legal targets with zero round-trip), with the
 * server remaining the only authority that actually matters.
 *
 * This works because the wire format already lines up: `tags` is a
 * Set-like collection on the wire (t.set("string")), `properties` a
 * Map-like one (t.map("number")) — `toEntityView` below does the (cheap,
 * on-read) conversion into a REAL `Entity`-shaped value, not just
 * something structurally similar, so the shared evaluator needs zero
 * special-casing for "this came from the network."
 *
 * Reactivity is deliberately entity-level granularity, not per-field:
 * `subscribe` tells a listener WHICH entity changed, not what about it.
 * Finer-grained (per-field) reactivity is the SOLID ADAPTER's job (see
 * ../solid/use-world.ts) — Solid's own store diffing takes over once the
 * adapter does a targeted per-entity update, so the core doesn't need to
 * duplicate that granularity itself.
 */

import { getStateCallbacks, type Room } from "@colyseus/sdk";
import { evaluateBoolExpr, evaluateNumExpr, selectEntities, type QueryContext } from "../../../../../src/query/interpreter.ts";
import type { BoolExpr, NumExpr } from "../../../../../src/query/types.ts";
import { readZoneId, type EntitySchemaInstance } from "../../../../../src/network/schema.ts";
import type { Entity } from "../../../../../src/core/entity.ts";
import type { EntityId } from "../../../../../src/core/id.ts";
import type { CyberFixerRoomState } from "./connection.ts";

/**
 * Converts one synced schema instance into a real Entity value. Loosely
 * typed on purpose: the query evaluator only ever reads the common
 * EntityBase fields (id/kind/tags/zoneId/ownership/properties) plus
 * `name` for cards — it never reads cardIds/childIds/visibility, so
 * this doesn't need to branch per kind to be correct for what's
 * actually consumed.
 */
export function toEntityView(raw: EntitySchemaInstance): Entity {
  const view: Record<string, unknown> = {
    id: raw.id,
    kind: raw.kind,
    zoneId: readZoneId(raw),
    tags: new Set(raw.tags),
    properties: Object.fromEntries(raw.properties.entries()),
    ownership: raw.ownership.length > 0 ? [...raw.ownership] : undefined,
  };
  if ("name" in raw) view.name = (raw as unknown as { name: string }).name;
  return view as unknown as Entity;
}

export class ClientWorld implements QueryContext {
  private byId = new Map<EntityId, Entity>();
  private listeners = new Set<(changedId: EntityId) => void>();

  constructor(room: Room<CyberFixerRoomState>) {
    const callbacks = getStateCallbacks(room);
    callbacks(room.state).entities.onAdd((raw: EntitySchemaInstance, id: string) => {
      this.byId.set(id, toEntityView(raw));
      callbacks(raw).onChange(() => {
        this.byId.set(id, toEntityView(raw));
        this.notify(id);
      });
      this.notify(id);
    });
    callbacks(room.state).entities.onRemove((_raw: EntitySchemaInstance, id: string) => {
      this.byId.delete(id);
      this.notify(id);
    });
  }

  private notify(changedId: EntityId): void {
    for (const listener of this.listeners) listener(changedId);
  }

  /** Fires with the specific entity id that changed (added, removed, or one of its own fields updated) — never a bare "something changed." */
  subscribe(listener: (changedId: EntityId) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getAllEntities(): Iterable<Entity> {
    return this.byId.values();
  }

  getEntity(id: EntityId): Entity | undefined {
    return this.byId.get(id);
  }

  getProperty(id: EntityId, prop: string): number | undefined {
    return this.byId.get(id)?.properties[prop];
  }

  // --- convenience wrappers around the shared evaluator, for UI code that doesn't want to import interpreter.ts directly ---

  evaluate(expr: BoolExpr, subjectId: EntityId): boolean {
    return evaluateBoolExpr(expr, subjectId, this);
  }

  evaluateNumber(expr: NumExpr, subjectId: EntityId): number {
    return evaluateNumExpr(expr, subjectId, this);
  }

  select(where: BoolExpr): Entity[] {
    return selectEntities(where, this);
  }
}
