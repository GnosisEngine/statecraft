/**
 * Layer 1 — Query Engine: types.
 *
 * BoolExpr/NumExpr are data, not code or strings — no eval, no DSL
 * parser. A value of either type IS its own parsed form, which is what
 * makes them safely serializable into the event log, rule table, and
 * forked branches.
 *
 * This replaces the earlier Query/Aggregate split outright. That split
 * had a real, felt cost: Query (boolean) and Aggregate (number) could
 * only reference each other in the two directions someone had
 * explicitly wired up (Aggregate.where was always a Query; nothing let
 * a Query reference an Aggregate's result). Two content-level
 * workarounds for that gap were built independently before the split
 * was retired — see cyberfixer's content.ts history. BoolExpr and
 * NumExpr are mutually recursive instead: a NumExpr's `fold` case can
 * appear inside a BoolExpr's `compare`, and a fold's own `where`/`of`
 * can each contain the other type arbitrarily deep, because both are
 * evaluated by the SAME walk against an explicit, mutable notion of
 * "the current subject" (see interpreter.ts).
 *
 * EntityRef and labeled folds (`as`/`ref`) are what make correlated
 * aggregation expressible as data: `{ op: "fold", fold: "sum", as: "f",
 * where: <fixers>, of: { op: "fold", fold: "count", where: {
 * ownedBy: { op: "ref", label: "f" } } } }` reads as "for each fixer,
 * count what THEY own, then sum those counts" — the inner fold's
 * `where` reaching back to the outer fold's current match via its
 * label, not by depth-counting.
 *
 * The scoping rule, stated once here since interpreter.ts's evaluator
 * has to honor it exactly: a fold's `as` label is in scope for its own
 * `of` (there's a concrete matched entity by then), but NOT for its own
 * `where` (which is still deciding what counts as a match — referencing
 * the label there would be circular). A NESTED fold's `where` reaching
 * an ENCLOSING fold's label is the valid, intended case.
 *
 * `childOf`/`descendantOf` walk a named Hierarchy (Layer 2's
 * events/hierarchy.ts, resolved through HierarchyRegistry) — a separate,
 * additive tree structure, never a field on Entity, so an entity can
 * participate in several independent hierarchies without tracking which
 * ones itself. Deliberately NOT unified with `inZone`/`zoneId`: that
 * stays the engine-native mechanism Layer 9's visibility computation
 * reads, untouched.
 */

import type { EntityId } from "../core/id.ts";
import type { EntityKind } from "../core/entity.ts";
import type { DistanceMetric } from "../core/geometry.ts";

export type CompareOp = "gt" | "lt" | "gte" | "lte" | "eq";
export type AggregateOp = "sum" | "count" | "avg" | "min" | "max";

/** Either a literal id, or a reference to whatever entity a labeled fold currently has bound. Resolving a `ref` never changes what a subscriber needs to watch for (see extractBoolExprDependencies/extractNumExprDependencies) — only WHICH entity gets read, at evaluation time. */
export type EntityRef = EntityId | { op: "ref"; label: string };

export type NumExpr =
  | { op: "lit"; value: number }
  /** Reads a property. `subject` omitted means "whatever entity is currently ambient" — the fold this expression sits inside, or the top-level subject if it isn't inside one. */
  | { op: "prop"; name: string; subject?: EntityRef }
  | { op: "add" | "sub" | "mul" | "div"; left: NumExpr; right: NumExpr }
  /**
   * Folds `where` over every currently-matching entity, in turn binding
   * each one as `of`'s subject (and, if `as` is given, under that label
   * for anything nested inside `of` to reach via `ref`). `of` is
   * required for every op except "count", which ignores it.
   */
  | { op: "fold"; fold: AggregateOp; as?: string; of?: NumExpr; where: BoolExpr };

export type BoolExpr =
  | { op: "and" | "or"; exprs: BoolExpr[] }
  | { op: "not"; expr: BoolExpr }
  | { op: "hasTag"; tag: string; subject?: EntityRef }
  | { op: "kindIs"; kind: EntityKind; subject?: EntityRef }
  | { op: "inZone"; zoneId: EntityRef }
  | { op: "ownedBy"; fixerId: EntityRef }
  | { op: "withinDistance"; of: EntityRef; maxDistance: number; metric?: DistanceMetric }
  | { op: "call"; fn: string; args?: Record<string, unknown> }
  | { op: "compare"; left: NumExpr; right: NumExpr; cmp: CompareOp }
  /** `hierarchy` omitted -> the one registered hierarchy, if unambiguous (see HierarchyRegistry.resolve). */
  | { op: "childOf"; parent: EntityRef; hierarchy?: string }
  | { op: "descendantOf"; ancestor: EntityRef; hierarchy?: string; maxDepth?: number };

/**
 * A dependency key describes one "thing that, if it changes, means an
 * expression's result might change." Tags and properties are tracked by
 * name (precise); zone membership and ownership are tracked coarsely
 * (any change, anywhere) for now — precise enough to avoid recomputing
 * on unrelated events, without the complexity of tracking per-zone/
 * per-entity dependency sets before there's a proven need for that
 * granularity. This coarseness is also exactly why `ref` never needs
 * its own DepKey variant: a dependency key never named a specific
 * entity to begin with, so "which entity `ref` resolves to at runtime"
 * was never something the dependency system tracked. `hierarchy:${name}`
 * is coarse for the same underlying reason as `zone`/`owner`: which
 * entities are ancestors/descendants of what can change from a
 * parent-link mutation anywhere in that tree, not something worth
 * tracking more precisely without a proven need.
 */
export type DepKey = `tag:${string}` | `prop:${string}` | `hierarchy:${string}` | "zone" | "owner";
