/**
 * Layer 5 — registerRule.
 *
 * RuleBinding<T> is already generic specifically so `match`/`subject` get
 * a properly narrowed event type at the call site where a binding is
 * authored (see rule-binding.ts's own header) — RuleTable.add<T> then
 * type-erases to RuleBinding<GameEventType> internally, with exactly ONE
 * documented cast, because a table holds bindings for many different
 * trigger types side by side.
 *
 * The effect HANDLER never got that same treatment. RuleHandlerRegistry
 * is a separate, name-keyed Map<string, RuleHandler>, where
 * RuleHandler = (event: GameEvent, api) => void — the full, unnarrowed
 * union, because handlers are resolved by string name at runtime,
 * disconnected from the typed RuleBinding<T> that registered them. The
 * result, before this function existed: every content-level rule
 * handler had to manually write `event as Extract<typeof event, {type:
 * "..."}>` — eleven separate, unchecked type assertions in
 * games/cyberfixer/server/content.ts alone, each one a chance for a
 * copy-paste mistake (the wrong event type in the cast) to compile
 * clean and be silently wrong at runtime.
 *
 * registerRule pairs a binding and its handler in one call, pushing the
 * one necessary erasure into this single function — the exact same
 * shape and the exact same justification as RuleTable.add's own comment
 * makes for its own cast: safe because RuleEngine only ever invokes a
 * binding's effect handler for events whose type already equals that
 * binding's own trigger. Every caller of THIS function writes zero
 * casts, ever — the event parameter arrives already narrowed to
 * Extract<GameEvent, {type: T}>, enforced by the type system, not by
 * author discipline.
 *
 * The effect name is generated automatically (`${binding.id}-effect`)
 * and never exposed to the caller — one less manual naming convention
 * to keep in sync by hand.
 */

import type { ActionApi } from "../actions/effect-handler.ts";
import type { GameEvent, GameEventType } from "../events/types.ts";
import type { RuleBinding } from "./rule-binding.ts";
import type { RuleHandler, RuleHandlerRegistry } from "./rule-handler.ts";
import type { RuleTable } from "./rule-table.ts";

export function registerRule<T extends GameEventType>(
  ruleTable: RuleTable,
  ruleHandlers: RuleHandlerRegistry,
  binding: Omit<RuleBinding<T>, "effect">,
  handler: (event: Extract<GameEvent, { type: T }>, api: ActionApi) => void,
): void {
  const effect = `${binding.id}-effect`;
  ruleTable.add<T>({ ...binding, effect });
  // The one, documented erasure point — see this file's own header for
  // why it's safe. `as RuleHandler` erases the narrowed parameter type
  // back to GameEvent; correctness rests entirely on RuleEngine only
  // ever calling this handler when the live event's own type already
  // equals `binding.trigger`, which is exactly RuleTable.add's own
  // stated invariant, reused here rather than re-argued.
  ruleHandlers.register(effect, handler as RuleHandler);
}
