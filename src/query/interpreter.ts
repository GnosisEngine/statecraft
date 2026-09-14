/**
 * Layer 1 — Query Engine: interpreter.
 *
 * Every BoolExpr/NumExpr node is evaluated against an explicit, mutable
 * notion of "the current subject" — a subjectId, plus a LabelScope
 * (label -> currently-bound entity id) for anything a labeled fold
 * (`as`) has bound so far. A bare `prop`/`hasTag`/`kindIs` with no
 * `subject` reads the ambient ones; `ref` resolves through the label
 * scope instead. This single mechanism is what lets BoolExpr and
 * NumExpr recurse into each other freely — see types.ts's header for
 * why that recursion was the actual point of unifying them.
 *
 * Three walks over the (now mutually recursive) grammar, kept
 * deliberately separate exactly as before:
 *
 *  - evaluateBoolExpr / evaluateNumExpr / selectEntities: DATA-DEPENDENT.
 *    Need real entities to produce a real answer.
 *
 *  - extractBoolExprDependencies / extractNumExprDependencies:
 *    STRUCTURAL. Needs no entities at all — reads the shape of the
 *    expression and reports what kinds of change could affect its
 *    result. Has to run once at registration time, before any relevant
 *    entity necessarily exists (an aggregate over zero current matches
 *    would otherwise report zero dependencies, which is wrong).
 *
 * Both evaluator switches enumerate the same op unions — see the
 * meta-test in query.test.ts (ALL_BOOL_EXPR_OPS / ALL_NUM_EXPR_OPS) that
 * fails loudly if one is extended without the other.
 */

import type { Entity } from "../core/entity.ts";
import { currentOwner } from "../core/entity.ts";
import type { EntityId } from "../core/id.ts";
import { distanceBetween, type BoardPoint } from "../core/geometry.ts";
import type { QueryFunction, QueryFunctionRegistry } from "./functions.ts";
import type { HierarchyRegistry, HierarchyResolution } from "./hierarchy-registry.ts";
import type { BoolExpr, DepKey, EntityRef, NumExpr } from "./types.ts";

export interface QueryContext {
  getAllEntities(): Iterable<Entity>;
  /** Fetches an arbitrary entity by id — needed once `ref` can point anywhere, not just at the ambient subject. */
  getEntity(entityId: EntityId): Entity | undefined;
  /**
   * Resolved property value for an entity. Layer 1 itself only knows
   * about base properties; Layer 3 (layered/computed properties)
   * supplies a context whose getProperty returns the fully-modified
   * live value. Falls back to the entity's raw base property if omitted.
   */
  getProperty(entityId: EntityId, prop: string): number | undefined;
  /** Resolves a `call` node's function by name. Optional — only contexts meant to support `call` need to implement it (see PropertyResolver). */
  getQueryFunction?(name: string): QueryFunction | undefined;
  /** Resolves a `childOf`/`descendantOf` node's hierarchy — see HierarchyRegistry.resolve for the omitted-name ambiguity rule. Optional — only contexts meant to support hierarchy queries need to implement it. */
  resolveHierarchy?(name?: string): HierarchyResolution;
}

/** label -> currently-bound entity id, for the fold(s) currently ambient. */
export type LabelScope = ReadonlyMap<string, EntityId>;
const EMPTY_LABELS: LabelScope = new Map();

function resolveEntityRef(ref: EntityRef, subjectId: EntityId, labels: LabelScope): EntityId {
  if (typeof ref === "string") return ref;
  const bound = labels.get(ref.label);
  if (bound === undefined) {
    throw new Error(`evaluate: ref to unbound label "${ref.label}" — nothing currently in scope bound it (no enclosing fold declares "as: \\"${ref.label}\\"", and no caller-provided label binding supplied one either).`);
  }
  return bound;
}

function readProp(entityId: EntityId, prop: string, ctx: QueryContext): number {
  const viaCtx = ctx.getProperty(entityId, prop);
  if (viaCtx !== undefined) return viaCtx;
  return ctx.getEntity(entityId)?.properties[prop] ?? 0;
}

/** x/y/z off an arbitrary entity id via ctx — used for withinDistance's two points. */
function pointOf(entityId: EntityId, ctx: QueryContext): BoardPoint {
  return {
    x: ctx.getProperty(entityId, "x") ?? 0,
    y: ctx.getProperty(entityId, "y") ?? 0,
    z: ctx.getProperty(entityId, "z"),
  };
}

export function evaluateNumExpr(expr: NumExpr, subjectId: EntityId, ctx: QueryContext, labels: LabelScope = EMPTY_LABELS): number {
  switch (expr.op) {
    case "lit":
      return expr.value;
    case "prop": {
      const targetId = expr.subject ? resolveEntityRef(expr.subject, subjectId, labels) : subjectId;
      return readProp(targetId, expr.name, ctx);
    }
    case "add":
      return evaluateNumExpr(expr.left, subjectId, ctx, labels) + evaluateNumExpr(expr.right, subjectId, ctx, labels);
    case "sub":
      return evaluateNumExpr(expr.left, subjectId, ctx, labels) - evaluateNumExpr(expr.right, subjectId, ctx, labels);
    case "mul":
      return evaluateNumExpr(expr.left, subjectId, ctx, labels) * evaluateNumExpr(expr.right, subjectId, ctx, labels);
    case "div":
      return evaluateNumExpr(expr.left, subjectId, ctx, labels) / evaluateNumExpr(expr.right, subjectId, ctx, labels);
    case "fold": {
      // `where` is evaluated per-candidate, each candidate as ITS OWN
      // subject — but still against the OUTER label scope (not this
      // fold's own `as`, which isn't bound yet: deciding matches can't
      // depend on a match that hasn't been picked).
      const matchIds: EntityId[] = [];
      for (const entity of ctx.getAllEntities()) {
        if (evaluateBoolExpr(expr.where, entity.id, ctx, labels)) matchIds.push(entity.id);
      }
      if (expr.fold === "count") return matchIds.length;
      if (!expr.of) throw new Error(`fold "${expr.fold}" requires "of"`);
      const of = expr.of;
      const values = matchIds.map((matchId) => {
        // `of` DOES see this fold's own `as` binding, merged over
        // whatever labels were already in scope — an enclosing fold's
        // label must stay reachable from inside a nested one.
        const innerLabels = expr.as ? new Map([...labels, [expr.as, matchId]]) : labels;
        return evaluateNumExpr(of, matchId, ctx, innerLabels);
      });
      switch (expr.fold) {
        case "sum":
          return values.reduce((a, b) => a + b, 0);
        case "avg":
          return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
        case "min":
          return values.length ? Math.min(...values) : 0;
        case "max":
          return values.length ? Math.max(...values) : 0;
      }
    }
  }
}

/** Shared by evaluateBoolExpr's childOf/descendantOf cases — resolves through ctx.resolveHierarchy, throwing with the registry's own reason (or a fallback if the context doesn't implement it at all) rather than silently treating every hierarchy check as false. */
function resolveHierarchyOrThrow(name: string | undefined, ctx: QueryContext, callerName: string) {
  const resolution = ctx.resolveHierarchy?.(name) ?? { ok: false as const, reason: "this QueryContext doesn't implement resolveHierarchy" };
  if (!resolution.ok) {
    throw new Error(`${callerName}: ${resolution.reason}`);
  }
  return resolution.hierarchy;
}

export function evaluateBoolExpr(expr: BoolExpr, subjectId: EntityId, ctx: QueryContext, labels: LabelScope = EMPTY_LABELS): boolean {
  switch (expr.op) {
    case "and":
      return expr.exprs.every((e) => evaluateBoolExpr(e, subjectId, ctx, labels));
    case "or":
      return expr.exprs.some((e) => evaluateBoolExpr(e, subjectId, ctx, labels));
    case "not":
      return !evaluateBoolExpr(expr.expr, subjectId, ctx, labels);
    case "hasTag": {
      const targetId = expr.subject ? resolveEntityRef(expr.subject, subjectId, labels) : subjectId;
      return ctx.getEntity(targetId)?.tags.has(expr.tag) ?? false;
    }
    case "kindIs": {
      const targetId = expr.subject ? resolveEntityRef(expr.subject, subjectId, labels) : subjectId;
      return ctx.getEntity(targetId)?.kind === expr.kind;
    }
    case "inZone": {
      const zoneId = resolveEntityRef(expr.zoneId, subjectId, labels);
      return ctx.getEntity(subjectId)?.zoneId === zoneId;
    }
    case "ownedBy": {
      const fixerId = resolveEntityRef(expr.fixerId, subjectId, labels);
      const entity = ctx.getEntity(subjectId);
      return entity !== undefined && currentOwner(entity) === fixerId;
    }
    case "withinDistance": {
      const otherId = resolveEntityRef(expr.of, subjectId, labels);
      return distanceBetween(pointOf(subjectId, ctx), pointOf(otherId, ctx), expr.metric ?? "chebyshev") <= expr.maxDistance;
    }
    case "call": {
      const fn = ctx.getQueryFunction?.(expr.fn);
      if (!fn) {
        throw new Error(
          `evaluateBoolExpr: no query function registered for "${expr.fn}" — this QueryContext doesn't implement getQueryFunction, or the function was never registered.`,
        );
      }
      return fn.evaluate(subjectId, ctx, expr.args);
    }
    case "childOf": {
      const hierarchy = resolveHierarchyOrThrow(expr.hierarchy, ctx, "evaluateBoolExpr");
      const parentId = resolveEntityRef(expr.parent, subjectId, labels);
      return hierarchy.getParent(subjectId) === parentId;
    }
    case "descendantOf": {
      const hierarchy = resolveHierarchyOrThrow(expr.hierarchy, ctx, "evaluateBoolExpr");
      const ancestorId = resolveEntityRef(expr.ancestor, subjectId, labels);
      return hierarchy.isDescendantOf(subjectId, ancestorId, expr.maxDepth);
    }
    case "compare": {
      const left = evaluateNumExpr(expr.left, subjectId, ctx, labels);
      const right = evaluateNumExpr(expr.right, subjectId, ctx, labels);
      switch (expr.cmp) {
        case "gt":
          return left > right;
        case "lt":
          return left < right;
        case "gte":
          return left >= right;
        case "lte":
          return left <= right;
        case "eq":
          return left === right;
      }
    }
  }
}

/** Returns every entity in ctx matching the given BoolExpr, each evaluated as its own subject. */
export function selectEntities(where: BoolExpr, ctx: QueryContext, labels: LabelScope = EMPTY_LABELS): Entity[] {
  const out: Entity[] = [];
  for (const e of ctx.getAllEntities()) {
    if (evaluateBoolExpr(where, e.id, ctx, labels)) out.push(e);
  }
  return out;
}

function checkRefScope(ref: EntityRef | undefined, labelsInScope: ReadonlySet<string>): void {
  if (ref !== undefined && typeof ref !== "string" && !labelsInScope.has(ref.label)) {
    throw new Error(
      `extractDependencies: ref to unbound label "${ref.label}" — no enclosing fold declares "as: \\"${ref.label}\\"".`,
    );
  }
}

/** Structural dependency walk for a BoolExpr. See file header. `labelsInScope` tracks which `as` labels a ref here is allowed to reach — validated eagerly, same discipline as `call`'s registry lookup. `hierarchies` is only needed if the expression contains `childOf`/`descendantOf` — same optional-until-needed pattern as `queryFunctions`. */
export function extractBoolExprDependencies(
  expr: BoolExpr,
  deps: Set<DepKey> = new Set(),
  queryFunctions?: QueryFunctionRegistry,
  labelsInScope: ReadonlySet<string> = new Set(),
  hierarchies?: HierarchyRegistry,
): Set<DepKey> {
  switch (expr.op) {
    case "and":
    case "or":
      for (const e of expr.exprs) extractBoolExprDependencies(e, deps, queryFunctions, labelsInScope, hierarchies);
      return deps;
    case "not":
      extractBoolExprDependencies(expr.expr, deps, queryFunctions, labelsInScope, hierarchies);
      return deps;
    case "hasTag":
      deps.add(`tag:${expr.tag}`);
      checkRefScope(expr.subject, labelsInScope);
      return deps;
    case "kindIs":
      checkRefScope(expr.subject, labelsInScope);
      return deps;
    case "inZone":
      deps.add("zone");
      checkRefScope(expr.zoneId, labelsInScope);
      return deps;
    case "ownedBy":
      deps.add("owner");
      checkRefScope(expr.fixerId, labelsInScope);
      return deps;
    case "withinDistance":
      deps.add("prop:x");
      deps.add("prop:y");
      deps.add("prop:z");
      checkRefScope(expr.of, labelsInScope);
      return deps;
    case "call": {
      const fn = queryFunctions?.get(expr.fn);
      if (!fn) {
        throw new Error(
          `extractBoolExprDependencies: query function "${expr.fn}" not found — pass the QueryFunctionRegistry that contains it, or dependent subscriptions will silently miss real changes.`,
        );
      }
      for (const d of fn.dependencies(expr.args)) deps.add(d);
      return deps;
    }
    case "compare":
      extractNumExprDependencies(expr.left, deps, queryFunctions, labelsInScope, hierarchies);
      extractNumExprDependencies(expr.right, deps, queryFunctions, labelsInScope, hierarchies);
      return deps;
    case "childOf": {
      const resolution = hierarchies?.resolve(expr.hierarchy) ?? { ok: false as const, reason: "no HierarchyRegistry was passed to extractBoolExprDependencies" };
      if (!resolution.ok) throw new Error(`extractBoolExprDependencies: ${resolution.reason}`);
      deps.add(`hierarchy:${resolution.hierarchy.name}`);
      checkRefScope(expr.parent, labelsInScope);
      return deps;
    }
    case "descendantOf": {
      const resolution = hierarchies?.resolve(expr.hierarchy) ?? { ok: false as const, reason: "no HierarchyRegistry was passed to extractBoolExprDependencies" };
      if (!resolution.ok) throw new Error(`extractBoolExprDependencies: ${resolution.reason}`);
      deps.add(`hierarchy:${resolution.hierarchy.name}`);
      checkRefScope(expr.ancestor, labelsInScope);
      return deps;
    }
  }
}

/** Structural dependency walk for a NumExpr. See file header and extractBoolExprDependencies. */
export function extractNumExprDependencies(
  expr: NumExpr,
  deps: Set<DepKey> = new Set(),
  queryFunctions?: QueryFunctionRegistry,
  labelsInScope: ReadonlySet<string> = new Set(),
  hierarchies?: HierarchyRegistry,
): Set<DepKey> {
  switch (expr.op) {
    case "lit":
      return deps;
    case "prop":
      deps.add(`prop:${expr.name}`);
      checkRefScope(expr.subject, labelsInScope);
      return deps;
    case "add":
    case "sub":
    case "mul":
    case "div":
      extractNumExprDependencies(expr.left, deps, queryFunctions, labelsInScope, hierarchies);
      extractNumExprDependencies(expr.right, deps, queryFunctions, labelsInScope, hierarchies);
      return deps;
    case "fold": {
      // where does NOT get this fold's own `as` — not bound yet (same rule as evaluation).
      extractBoolExprDependencies(expr.where, deps, queryFunctions, labelsInScope, hierarchies);
      if (expr.of) {
        const innerScope = expr.as ? new Set([...labelsInScope, expr.as]) : labelsInScope;
        extractNumExprDependencies(expr.of, deps, queryFunctions, innerScope, hierarchies);
      }
      return deps;
    }
  }
}

/** All BoolExpr["op"] literals — used by the meta-test to catch switch-drift. */
export const ALL_BOOL_EXPR_OPS = [
  "and",
  "or",
  "not",
  "hasTag",
  "kindIs",
  "inZone",
  "ownedBy",
  "withinDistance",
  "call",
  "compare",
  "childOf",
  "descendantOf",
] as const satisfies readonly BoolExpr["op"][];

/** All NumExpr["op"] literals — used by the meta-test to catch switch-drift. */
export const ALL_NUM_EXPR_OPS = ["lit", "prop", "add", "sub", "mul", "div", "fold"] as const satisfies readonly NumExpr["op"][];
