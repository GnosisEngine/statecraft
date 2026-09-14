/**
 * Layer 5 — Rules-as-data: RuleBinding.
 *
 * A rule is: WHEN an event of type `trigger` fires, IF `match` (event
 * shape) and `condition` (world/entity state) both hold, RUN the effect
 * handler named `effect`. This is the same split as Layer 4's
 * ActionDefinition — engine-registered content, not itself event-log data
 * — with one deliberate addition specific to rules:
 *
 *   - `match` is a plain code predicate over the event's own fields (e.g.
 *     "only when actionId === 'shakedown'"). Events carry payload shapes
 *     that vary per trigger type (an action event has actionId/capability,
 *     an entity event has entityId/prop) — that's exactly what BoolExpr
 *     was NOT built to express (BoolExpr's ops read entity/world state, not
 *     arbitrary event payload fields), so this stays a small typed
 *     function rather than stretching BoolExpr to cover it.
 *
 *   - `condition` is a BoolExpr, same as everywhere else — but it needs
 *     an entity to evaluate against, and an event doesn't always name one
 *     obviously (which entity is "the subject" of an action:resolved that
 *     has both a performer and a list of targets?). `subject` extracts
 *     that one entity id; if a rule needs to gate per-target across a
 *     multi-target event, that's still a known gap — the effect handler
 *     itself gets the raw event and can iterate targetIds, but `condition`
 *     only gates on a single extracted subject for now.
 *
 * RuleBinding<T> is generic purely so match/subject get properly narrowed
 * event types at the call site where a binding is authored. RuleTable
 * type-erases to RuleBinding<GameEventType> internally, since a table
 * holds bindings for many different trigger types side by side — the
 * erasure is safe because RuleEngine only ever calls match/subject for
 * bindings whose `trigger` already matches the event actually being
 * dispatched (see rule-engine.ts).
 */

import type { EntityId } from "../core/id.ts";
import type { GameEvent, GameEventType } from "../events/types.ts";
import type { BoolExpr } from "../query/types.ts";

export interface RuleBinding<T extends GameEventType = GameEventType> {
  id: string;
  trigger: T;
  match?: (event: Extract<GameEvent, { type: T }>) => boolean;
  subject?: (event: Extract<GameEvent, { type: T }>) => EntityId | undefined;
  condition?: BoolExpr;
  /** Name of the handler registered in RuleHandlerRegistry (see rule-handler.ts). */
  effect: string;
  /** Resolution order among bindings sharing a trigger — lower fires first. */
  priority?: number;
}
