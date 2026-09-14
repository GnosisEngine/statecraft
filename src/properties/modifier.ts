/**
 * Layer 3 — Layered/computed properties: Modifier.
 *
 * A property's "live" value is its base plus every active modifier
 * targeting it, applied in priority order. A Modifier is itself plain
 * data (serializable — it can live in a snapshot or ride along on the
 * event that created it), not a function, for the same reason Query is
 * data: it has to survive the event log and forking untouched.
 */

import type { EntityId } from "../core/id.ts";

export type ModifierOp = "add" | "multiply" | "set";

export interface Modifier {
  id: string;
  targetEntityId: EntityId;
  prop: string;
  op: ModifierOp;
  value: number;
  /**
   * Resolution order — lower priority resolves first. Not enforced by the
   * type system, just a convention worth keeping consistent across the
   * game's content: 0-99 additive, 100-199 multiplicative, 200+ overrides.
   * A "set" modifier at a low priority gets steamrolled by additive
   * modifiers resolving after it — that's usually not what you want, so
   * keep overrides late unless a specific effect calls for the opposite.
   */
  priority: number;
  /**
   * What created this modifier — a rule id, action id, or source entity
   * id (e.g. the aura granting it). Used for cleanup/expiry and debugging,
   * never read by resolution logic itself.
   */
  source: string;
}

export function newModifierId(): string {
  return crypto.randomUUID();
}

export function applyModifier(value: number, modifier: Modifier): number {
  switch (modifier.op) {
    case "add":
      return value + modifier.value;
    case "multiply":
      return value * modifier.value;
    case "set":
      return modifier.value;
  }
}
