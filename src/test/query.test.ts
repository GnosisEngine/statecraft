import { describe, expect, it } from "vitest";
import { createCard, createZone, transferOwnership, type Entity } from "../core/entity.ts";
import {
  ALL_BOOL_EXPR_OPS,
  ALL_NUM_EXPR_OPS,
  evaluateBoolExpr,
  evaluateNumExpr,
  extractBoolExprDependencies,
  extractNumExprDependencies,
  selectEntities,
  type QueryContext,
} from "../query/interpreter.ts";
import { QueryFunctionRegistry } from "../query/functions.ts";
import { HierarchyRegistry } from "../query/hierarchy-registry.ts";
import { Hierarchy } from "../events/hierarchy.ts";
import { EventBus } from "../events/bus.ts";
import type { BoolExpr, NumExpr } from "../query/types.ts";

function makeCtx(entities: Entity[], queryFunctions?: QueryFunctionRegistry, hierarchies?: HierarchyRegistry): QueryContext {
  return {
    getAllEntities: () => entities,
    getEntity: (id) => entities.find((e) => e.id === id),
    getProperty: (id, prop) => entities.find((e) => e.id === id)?.properties[prop],
    getQueryFunction: queryFunctions ? (name) => queryFunctions.get(name) : undefined,
    resolveHierarchy: hierarchies ? (name) => hierarchies.resolve(name) : undefined,
  };
}

describe("BoolExpr basics", () => {
  it("hasTag / not / and / or", () => {
    const card = createCard("Razor");
    card.tags.add("shaken");
    const ctx = makeCtx([card]);

    expect(evaluateBoolExpr({ op: "hasTag", tag: "shaken" }, card.id, ctx)).toBe(true);
    expect(evaluateBoolExpr({ op: "not", expr: { op: "hasTag", tag: "shaken" } }, card.id, ctx)).toBe(false);
    expect(evaluateBoolExpr({ op: "and", exprs: [{ op: "hasTag", tag: "shaken" }, { op: "hasTag", tag: "nope" }] }, card.id, ctx)).toBe(false);
    expect(evaluateBoolExpr({ op: "or", exprs: [{ op: "hasTag", tag: "shaken" }, { op: "hasTag", tag: "nope" }] }, card.id, ctx)).toBe(true);
    // "and" with an empty list is vacuously true — this is what ALWAYS_TRUE_QUERY relies on
    expect(evaluateBoolExpr({ op: "and", exprs: [] }, card.id, ctx)).toBe(true);
  });

  it("kindIs matches an entity's own kind", () => {
    const card = createCard("Razor");
    const zone = createZone();
    const ctx = makeCtx([card, zone]);
    expect(evaluateBoolExpr({ op: "kindIs", kind: "card" }, card.id, ctx)).toBe(true);
    expect(evaluateBoolExpr({ op: "kindIs", kind: "card" }, zone.id, ctx)).toBe(false);
  });

  it("inZone matches on current zoneId", () => {
    const zone = createZone();
    const card = createCard("Razor", { zoneId: zone.id });
    const ctx = makeCtx([zone, card]);
    expect(evaluateBoolExpr({ op: "inZone", zoneId: zone.id }, card.id, ctx)).toBe(true);
    expect(evaluateBoolExpr({ op: "inZone", zoneId: "some-other-zone" }, card.id, ctx)).toBe(false);
  });

  it("ownedBy checks the top of the ownership stack", () => {
    const card = createCard("Razor", { ownership: ["fixer-A"] });
    const ctx = makeCtx([card]);
    expect(evaluateBoolExpr({ op: "ownedBy", fixerId: "fixer-A" }, card.id, ctx)).toBe(true);
    expect(evaluateBoolExpr({ op: "ownedBy", fixerId: "fixer-B" }, card.id, ctx)).toBe(false);
  });

  it("withinDistance compares one entity's x/y against another's, by id, via ctx", () => {
    const piece = createCard("Rook", { id: "piece-1", properties: { x: 0, y: 0 } });
    const enemy = createCard("Bishop", { id: "enemy-1", properties: { x: 1, y: 1 } });
    const ctx = makeCtx([piece, enemy]);

    expect(evaluateBoolExpr({ op: "withinDistance", of: "enemy-1", maxDistance: 1 }, piece.id, ctx)).toBe(true); // chebyshev default
    expect(
      evaluateBoolExpr({ op: "withinDistance", of: "enemy-1", maxDistance: 1, metric: "manhattan" }, piece.id, ctx),
    ).toBe(false); // manhattan distance is 2, out of range
  });

  it("compare evaluates both sides as full NumExprs, not just a bare property vs. a literal", () => {
    const card = createCard("Razor", { properties: { power: 10, threshold: 7 } });
    const ctx = makeCtx([card]);
    // property vs literal (the common case)
    expect(evaluateBoolExpr({ op: "compare", left: { op: "prop", name: "power" }, cmp: "gt", right: { op: "lit", value: 5 } }, card.id, ctx)).toBe(true);
    // property vs property — this is new: compare's right side couldn't do this before
    expect(evaluateBoolExpr({ op: "compare", left: { op: "prop", name: "power" }, cmp: "gt", right: { op: "prop", name: "threshold" } }, card.id, ctx)).toBe(true);
  });

  it("call resolves a registered function and passes it the subjectId, ctx, and args", () => {
    const registry = new QueryFunctionRegistry();
    registry.register("isBigProp", {
      evaluate: (subjectId, ctx, args) => (ctx.getProperty(subjectId, args?.prop as string) ?? 0) > (args?.than as number),
      dependencies: (args) => [`prop:${args?.prop as string}`],
    });
    const card = createCard("Razor", { properties: { power: 10 } });
    const ctx = makeCtx([card], registry);

    expect(evaluateBoolExpr({ op: "call", fn: "isBigProp", args: { prop: "power", than: 5 } }, card.id, ctx)).toBe(true);
    expect(evaluateBoolExpr({ op: "call", fn: "isBigProp", args: { prop: "power", than: 50 } }, card.id, ctx)).toBe(false);
  });

  it("call throws a clear error for an unregistered function name", () => {
    const card = createCard("Razor");
    const ctx = makeCtx([card], new QueryFunctionRegistry());
    expect(() => evaluateBoolExpr({ op: "call", fn: "nope" }, card.id, ctx)).toThrow(/no query function registered/);
  });

  it("call throws a clear error when the context doesn't implement getQueryFunction at all", () => {
    const card = createCard("Razor");
    const bareCtx: QueryContext = { getAllEntities: () => [card], getEntity: (id) => (id === card.id ? card : undefined), getProperty: () => undefined };
    expect(() => evaluateBoolExpr({ op: "call", fn: "anything" }, card.id, bareCtx)).toThrow(/no query function registered/);
  });
});

describe("NumExpr basics", () => {
  it("lit / prop / add / sub / mul / div", () => {
    const card = createCard("Razor", { properties: { power: 10, cost: 4 } });
    const ctx = makeCtx([card]);
    expect(evaluateNumExpr({ op: "lit", value: 7 }, card.id, ctx)).toBe(7);
    expect(evaluateNumExpr({ op: "prop", name: "power" }, card.id, ctx)).toBe(10);
    expect(evaluateNumExpr({ op: "add", left: { op: "prop", name: "power" }, right: { op: "prop", name: "cost" } }, card.id, ctx)).toBe(14);
    expect(evaluateNumExpr({ op: "sub", left: { op: "prop", name: "power" }, right: { op: "prop", name: "cost" } }, card.id, ctx)).toBe(6);
    expect(evaluateNumExpr({ op: "mul", left: { op: "prop", name: "cost" }, right: { op: "lit", value: 3 } }, card.id, ctx)).toBe(12);
    expect(evaluateNumExpr({ op: "div", left: { op: "prop", name: "power" }, right: { op: "lit", value: 2 } }, card.id, ctx)).toBe(5);
  });

  it("prop falls back to the entity's raw base property when ctx.getProperty returns undefined", () => {
    const card = createCard("Razor", { properties: { power: 10 } });
    const bareCtx: QueryContext = {
      getAllEntities: () => [card],
      getEntity: (id) => (id === card.id ? card : undefined),
      getProperty: () => undefined, // simulates a ctx with no resolved-value layer, e.g. raw EntityStore
    };
    expect(evaluateNumExpr({ op: "prop", name: "power" }, card.id, bareCtx)).toBe(10);
  });

  it("prop with an explicit subject reads off a DIFFERENT entity than the ambient one", () => {
    const a = createCard("A", { id: "a", properties: { power: 3 } });
    const b = createCard("B", { id: "b", properties: { power: 9 } });
    const ctx = makeCtx([a, b]);
    // ambient subject is "a", but this reads "b"'s power instead
    expect(evaluateNumExpr({ op: "prop", name: "power", subject: "b" }, a.id, ctx)).toBe(9);
  });

  it("fold sum/count/avg/min/max over every currently-matching entity", () => {
    const board = createZone();
    const cards = [3, 5, 7].map((power, i) => createCard(`C${i}`, { zoneId: board.id, properties: { power } }));
    const ctx = makeCtx([board, ...cards]);
    const where: BoolExpr = { op: "inZone", zoneId: board.id };

    expect(evaluateNumExpr({ op: "fold", fold: "sum", of: { op: "prop", name: "power" }, where }, board.id, ctx)).toBe(15);
    expect(evaluateNumExpr({ op: "fold", fold: "count", where }, board.id, ctx)).toBe(3);
    expect(evaluateNumExpr({ op: "fold", fold: "avg", of: { op: "prop", name: "power" }, where }, board.id, ctx)).toBe(5);
    expect(evaluateNumExpr({ op: "fold", fold: "min", of: { op: "prop", name: "power" }, where }, board.id, ctx)).toBe(3);
    expect(evaluateNumExpr({ op: "fold", fold: "max", of: { op: "prop", name: "power" }, where }, board.id, ctx)).toBe(7);
  });

  it("count ignores `of` entirely — doesn't need it, doesn't evaluate it", () => {
    const board = createZone();
    const card = createCard("C", { zoneId: board.id });
    const ctx = makeCtx([board, card]);
    expect(evaluateNumExpr({ op: "fold", fold: "count", where: { op: "inZone", zoneId: board.id } }, board.id, ctx)).toBe(1);
  });

  it("sum/avg/min/max throw a clear error without `of`", () => {
    const ctx = makeCtx([]);
    const bad = { op: "fold", fold: "sum", where: { op: "and", exprs: [] } } as unknown as NumExpr;
    expect(() => evaluateNumExpr(bad, "x", ctx)).toThrow(/requires "of"/);
  });

  it("fold on zero matches: sum/count are 0, avg/min/max are also 0 (not NaN/-Infinity)", () => {
    const ctx = makeCtx([]);
    const where: BoolExpr = { op: "hasTag", tag: "nonexistent" };
    expect(evaluateNumExpr({ op: "fold", fold: "sum", of: { op: "lit", value: 1 }, where }, "x", ctx)).toBe(0);
    expect(evaluateNumExpr({ op: "fold", fold: "count", where }, "x", ctx)).toBe(0);
    expect(evaluateNumExpr({ op: "fold", fold: "avg", of: { op: "lit", value: 1 }, where }, "x", ctx)).toBe(0);
    expect(evaluateNumExpr({ op: "fold", fold: "min", of: { op: "lit", value: 1 }, where }, "x", ctx)).toBe(0);
    expect(evaluateNumExpr({ op: "fold", fold: "max", of: { op: "lit", value: 1 }, where }, "x", ctx)).toBe(0);
  });
});

describe("the four recursion combinations", () => {
  it("BoolExpr within BoolExpr — and/or/not nesting to arbitrary depth", () => {
    const card = createCard("Razor");
    card.tags.add("a");
    card.tags.add("b");
    const ctx = makeCtx([card]);
    // (a AND b) OR (NOT c)
    const expr: BoolExpr = {
      op: "or",
      exprs: [{ op: "and", exprs: [{ op: "hasTag", tag: "a" }, { op: "hasTag", tag: "b" }] }, { op: "not", expr: { op: "hasTag", tag: "c" } }],
    };
    expect(evaluateBoolExpr(expr, card.id, ctx)).toBe(true);
  });

  it("BoolExpr within NumExpr — a fold's `where` is always a BoolExpr, arbitrarily complex", () => {
    const board = createZone();
    const good = createCard("Good", { zoneId: board.id, properties: { power: 5 } });
    good.tags.add("contractor");
    const bad = createCard("Bad", { zoneId: board.id, properties: { power: 99 } });
    const ctx = makeCtx([board, good, bad]);

    const total = evaluateNumExpr(
      {
        op: "fold",
        fold: "sum",
        of: { op: "prop", name: "power" },
        where: { op: "and", exprs: [{ op: "inZone", zoneId: board.id }, { op: "hasTag", tag: "contractor" }] },
      },
      board.id,
      ctx,
    );
    expect(total).toBe(5); // "bad" excluded — not tagged contractor
  });

  it("NumExpr within BoolExpr — compare's operands can be a fold, not just a literal", () => {
    const board = createZone();
    const cards = [3, 4].map((power, i) => createCard(`C${i}`, { zoneId: board.id, properties: { power } }));
    const ctx = makeCtx([board, ...cards]);

    const expr: BoolExpr = {
      op: "compare",
      left: { op: "fold", fold: "sum", of: { op: "prop", name: "power" }, where: { op: "inZone", zoneId: board.id } },
      cmp: "gt",
      right: { op: "lit", value: 5 },
    };
    expect(evaluateBoolExpr(expr, board.id, ctx)).toBe(true); // 3+4=7 > 5
  });

  it("NumExpr within NumExpr, correlated via a labeled fold — the SUM(COUNT(...)) case", () => {
    // Two fixers. fixer-A owns 2 contractors, fixer-B owns 1. Expect:
    // "for each fixer, count what THEY own, then sum those counts" == 3.
    const fixerA = createCard("fixer-A", { id: "fixer-A" });
    fixerA.tags.add("fixer");
    const fixerB = createCard("fixer-B", { id: "fixer-B" });
    fixerB.tags.add("fixer");
    const c1 = createCard("c1", { ownership: ["fixer-A"] });
    const c2 = createCard("c2", { ownership: ["fixer-A"] });
    const c3 = createCard("c3", { ownership: ["fixer-B"] });
    c1.tags.add("contractor");
    c2.tags.add("contractor");
    c3.tags.add("contractor");
    const ctx = makeCtx([fixerA, fixerB, c1, c2, c3]);

    const expr: NumExpr = {
      op: "fold",
      fold: "sum",
      as: "f",
      where: { op: "hasTag", tag: "fixer" },
      of: {
        op: "fold",
        fold: "count",
        where: { op: "and", exprs: [{ op: "hasTag", tag: "contractor" }, { op: "ownedBy", fixerId: { op: "ref", label: "f" } }] },
      },
    };
    expect(evaluateNumExpr(expr, "irrelevant", ctx)).toBe(3);
  });

  it("a nested fold's `where` can reach an enclosing fold's label, but the fold's OWN where cannot reach its OWN label (not bound yet)", () => {
    const fixerA = createCard("fixer-A", { id: "fixer-A" });
    fixerA.tags.add("fixer");
    const ctx = makeCtx([fixerA]);

    // A fold whose OWN where references its OWN as-label — circular, must throw.
    const circular: NumExpr = {
      op: "fold",
      fold: "count",
      as: "f",
      where: { op: "ownedBy", fixerId: { op: "ref", label: "f" } },
    };
    expect(() => evaluateNumExpr(circular, "irrelevant", ctx)).toThrow(/unbound label "f"/);
  });

  it("shadowing: a nested fold reusing an outer label's name shadows it, only within its own `of`", () => {
    // outer fold binds "f" to each of two zones; inner fold ALSO uses "f",
    // binding it to each card in the (outer) zone — inner's `of` should see
    // the INNER "f" (a card), not the outer one (a zone).
    const zoneA = createZone({}, { id: "zone-a" });
    const zoneB = createZone({}, { id: "zone-b" });
    const cardInA = createCard("in-a", { zoneId: "zone-a", properties: { power: 10 } });
    const ctx = makeCtx([zoneA, zoneB, cardInA]);

    const expr: NumExpr = {
      op: "fold",
      fold: "sum",
      as: "f", // outer: f = a zone
      where: { op: "kindIs", kind: "zone" },
      of: {
        op: "fold",
        fold: "sum",
        as: "f", // inner: shadows outer f with a card
        where: { op: "inZone", zoneId: { op: "ref", label: "f" } }, // reaches OUTER f (a zone id) — correct, not yet shadowed
        of: { op: "prop", name: "power", subject: { op: "ref", label: "f" } }, // reaches INNER f (a card) — shadowed
      },
    };
    // zone-a's inner fold: 1 matching card (cardInA), power 10. zone-b's inner fold: 0 matches, sum 0.
    expect(evaluateNumExpr(expr, "irrelevant", ctx)).toBe(10);
  });

  it("ref to a genuinely unbound label throws a clear error rather than silently resolving", () => {
    const card = createCard("Razor");
    const ctx = makeCtx([card]);
    expect(() => evaluateBoolExpr({ op: "ownedBy", fixerId: { op: "ref", label: "nope" } }, card.id, ctx)).toThrow(/unbound label "nope"/);
  });
});

describe("childOf / descendantOf: hierarchy-aware queries", () => {
  it("childOf checks direct parentage in the named hierarchy", () => {
    const bus = new EventBus();
    const board = new Hierarchy("board", bus);
    board.setParent("card-1", "zone-1");
    const registry = new HierarchyRegistry();
    registry.register(board);
    const ctx = makeCtx([createCard("X", { id: "card-1" })], undefined, registry);

    expect(evaluateBoolExpr({ op: "childOf", parent: "zone-1", hierarchy: "board" }, "card-1", ctx)).toBe(true);
    expect(evaluateBoolExpr({ op: "childOf", parent: "some-other-zone", hierarchy: "board" }, "card-1", ctx)).toBe(false);
  });

  it("descendantOf reaches arbitrarily deep, not just direct parentage", () => {
    const bus = new EventBus();
    const board = new Hierarchy("board", bus);
    board.setParent("grandchild", "child");
    board.setParent("child", "root");
    const registry = new HierarchyRegistry();
    registry.register(board);
    const ctx = makeCtx([createCard("X", { id: "grandchild" })], undefined, registry);

    expect(evaluateBoolExpr({ op: "descendantOf", ancestor: "root", hierarchy: "board" }, "grandchild", ctx)).toBe(true);
    expect(evaluateBoolExpr({ op: "childOf", parent: "root", hierarchy: "board" }, "grandchild", ctx)).toBe(false); // NOT a direct child
  });

  it("omitting hierarchy resolves to the one registered hierarchy; naming a second makes it ambiguous", () => {
    const bus = new EventBus();
    const board = new Hierarchy("board", bus);
    board.setParent("card-1", "zone-1");
    const registry = new HierarchyRegistry();
    registry.register(board);
    const ctx = makeCtx([createCard("X", { id: "card-1" })], undefined, registry);

    expect(evaluateBoolExpr({ op: "childOf", parent: "zone-1" }, "card-1", ctx)).toBe(true); // no hierarchy named — fine, only one exists

    registry.register(new Hierarchy("squad", bus));
    expect(() => evaluateBoolExpr({ op: "childOf", parent: "zone-1" }, "card-1", ctx)).toThrow(/hierarchy name required/);
  });

  it("throws when the QueryContext doesn't implement resolveHierarchy at all", () => {
    const bareCtx: QueryContext = { getAllEntities: () => [], getEntity: () => undefined, getProperty: () => undefined };
    expect(() => evaluateBoolExpr({ op: "childOf", parent: "x" }, "card-1", bareCtx)).toThrow(/doesn't implement resolveHierarchy/);
  });

  it("ref scoping applies to childOf/descendantOf's own entity-ref fields too", () => {
    const bus = new EventBus();
    const registry = new HierarchyRegistry();
    registry.register(new Hierarchy("board", bus));
    const ctx = makeCtx([createCard("X", { id: "card-1" })], undefined, registry);
    expect(() => evaluateBoolExpr({ op: "childOf", parent: { op: "ref", label: "unbound" } }, "card-1", ctx)).toThrow(/unbound label "unbound"/);
  });

  it("dependency extraction reports a coarse hierarchy:<name> DepKey, and throws on an unresolvable name — structurally, no entities needed", () => {
    const bus = new EventBus();
    const registry = new HierarchyRegistry();
    registry.register(new Hierarchy("squad", bus));

    expect(extractBoolExprDependencies({ op: "childOf", parent: "x", hierarchy: "squad" }, undefined, undefined, undefined, registry)).toEqual(
      new Set(["hierarchy:squad"]),
    );
    expect(() => extractBoolExprDependencies({ op: "descendantOf", ancestor: "x", hierarchy: "nope" }, undefined, undefined, undefined, registry)).toThrow(
      /no hierarchy registered for "nope"/,
    );
    expect(() => extractBoolExprDependencies({ op: "childOf", parent: "x" })).toThrow(/no HierarchyRegistry was passed/);
  });

  it("descendantOf composes with fold's existing machinery for hierarchy-aware aggregation — no new fold variant needed", () => {
    // "sum of power across every descendant of root-1" — the recursion lives
    // entirely inside descendantOf's own predicate; fold just iterates and
    // tests each candidate with it, exactly like any other where-clause.
    const bus = new EventBus();
    const squad = new Hierarchy("squad", bus);
    squad.setParent("unit-a", "root-1");
    squad.setParent("unit-b", "unit-a"); // grandchild of root-1
    squad.setParent("unrelated", "some-other-root");
    const registry = new HierarchyRegistry();
    registry.register(squad);

    const entities = [
      createCard("A", { id: "unit-a", properties: { power: 3 } }),
      createCard("B", { id: "unit-b", properties: { power: 4 } }),
      createCard("C", { id: "unrelated", properties: { power: 99 } }),
    ];
    const ctx = makeCtx(entities, undefined, registry);

    const total = evaluateNumExpr(
      { op: "fold", fold: "sum", of: { op: "prop", name: "power" }, where: { op: "descendantOf", ancestor: "root-1" } },
      "irrelevant",
      ctx,
    );
    expect(total).toBe(7); // unit-a (3) + unit-b (4), grandchild included; unrelated excluded
  });
});

describe("selectEntities", () => {
  it("returns every entity matching a BoolExpr", () => {
    const board = createZone();
    const a = createCard("A", { zoneId: board.id });
    const b = createCard("B");
    const ctx = makeCtx([board, a, b]);
    const matches = selectEntities({ op: "inZone", zoneId: board.id }, ctx);
    expect(matches.map((e) => e.id)).toEqual([a.id]);
  });
});

describe("ownership stack integration (sanity — not a Layer 1 concern, but ownedBy relies on it)", () => {
  it("ownedBy tracks the CURRENT top of the ownership stack after a transfer", () => {
    let card = createCard("Razor", { ownership: ["fixer-A"] });
    card = { ...card, ownership: transferOwnership(card, "fixer-B") };
    const ctx = makeCtx([card]);
    expect(evaluateBoolExpr({ op: "ownedBy", fixerId: "fixer-B" }, card.id, ctx)).toBe(true);
    expect(evaluateBoolExpr({ op: "ownedBy", fixerId: "fixer-A" }, card.id, ctx)).toBe(false);
  });
});

describe("dependency extraction: structural, no entities needed", () => {
  it("hasTag/inZone/ownedBy/withinDistance report their coarse DepKeys", () => {
    expect(extractBoolExprDependencies({ op: "hasTag", tag: "shaken" })).toEqual(new Set(["tag:shaken"]));
    expect(extractBoolExprDependencies({ op: "inZone", zoneId: "z" })).toEqual(new Set(["zone"]));
    expect(extractBoolExprDependencies({ op: "ownedBy", fixerId: "f" })).toEqual(new Set(["owner"]));
    expect(extractBoolExprDependencies({ op: "withinDistance", of: "x", maxDistance: 1 })).toEqual(new Set(["prop:x", "prop:y", "prop:z"]));
  });

  it("kindIs reports no deps — kind never changes after creation", () => {
    expect(extractBoolExprDependencies({ op: "kindIs", kind: "card" })).toEqual(new Set());
  });

  it("nested not/or still surfaces all leaf deps", () => {
    const expr: BoolExpr = {
      op: "not",
      expr: { op: "or", exprs: [{ op: "hasTag", tag: "tapped" }, { op: "compare", left: { op: "prop", name: "outflow" }, cmp: "gte", right: { op: "lit", value: 1 } }] },
    };
    expect(extractBoolExprDependencies(expr)).toEqual(new Set(["tag:tapped", "prop:outflow"]));
  });

  it("compare walks BOTH sides — a fold on the left, a fold on the right", () => {
    const expr: BoolExpr = {
      op: "compare",
      left: { op: "fold", fold: "sum", of: { op: "prop", name: "inflow" }, where: { op: "hasTag", tag: "a" } },
      cmp: "gt",
      right: { op: "fold", fold: "count", where: { op: "hasTag", tag: "b" } },
    };
    expect(extractBoolExprDependencies(expr)).toEqual(new Set(["prop:inflow", "tag:a", "tag:b"]));
  });

  it("a fold's deps are the union of where's and of's — even reported when zero entities currently match", () => {
    const expr: NumExpr = { op: "fold", fold: "sum", of: { op: "prop", name: "inflow" }, where: { op: "hasTag", tag: "contractor" } };
    expect(extractNumExprDependencies(expr)).toEqual(new Set(["tag:contractor", "prop:inflow"]));
  });

  it("a labeled fold's own `as` label is in scope for `of`'s dependency walk too, not just evaluation", () => {
    const expr: NumExpr = {
      op: "fold",
      fold: "sum",
      as: "f",
      where: { op: "hasTag", tag: "fixer" },
      of: { op: "fold", fold: "count", where: { op: "ownedBy", fixerId: { op: "ref", label: "f" } } },
    };
    // no throw, and reports the inner fold's real deps (owner) plus the outer's (tag:fixer)
    expect(extractNumExprDependencies(expr)).toEqual(new Set(["tag:fixer", "owner"]));
  });

  it("throws eagerly on a ref to a label not in scope — structural, no entities involved", () => {
    const expr: BoolExpr = { op: "ownedBy", fixerId: { op: "ref", label: "nope" } };
    expect(() => extractBoolExprDependencies(expr)).toThrow(/unbound label "nope"/);
  });

  it("throws eagerly when a fold's own where references its own (not-yet-bound) label", () => {
    const expr: NumExpr = { op: "fold", fold: "count", as: "f", where: { op: "ownedBy", fixerId: { op: "ref", label: "f" } } };
    expect(() => extractNumExprDependencies(expr)).toThrow(/unbound label "f"/);
  });

  it("call reports its function's OWN declared dependencies, not a guess", () => {
    const registry = new QueryFunctionRegistry();
    registry.register("hasBeenDiscardedForXTurns", {
      evaluate: () => false,
      dependencies: () => ["prop:discardedAt", "prop:turnCounter"],
    });
    const expr: BoolExpr = { op: "call", fn: "hasBeenDiscardedForXTurns", args: { turns: 3 } };
    expect(extractBoolExprDependencies(expr, undefined, registry)).toEqual(new Set(["prop:discardedAt", "prop:turnCounter"]));
  });

  it("call throws rather than silently under-reporting deps when the function isn't found", () => {
    const expr: BoolExpr = { op: "call", fn: "unregistered" };
    expect(() => extractBoolExprDependencies(expr)).toThrow(/query function "unregistered" not found/);
    expect(() => extractBoolExprDependencies(expr, undefined, new QueryFunctionRegistry())).toThrow(/not found/);
  });
});

describe("meta-test: catches switch-drift between evaluate and extract", () => {
  it("every BoolExpr op is handled by both evaluateBoolExpr and extractBoolExprDependencies", () => {
    // Exercising every op with a minimal, well-formed instance; the meta-guarantee
    // is that ALL_BOOL_EXPR_OPS enumerates exactly BoolExpr["op"] (a `satisfies`
    // constraint enforced at compile time in interpreter.ts) — if a new op is added
    // to the type without updating BOTH switches, this array literal itself fails
    // to typecheck. Running each here catches a runtime-only omission (a case that
    // typechecks but forgot its `return`) that the type-level check alone wouldn't.
    const registry = new QueryFunctionRegistry();
    registry.register("noop", { evaluate: () => true, dependencies: () => [] });
    const hierarchies = new HierarchyRegistry();
    hierarchies.register(new Hierarchy("board", new EventBus()));
    const card = createCard("X", { properties: { power: 1 } });
    const ctx = makeCtx([card], registry, hierarchies);

    const samples: Record<(typeof ALL_BOOL_EXPR_OPS)[number], BoolExpr> = {
      and: { op: "and", exprs: [] },
      or: { op: "or", exprs: [] },
      not: { op: "not", expr: { op: "and", exprs: [] } },
      hasTag: { op: "hasTag", tag: "x" },
      kindIs: { op: "kindIs", kind: "card" },
      inZone: { op: "inZone", zoneId: "z" },
      ownedBy: { op: "ownedBy", fixerId: "f" },
      withinDistance: { op: "withinDistance", of: card.id, maxDistance: 1 },
      call: { op: "call", fn: "noop" },
      compare: { op: "compare", left: { op: "lit", value: 1 }, cmp: "eq", right: { op: "lit", value: 1 } },
      childOf: { op: "childOf", parent: "some-parent" },
      descendantOf: { op: "descendantOf", ancestor: "some-ancestor" },
    };
    for (const op of ALL_BOOL_EXPR_OPS) {
      expect(() => evaluateBoolExpr(samples[op], card.id, ctx)).not.toThrow();
      expect(() => extractBoolExprDependencies(samples[op], undefined, registry, undefined, hierarchies)).not.toThrow();
    }
  });

  it("every NumExpr op is handled by both evaluateNumExpr and extractNumExprDependencies", () => {
    const card = createCard("X", { properties: { power: 1 } });
    const ctx = makeCtx([card]);
    const samples: Record<(typeof ALL_NUM_EXPR_OPS)[number], NumExpr> = {
      lit: { op: "lit", value: 1 },
      prop: { op: "prop", name: "power" },
      add: { op: "add", left: { op: "lit", value: 1 }, right: { op: "lit", value: 1 } },
      sub: { op: "sub", left: { op: "lit", value: 1 }, right: { op: "lit", value: 1 } },
      mul: { op: "mul", left: { op: "lit", value: 1 }, right: { op: "lit", value: 1 } },
      div: { op: "div", left: { op: "lit", value: 1 }, right: { op: "lit", value: 1 } },
      fold: { op: "fold", fold: "count", where: { op: "and", exprs: [] } },
    };
    for (const op of ALL_NUM_EXPR_OPS) {
      expect(() => evaluateNumExpr(samples[op], card.id, ctx)).not.toThrow();
      expect(() => extractNumExprDependencies(samples[op])).not.toThrow();
    }
  });
});
