/**
 * Layer 1 — Query Engine: functions (the `call` op's registry).
 *
 * BoolExpr/NumExpr stay pure data on purpose — no arithmetic between
 * arbitrary properties beyond add/sub/mul/div, no computation. `call`
 * is the deliberate escape hatch for the rare case that genuinely needs
 * real code (e.g. "has this card been in the discard pile for at least
 * N turns", which needs a comparison against a value derived from
 * something the grammar can't express directly). Same shape as
 * ActionDefinition.effect and RuleBinding.match: the expression tree
 * stays data (a function NAME plus plain-data args), the actual logic
 * is code, resolved through a registry.
 *
 * The one thing a `call` node can't get for free that every other op
 * can: extractBoolExprDependencies is a purely STRUCTURAL walk (see
 * interpreter.ts's header) that has to work without ever running the
 * expression. A named function is opaque to that walk on its own —
 * nothing about the string "hasBeenDiscardedForXTurns" reveals it reads
 * `discardedAt` and a turn counter. So a QueryFunction isn't just a
 * predicate, it's a predicate PLUS its own declared dependencies — the
 * same discipline RuleBinding.subject/condition authors already have to
 * apply, just at the function-registration boundary instead.
 */

import type { EntityId } from "../core/id.ts";
import type { QueryContext } from "./interpreter.ts";
import type { DepKey } from "./types.ts";

export interface QueryFunction {
  /** subjectId, not an Entity object — fetch it yourself via ctx.getEntity if you need tags/kind, same as everything else in the interpreter. */
  evaluate(subjectId: EntityId, ctx: QueryContext, args?: Record<string, unknown>): boolean;
  /** What this function reads, given the same args it'll be called with — must stay accurate, or subscriptions using it silently miss real changes. */
  dependencies(args?: Record<string, unknown>): DepKey[];
}

export class QueryFunctionRegistry {
  private functions = new Map<string, QueryFunction>();

  register(name: string, fn: QueryFunction): void {
    this.functions.set(name, fn);
  }

  get(name: string): QueryFunction | undefined {
    return this.functions.get(name);
  }
}
