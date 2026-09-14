/**
 * client-solid/src/solid/use-world.ts — the ONLY Solid-specific file in
 * the reactive chain. Everything upstream (ClientWorld) is framework-
 * agnostic; a React (or any other) adapter would do the analogous thing
 * with its own primitives against the exact same ClientWorld — nothing
 * about ClientWorld itself is Solid-shaped.
 *
 * ClientWorld's own notifications are entity-level ("this id changed"),
 * not per-field. This adapter turns that into fine-grained reactivity by
 * doing a TARGETED update per notified id (`setEntities(id, ...)`) —
 * Solid's own store diffing then only re-renders whatever actually read
 * that entity's specific fields. The core never needed to duplicate that
 * granularity itself.
 */

import { createStore } from "solid-js/store";
import { onCleanup } from "solid-js";
import type { ClientWorld } from "../sdk/entity-view.ts";
import type { Entity } from "../../../../../src/core/entity.ts";
import type { EntityId } from "../../../../../src/core/id.ts";

export function useWorld(world: ClientWorld) {
  const initial: Record<EntityId, Entity> = {};
  for (const entity of world.getAllEntities()) initial[entity.id] = entity;
  const [entities, setEntities] = createStore(initial);

  const unsubscribe = world.subscribe((id) => {
    const current = world.getEntity(id);
    setEntities(id, current as Entity); // current is undefined on removal — Solid stores treat that as "gone"
  });
  onCleanup(unsubscribe);

  return entities;
}
