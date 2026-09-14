/**
 * Layer 0 — Identity.
 *
 * All entities are identified by a GUID that never changes for the lifetime
 * of the entity, independent of where it currently sits (zone, hand, deck).
 * Downstream layers (query, event log, forking) all assume ids are stable
 * and globally unique across a game and its forks.
 */

export type EntityId = string;

/**
 * Generates a new entity id. Uses crypto.randomUUID under the hood.
 *
 * NOTE ON DETERMINISM: id generation happens at entity-creation time, which
 * is itself the result of an action resolving. As long as entity creation
 * is only ever triggered by logged events (never ad-hoc during replay), the
 * *order* of id generation is deterministic even though the ids themselves
 * are random — replay re-runs the same creation events in the same order,
 * so if you need the id to match on replay, log the generated id as part of
 * the event payload rather than regenerating it during replay.
 */
export function newEntityId(): EntityId {
  return crypto.randomUUID();
}
