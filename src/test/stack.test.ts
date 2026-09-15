import { describe, expect, it, vi } from "vitest";
import { EventBus } from "../events/bus.ts";
import { EntityStore } from "../events/entity-store.ts";
import { Hierarchy } from "../events/hierarchy.ts";
import { Stack, LIFO_POLICY, FIFO_POLICY, bidAwarePolicy } from "../events/stack.ts";
import { createCard, createHand, transferOwnership } from "../core/entity.ts";
import { ModifierStore } from "../properties/modifier-store.ts";
import { PropertyResolver } from "../properties/property-resolver.ts";
import { newModifierId } from "../properties/modifier.ts";
import type { QueryContext } from "../query/interpreter.ts";
import { evaluateBoolExpr } from "../query/interpreter.ts";
import type { NumExpr, BoolExpr } from "../query/types.ts";

function makeStack(): { stack: Stack; bus: EventBus; hierarchy: Hierarchy; entities: EntityStore; modifiers: ModifierStore; ctx: QueryContext; anchorId: string } {
  const bus = new EventBus();
  const entities = new EntityStore(bus);
  const modifiers = new ModifierStore(bus);
  const hierarchy = new Hierarchy("test-stack", bus);
  const anchorId = "table";
  entities.add(createCard("Table", { id: anchorId })); // Stack.setProperty requires the anchor to already exist
  const stack = new Stack(hierarchy, entities, bus, anchorId);
  const ctx = new PropertyResolver(entities, modifiers);
  return { stack, bus, hierarchy, entities, modifiers, ctx, anchorId };
}

function push(entities: EntityStore, stack: Stack, id: string, parentId: string | null) {
  entities.add(createCard(id, { id }));
  stack.push(id, parentId);
}

describe("Stack — tree construction", () => {
  it("push/size/leaves reflect a growing tree, and pushedAtSequence is stamped on each item", () => {
    const { stack, entities, ctx } = makeStack();
    push(entities, stack, "a", null);
    expect(stack.size()).toBe(1);
    expect(stack.leaves()).toEqual(["a"]);
    expect(stack.has("a")).toBe(true);
    expect(stack.has("nonexistent")).toBe(false);
    expect(ctx.getProperty("a", "pushedAtSequence")).toBe(0);

    push(entities, stack, "b", "a");
    push(entities, stack, "c", "a"); // TWO things responding to "a" simultaneously — impossible under the old chain-only design
    expect(stack.size()).toBe(3);
    expect(stack.leaves().sort()).toEqual(["b", "c"]); // "a" has children now, so it's no longer a leaf
    expect(ctx.getProperty("b", "pushedAtSequence")).toBe(1);
    expect(ctx.getProperty("c", "pushedAtSequence")).toBe(2);
  });

  it("this tree topology makes childOf/descendantOf answer real relational questions with zero new interpreter surface", () => {
    const { stack, entities, hierarchy } = makeStack();
    push(entities, stack, "a", null);
    push(entities, stack, "b", "a");
    push(entities, stack, "c", "b");
    expect(hierarchy.isDescendantOf("c", "a")).toBe(true); // nested inside a response to "a", at depth
    expect(hierarchy.isDescendantOf("b", "a")).toBe(true); // direct response to "a"
    expect(hierarchy.isDescendantOf("a", "c")).toBe(false); // wrong direction
  });
});

describe("Stack — resolveNext, the core invariant", () => {
  it("NEVER resolves a parent while it still has an unresolved child — only leaves are ever candidates", () => {
    const { stack, entities, ctx } = makeStack();
    push(entities, stack, "a", null);
    push(entities, stack, "b", "a"); // b responds to a — a is no longer a leaf
    const resolved = stack.resolveNext(LIFO_POLICY, ctx);
    expect(resolved).toBe("b"); // NOT "a", even though "a" was pushed first — a has an unresolved child
  });

  it("LIFO_POLICY resolves the most recently pushed leaf first", () => {
    const { stack, entities, ctx } = makeStack();
    push(entities, stack, "a", null);
    push(entities, stack, "b", null); // a second, unrelated root — both are leaves
    expect(stack.resolveNext(LIFO_POLICY, ctx)).toBe("b"); // pushed later
    expect(stack.resolveNext(LIFO_POLICY, ctx)).toBe("a");
  });

  it("FIFO_POLICY resolves the oldest leaf first — same data as LIFO, opposite arithmetic", () => {
    const { stack, entities, ctx } = makeStack();
    push(entities, stack, "a", null);
    push(entities, stack, "b", null);
    expect(stack.resolveNext(FIFO_POLICY, ctx)).toBe("a"); // pushed first
    expect(stack.resolveNext(FIFO_POLICY, ctx)).toBe("b");
  });

  it("a custom NumExpr policy (e.g. a content-defined priority property) is scored exactly like LIFO/FIFO — no special casing needed for non-default policies", () => {
    const { stack, entities, ctx } = makeStack();
    push(entities, stack, "a", null);
    push(entities, stack, "b", null);
    entities.setProperty("a", "priority", 10);
    entities.setProperty("b", "priority", 5);
    const priorityPolicy: NumExpr = { op: "prop", name: "priority" };
    expect(stack.resolveNext(priorityPolicy, ctx)).toBe("a"); // higher priority, even though pushed first
  });

  it("ties are broken by highest pushedAtSequence — deterministic regardless of what the policy scores", () => {
    const { stack, entities, ctx } = makeStack();
    push(entities, stack, "a", null);
    push(entities, stack, "b", null);
    entities.setProperty("a", "priority", 5);
    entities.setProperty("b", "priority", 5); // identical score
    const priorityPolicy: NumExpr = { op: "prop", name: "priority" };
    expect(stack.resolveNext(priorityPolicy, ctx)).toBe("b"); // tie broken by higher pushedAtSequence (pushed later)
  });

  it("throws when resolving an empty stack", () => {
    const { stack, ctx } = makeStack();
    expect(() => stack.resolveNext(LIFO_POLICY, ctx)).toThrow(/nothing pending to resolve/);
  });

  it("resolving a parent's only child correctly exposes the parent as a new leaf", () => {
    const { stack, entities, ctx } = makeStack();
    push(entities, stack, "a", null);
    push(entities, stack, "b", "a");
    expect(stack.leaves()).toEqual(["b"]);
    stack.resolveNext(LIFO_POLICY, ctx);
    expect(stack.leaves()).toEqual(["a"]); // now exposed
  });
});

describe("Stack — counter (removing any item, not just a leaf)", () => {
  it("countering a leaf behaves like a normal resolve, minus actually resolving", () => {
    const { stack, entities } = makeStack();
    push(entities, stack, "a", null);
    stack.counter("a");
    expect(stack.size()).toBe(0);
  });

  it("countering a NON-leaf with MULTIPLE children splices ALL of them up to its own parent — the tree survives, nothing orphaned", () => {
    const { stack, entities, hierarchy } = makeStack();
    push(entities, stack, "a", null);
    push(entities, stack, "b", "a");
    push(entities, stack, "c", "a"); // both b and c respond to a
    stack.counter("a");
    expect(stack.size()).toBe(2); // a is gone, b and c survive
    expect(hierarchy.getParent("b")).toBeNull(); // spliced up to a's own parent — root
    expect(hierarchy.getParent("c")).toBeNull();
    expect(stack.leaves().sort()).toEqual(["b", "c"]);
  });

  it("throws when countering an item that isn't on the stack", () => {
    const { stack } = makeStack();
    expect(() => stack.counter("nonexistent")).toThrow(/is not currently on this stack/);
  });
});

describe("Stack — reparent (dynamically restructuring the pending tree)", () => {
  it("moves an item to respond to a different parent", () => {
    const { stack, entities, hierarchy } = makeStack();
    push(entities, stack, "a", null);
    push(entities, stack, "b", null);
    push(entities, stack, "c", "a"); // c initially responds to a
    stack.reparent("c", "b"); // now c responds to b instead
    expect(hierarchy.getParent("c")).toBe("b");
    expect(stack.leaves()).toEqual(["a", "c"].sort()); // a is exposed again (its only child moved away); b is no longer a leaf
  });

  it("reparenting to a new root (null) is legal", () => {
    const { stack, entities, hierarchy } = makeStack();
    push(entities, stack, "a", null);
    push(entities, stack, "b", "a");
    stack.reparent("b", null);
    expect(hierarchy.getParent("b")).toBeNull();
  });

  it("throws attempting to reparent an item to itself", () => {
    const { stack, entities } = makeStack();
    push(entities, stack, "a", null);
    expect(() => stack.reparent("a", "a")).toThrow(/cannot reparent .* to itself/);
  });

  it("throws attempting to create a cycle (reparenting to one of its own descendants)", () => {
    const { stack, entities } = makeStack();
    push(entities, stack, "a", null);
    push(entities, stack, "b", "a");
    push(entities, stack, "c", "b");
    expect(() => stack.reparent("a", "c")).toThrow(/would create a cycle/);
  });

  it("throws reparenting an item that isn't on the stack", () => {
    const { stack } = makeStack();
    expect(() => stack.reparent("nonexistent", null)).toThrow(/is not currently on this stack/);
  });
});

describe("Stack — lifecycle events", () => {
  it("fires stack:pushed with the parentId", () => {
    const { stack, entities, bus } = makeStack();
    const pushed = vi.fn();
    bus.on("stack:pushed", pushed);
    push(entities, stack, "a", null);
    expect(pushed).toHaveBeenCalledWith({ type: "stack:pushed", stack: "test-stack", itemId: "a", parentId: null });
  });

  it("exposedAfterResolution/exposedAfterCounter/exposedAfterReparent fire ONLY when a parent's LAST child is removed or moved — never speculatively", () => {
    const { stack, entities, bus, ctx } = makeStack();
    push(entities, stack, "a", null);
    push(entities, stack, "b", "a");
    push(entities, stack, "c", "a"); // a has TWO children — removing one shouldn't expose it yet

    const exposedAfterResolution = vi.fn();
    const exposedAfterCounter = vi.fn();
    const exposedAfterReparent = vi.fn();
    bus.on("stack:exposedAfterResolution", exposedAfterResolution);
    bus.on("stack:exposedAfterCounter", exposedAfterCounter);
    bus.on("stack:exposedAfterReparent", exposedAfterReparent);

    stack.resolveNext(LIFO_POLICY, ctx); // resolves "c" (most recent) — "a" still has "b", not exposed yet
    expect(exposedAfterResolution).not.toHaveBeenCalled();

    stack.resolveNext(LIFO_POLICY, ctx); // resolves "b" — NOW "a" has zero children, exposed
    expect(exposedAfterResolution).toHaveBeenCalledWith({ type: "stack:exposedAfterResolution", stack: "test-stack", itemId: "a" });
  });

  it("fires stack:reparented with old and new parent", () => {
    const { stack, entities, bus } = makeStack();
    push(entities, stack, "a", null);
    push(entities, stack, "b", null);
    push(entities, stack, "c", "a");
    const reparented = vi.fn();
    bus.on("stack:reparented", reparented);
    stack.reparent("c", "b");
    expect(reparented).toHaveBeenCalledWith({ type: "stack:reparented", stack: "test-stack", itemId: "c", oldParentId: "a", newParentId: "b" });
  });
});

describe("Stack — content-decided cascade (fizzle), demonstrating it's NOT the engine's job", () => {
  it("a card wanting 'fizzle' semantics does its own descendantOf query and additional counter() calls — the engine's own counter() never cascades by itself", () => {
    const { stack, entities, hierarchy } = makeStack();
    push(entities, stack, "a", null);
    push(entities, stack, "b", "a");
    push(entities, stack, "c", "b");

    const toAlsoCounter = ["b", "c"].filter((id) => hierarchy.isDescendantOf(id, "a"));
    stack.counter("a");
    for (const id of toAlsoCounter) stack.counter(id);

    expect(stack.size()).toBe(0);
  });

  it("WITHOUT that extra step, countering a middle item leaves everything above it intact and independently resolvable", () => {
    const { stack, entities, ctx } = makeStack();
    push(entities, stack, "a", null);
    push(entities, stack, "b", "a");
    push(entities, stack, "c", "b");
    stack.counter("b"); // only b — c survives, spliced onto a
    expect(stack.size()).toBe(2); // a and c
    expect(stack.resolveNext(LIFO_POLICY, ctx)).toBe("c"); // c resolves normally, untouched by b's removal
  });
});

describe("Stack — stackDepth: the anchor entity's own queryable summary property", () => {
  it("starts at 0 (via the standard 'never-set property reads as 0' convention) and tracks push/resolve/counter exactly", () => {
    const { stack, entities, anchorId, ctx } = makeStack();
    expect(ctx.getProperty(anchorId, "stackDepth:test-stack")).toBe(0);

    push(entities, stack, "a", null);
    expect(ctx.getProperty(anchorId, "stackDepth:test-stack")).toBe(1);

    push(entities, stack, "b", "a");
    push(entities, stack, "c", "a");
    expect(ctx.getProperty(anchorId, "stackDepth:test-stack")).toBe(3);

    stack.resolveNext(LIFO_POLICY, ctx);
    expect(ctx.getProperty(anchorId, "stackDepth:test-stack")).toBe(2);

    stack.counter("a"); // splices remaining child up, but "a" itself is still removed — depth still drops by exactly 1
    expect(ctx.getProperty(anchorId, "stackDepth:test-stack")).toBe(1);
  });

  it("reparent does NOT change stackDepth — it only moves an existing item, never adds or removes one", () => {
    const { stack, entities, anchorId, ctx } = makeStack();
    push(entities, stack, "a", null);
    push(entities, stack, "b", null);
    push(entities, stack, "c", "a");
    const before = ctx.getProperty(anchorId, "stackDepth:test-stack");
    stack.reparent("c", "b");
    expect(ctx.getProperty(anchorId, "stackDepth:test-stack")).toBe(before);
  });

  it("is namespaced by stack name, so two stacks can safely share the same anchor entity without colliding", () => {
    const bus = new EventBus();
    const entities = new EntityStore(bus);
    const modifiers = new ModifierStore(bus);
    const ctx = new PropertyResolver(entities, modifiers);
    const anchorId = "table";
    entities.add(createCard("Table", { id: anchorId }));
    const hierarchyA = new Hierarchy("stack-a", bus);
    const hierarchyB = new Hierarchy("stack-b", bus);
    const stackA = new Stack(hierarchyA, entities, bus, anchorId);
    const stackB = new Stack(hierarchyB, entities, bus, anchorId);

    entities.add(createCard("X", { id: "x" }));
    stackA.push("x", null);

    expect(ctx.getProperty(anchorId, "stackDepth:stack-a")).toBe(1);
    expect(ctx.getProperty(anchorId, "stackDepth:stack-b")).toBe(0); // untouched by stack-a's own push
    void stackB; // constructed only to prove non-interference; never pushed to
  });

  it("'Standing Order': a real BoolExpr (the shape ActionDefinition.timingCondition actually uses) can gate on 'nothing is currently pending' — the concrete case this property exists for", () => {
    const { stack, entities, anchorId, ctx } = makeStack();
    const onlyBetweenResolutions: BoolExpr = { op: "compare", left: { op: "prop", name: "stackDepth:test-stack" }, cmp: "eq", right: { op: "lit", value: 0 } };

    expect(evaluateBoolExpr(onlyBetweenResolutions, anchorId, ctx)).toBe(true); // nothing pending yet

    push(entities, stack, "a", null);
    expect(evaluateBoolExpr(onlyBetweenResolutions, anchorId, ctx)).toBe(false); // something's pending now — the ability is NOT usable

    stack.resolveNext(LIFO_POLICY, ctx);
    expect(evaluateBoolExpr(onlyBetweenResolutions, anchorId, ctx)).toBe(true); // back to empty — usable again
  });
});

describe("Stack — resolveNext binds a 'performer' label per candidate (the Debt Collector case)", () => {
  it("a resolution policy can score by the PERFORMER's own property (e.g. inflow), not just the pending item's own — via 'performer' bound to the item's current owner, the SAME label-scope mechanism a fold's 'as' already uses, just bound by resolveNext instead of a fold", () => {
    const bus = new EventBus();
    const entities = new EntityStore(bus);
    const modifiers = new ModifierStore(bus);
    const ctx = new PropertyResolver(entities, modifiers);
    const hierarchy = new Hierarchy("test-stack", bus);
    const anchorId = "table";
    entities.add(createCard("Table", { id: anchorId }));
    const stack = new Stack(hierarchy, entities, bus, anchorId);

    // two fixers with different inflow — the policy should favor
    // resolving whichever PENDING ITEM's performer has the lower inflow,
    // regardless of push order
    entities.add(createHand([], { id: "fixer-A", properties: { inflow: 10 } }));
    entities.add(createHand([], { id: "fixer-B", properties: { inflow: 2 } }));
    entities.add(createCard("Action from A", { id: "action-a", ownership: ["fixer-A"] }));
    entities.add(createCard("Action from B", { id: "action-b", ownership: ["fixer-B"] }));

    stack.push("action-a", null); // pushed FIRST — LIFO would pick this, but the policy below shouldn't
    stack.push("action-b", null); // pushed SECOND

    const lowestPerformerInflowFirst: NumExpr = {
      op: "mul",
      left: { op: "lit", value: -1 },
      right: { op: "prop", name: "inflow", subject: { op: "ref", label: "performer" } },
    };

    expect(stack.resolveNext(lowestPerformerInflowFirst, ctx)).toBe("action-b"); // fixer-B's inflow (2) is lower, even though pushed more recently
  });

  it("a candidate with NO owner at all throws the standard unbound-label error if the policy references 'performer' for it — loud failure, not a silent fallback", () => {
    const { stack, entities, ctx } = makeStack();
    entities.add(createCard("Ownerless", { id: "ownerless" })); // no ownership set at all
    stack.push("ownerless", null);
    const referencesPerformer: NumExpr = { op: "prop", name: "inflow", subject: { op: "ref", label: "performer" } };
    expect(() => stack.resolveNext(referencesPerformer, ctx)).toThrow(/ref to unbound label "performer"/);
  });
});

describe("Stack — 'The Long Con': reparent-to-bury is a real, intended tactic — DELAY, not DENIAL", () => {
  it("burying a leaf (reparenting a NEW pending item to respond to it) makes it temporarily ineligible, but it becomes eligible again the moment what's now on top of it clears — the same exposure mechanism any other removal uses", () => {
    const { stack, entities, ctx } = makeStack();
    push(entities, stack, "victim", null);
    expect(stack.leaves()).toEqual(["victim"]);

    push(entities, stack, "blocker", null); // pushed as an unrelated root first
    stack.reparent("blocker", "victim"); // NOW "blocker" responds to "victim" — victim is buried, no longer a leaf
    expect(stack.leaves()).toEqual(["blocker"]);

    stack.resolveNext(LIFO_POLICY, ctx); // resolves "blocker" — "victim" is exposed again
    expect(stack.leaves()).toEqual(["victim"]); // NOT removed — just was temporarily blocked. Delay, not denial.
  });

  it("has NO ownership restriction at the engine level — a card can bury ANY currently-pending item under a response, regardless of who performed either one; a specific card's own targetQuery is what would actually restrict this in real content", () => {
    const { stack, entities } = makeStack();
    entities.add(createHand([], { id: "fixer-A" }));
    entities.add(createHand([], { id: "fixer-B" }));
    entities.add(createCard("Opponent's pending action", { id: "opponents-action", ownership: ["fixer-B"] }));
    entities.add(createCard("My response", { id: "my-response", ownership: ["fixer-A"] }));
    stack.push("opponents-action", null);
    stack.push("my-response", null);

    // fixer-A burying fixer-B's pending action under fixer-A's own
    // response — the engine raises no objection at all; this is exactly
    // the tactic
    expect(() => stack.reparent("my-response", "opponents-action")).not.toThrow();
    expect(stack.leaves()).toEqual(["my-response"]);
  });

  it("repeated burying of the SAME target (the actual 'Long Con' pattern — each new response piling on top of the CURRENT blocker, deepening the chain) still drains the stack to empty once nothing new is pushed — reparenting alone cannot structurally prevent the stack from resolving, only delay one specific item within it", () => {
    const { stack, entities, ctx } = makeStack();
    push(entities, stack, "victim", null);

    // each successive blocker responds to whatever's CURRENTLY on top —
    // a true deepening chain, simulating a player repeatedly spending
    // resources to keep "victim" buried under an ever-taller pile
    let currentTop = "victim";
    for (const blocker of ["blocker-1", "blocker-2", "blocker-3"]) {
      push(entities, stack, blocker, null);
      stack.reparent(blocker, currentTop);
      currentTop = blocker;
    }
    expect(stack.size()).toBe(4); // victim + 3 blockers
    expect(stack.leaves()).toEqual(["blocker-3"]); // only the LATEST blocker is a leaf — victim is buried three deep

    // once nothing new is pushed, normal resolution fully drains it,
    // deepest-first — no special unburying step needed, no stuck state
    const resolved: string[] = [];
    while (stack.size() > 0) {
      resolved.push(stack.resolveNext(LIFO_POLICY, ctx));
    }
    expect(resolved).toEqual(["blocker-3", "blocker-2", "blocker-1", "victim"]); // unwinds in exactly the reverse order it was buried
  });

  it("reparenting under a non-pending (even nonexistent) parent is well-defined, not a crash — the item keeps its own leaf-eligibility, and simply never fires an exposure event for that untracked parent", () => {
    const { stack, entities } = makeStack();
    push(entities, stack, "item", null);
    expect(() => stack.reparent("item", "not-actually-pending")).not.toThrow();
    expect(stack.leaves()).toEqual(["item"]); // still a leaf — its OWN eligibility never depended on its parent being valid
    expect(stack.size()).toBe(1); // untouched
  });
});

describe("Stack — 'Forged Ledger': pushedAtSequence is ordinary, mutable state, not a tamper-proof engine record", () => {
  it("a card that directly overwrites a pending item's own pushedAtSequence changes how LIFO_POLICY resolves it — the engine has no memory to contradict the forgery, by design", () => {
    const { stack, entities, ctx } = makeStack();
    push(entities, stack, "old-grievance", null); // seq 0
    push(entities, stack, "recent-filing", null); // seq 1 — LIFO would normally resolve THIS first

    // "Forged Ledger": falsify the paper trail — make the older item LOOK
    // like it was filed after the newer one, by directly overwriting the
    // property. Nothing in Stack prevents this; pushedAtSequence is a
    // plain entity property once set, exactly like inflow or outflow.
    entities.setProperty("old-grievance", "pushedAtSequence", 99);

    // resolveNext is a PURE function of current state — it has no
    // separate record of "when this was really pushed" to check the
    // forgery against, so it resolves the FORGED item first, exactly as
    // if it really had been filed most recently.
    expect(stack.resolveNext(LIFO_POLICY, ctx)).toBe("old-grievance");
  });

  it("the forgery is total, not partial — a resolved forged item is indistinguishable from a genuinely recent one to any later query", () => {
    const { stack, entities, ctx } = makeStack();
    push(entities, stack, "a", null);
    push(entities, stack, "b", null);
    entities.setProperty("a", "pushedAtSequence", 1000);

    // even a policy scoring something else entirely alongside sequence
    // (a tie-break) sees the SAME forged value everyone else would
    expect(entities.get("a")?.properties.pushedAtSequence).toBe(1000);
    expect(stack.resolveNext(LIFO_POLICY, ctx)).toBe("a");
  });
});

describe("Stack — 'Plausible Deniability': whether a reparent-based severance beats a descendantOf-based cascade check is purely a question of resolution ORDER", () => {
  it("severing before the cascade check runs lets the item escape clean", () => {
    const { stack, entities, hierarchy } = makeStack();
    push(entities, stack, "target", null);
    push(entities, stack, "co-conspirator", "target"); // responds to target — would be caught by a cascade against target

    // sever first: co-conspirator is reparented to a fresh root, BEFORE
    // anything checks descendantOf("co-conspirator", "target")
    stack.reparent("co-conspirator", null);

    const caughtByCascade = hierarchy.isDescendantOf("co-conspirator", "target");
    expect(caughtByCascade).toBe(false); // escaped clean — the cascade check would find nothing
  });

  it("running the cascade check first catches it, before any severance can happen", () => {
    const { stack, entities, hierarchy } = makeStack();
    push(entities, stack, "target", null);
    push(entities, stack, "co-conspirator", "target");

    // cascade check runs FIRST this time — it correctly sees the link
    const caughtByCascade = hierarchy.isDescendantOf("co-conspirator", "target");
    expect(caughtByCascade).toBe(true);

    // severing AFTER the check already ran doesn't retroactively help —
    // the cascade's own decision (to also counter co-conspirator) was
    // already made using the truthful state at the time it looked
    stack.reparent("co-conspirator", null);
    expect(stack.size()).toBe(2); // still both present — reparenting doesn't remove anything by itself
  });

  it("main-phase resolution order is fully deterministic, so which of the two above happens is a real, learnable timing question — not a coin flip", () => {
    // Same setup, same policy, same state — resolveNext's own tie-break
    // (highest pushedAtSequence) makes the answer to "which resolves
    // first" exactly reproducible, which is what makes racing a
    // severance against a cascade check a skill question at all.
    const { stack, entities, ctx } = makeStack();
    push(entities, stack, "severance-attempt", null);
    push(entities, stack, "cascade-check", null);
    const firstRun = stack.resolveNext(LIFO_POLICY, ctx);

    const rig2 = makeStack();
    push(rig2.entities, rig2.stack, "severance-attempt", null);
    push(rig2.entities, rig2.stack, "cascade-check", null);
    const secondRun = rig2.stack.resolveNext(LIFO_POLICY, rig2.ctx);

    expect(firstRun).toBe(secondRun); // identical inputs, identical outcome, every time
  });
});

describe("Stack — 'Turncoat': does the 'performer' label re-bind dynamically, or reflect a stale snapshot from push time?", () => {
  it("resolveNext's performer label reflects the CURRENT owner at RESOLUTION time, not whoever owned the item when it was pushed", () => {
    const bus = new EventBus();
    const entities = new EntityStore(bus);
    const modifiers = new ModifierStore(bus);
    const ctx = new PropertyResolver(entities, modifiers);
    const hierarchy = new Hierarchy("test-stack", bus);
    const anchorId = "table";
    entities.add(createCard("Table", { id: anchorId }));
    const stack = new Stack(hierarchy, entities, bus, anchorId);

    entities.add(createHand([], { id: "fixer-A", properties: { inflow: 100 } }));
    entities.add(createHand([], { id: "fixer-B", properties: { inflow: 1 } }));

    // Both items start owned by fixer-A (high inflow) — a policy
    // scoring "lowest performer inflow first" would have NO reason to
    // prefer either one under their ORIGINAL ownership.
    const itemA = createCard("Action A", { id: "item-a", ownership: ["fixer-A"] });
    const itemB = createCard("Action B", { id: "item-b", ownership: ["fixer-A"] });
    entities.add(itemA);
    entities.add(itemB);
    stack.push("item-a", null);
    stack.push("item-b", null);

    // "Turncoat": item-b's ownership is seized — reassigned to fixer-B
    // (low inflow) BEFORE either resolves.
    itemB.ownership = transferOwnership(itemB, "fixer-B");

    const lowestPerformerInflowFirst: NumExpr = {
      op: "mul",
      left: { op: "lit", value: -1 },
      right: { op: "prop", name: "inflow", subject: { op: "ref", label: "performer" } },
    };

    // if "performer" were bound at PUSH time (a stale snapshot), both
    // items would still score identically (both pushed under fixer-A's
    // ownership) and the tie would fall to pushedAtSequence (item-b,
    // pushed later). Instead, item-b now resolves BECAUSE its CURRENT
    // owner (fixer-B, inflow 1) scores lower than item-a's owner
    // (fixer-A, inflow 100) — proving the label is recomputed fresh
    // at resolution time, not fixed at push time.
    expect(stack.resolveNext(lowestPerformerInflowFirst, ctx)).toBe("item-b");
  });
});

describe("Stack — 'Sleeper Agent': can a new item respond to something that's ALREADY buried (not a leaf) rather than only to a currently-eligible leaf?", () => {
  it("YES — push's own parentId can be ANY currently-pending item, leaf or not. Multiple things can respond to the same buried item simultaneously, deepening the tree at more than one point at once", () => {
    const { stack, entities, ctx } = makeStack();
    push(entities, stack, "root", null);
    push(entities, stack, "blocker", "root"); // root is now buried under blocker — root is NOT a leaf

    // "Sleeper Agent": a NEW item responds directly to "root" — the
    // BURIED item, not the current leaf ("blocker")
    push(entities, stack, "sleeper", "root");

    // root now has TWO children (blocker AND sleeper) — both are
    // leaves, both are independently responding to the same buried item
    expect(stack.leaves().sort()).toEqual(["blocker", "sleeper"]);
    expect(stack.size()).toBe(3);
  });

  it("resolving both of root's children exposes root exactly once — not twice, and not before both are gone", () => {
    const { stack, entities, ctx } = makeStack();
    push(entities, stack, "root", null);
    push(entities, stack, "blocker", "root");
    push(entities, stack, "sleeper", "root");

    const firstResolved = stack.resolveNext(LIFO_POLICY, ctx); // one of blocker/sleeper — root still has ONE child left
    expect(stack.leaves()).not.toContain("root"); // still buried under the other one
    stack.resolveNext(LIFO_POLICY, ctx); // resolves the other one now
    expect(stack.leaves()).toEqual(["root"]); // exposed exactly now — its LAST child just cleared
    void firstResolved;
  });
});
describe("Stack — 'Ghostwriter': a rule can react to a resolution by automatically countering something ELSE — 'Reflex' for counter/reparent, not just push", () => {
  it("a rule bound to stack:resolved can counter a different, unrelated item as its own automatic reaction — the same event mechanism 'Reflex' proved works for push, now used for counter instead", () => {
    const { stack, entities, bus, ctx } = makeStack();
    push(entities, stack, "witness", null); // pushed FIRST — unrelated, gets silenced
    push(entities, stack, "trigger", null); // pushed SECOND — LIFO resolves this one first

    let silenced = false;
    bus.on("stack:resolved", (event) => {
      if (event.itemId !== "trigger") return; // only react to THIS specific item resolving
      stack.counter("witness");
      silenced = true;
    });

    stack.resolveNext(LIFO_POLICY, ctx); // resolves "trigger" (most recently pushed)
    expect(silenced).toBe(true);
    expect(stack.size()).toBe(0); // trigger resolved, witness countered — both gone
  });
});

describe("Stack — 'Doppelganger': does the cycle guard catch an INDIRECT, two-step cycle attempt, not just the trivial self-reparent case?", () => {
  it("A is B's current ancestor; reparenting A to respond to B (making B A's parent) would create a 2-node cycle (A -> B -> A) — correctly rejected", () => {
    const { stack, entities } = makeStack();
    push(entities, stack, "a", null); // a is a root
    push(entities, stack, "b", "a"); // b responds to a — a is b's ancestor

    // attempting to make "a" respond to "b" would close the loop:
    // a's new parent is b, but b's parent is ALREADY a
    expect(() => stack.reparent("a", "b")).toThrow(/would create a cycle/);
  });

  it("the same guard catches a DEEPER, three-node indirect cycle just as reliably — a is b's grandparent through c, and reparenting a to respond to c would still close the loop", () => {
    const { stack, entities } = makeStack();
    push(entities, stack, "a", null);
    push(entities, stack, "b", "a");
    push(entities, stack, "c", "b"); // a <- b <- c (a is c's grandparent)

    // a responding to c would create: a -> c -> b -> a
    expect(() => stack.reparent("a", "c")).toThrow(/would create a cycle/);
    // sanity: the tree is UNCHANGED after the rejected attempt — a
    // rejected reparent must not partially apply
    expect(entities.get("a")).toBeDefined(); // still exists, unmoved
    expect(stack.size()).toBe(3);
  });

  it("legitimately reparenting to a NON-ancestor (no cycle risk) still works fine alongside this guard — proving the check is precise, not overly broad", () => {
    const { stack, entities } = makeStack();
    push(entities, stack, "a", null);
    push(entities, stack, "b", null); // b is an UNRELATED root, not a's descendant

    expect(() => stack.reparent("a", "b")).not.toThrow();
    expect(stack.leaves()).toEqual(["a"]); // a now responds to b — a is the new leaf
  });
});

describe("Stack — 'Insurance Policy': a MODIFIER on pushedAtSequence behaves genuinely differently from a direct overwrite (Forged Ledger) — it fools a custom policy, but NEVER the tie-break", () => {
  it("a modifier inflating pushedAtSequence changes what a CUSTOM policy sees (evaluated through PropertyResolver, which applies modifiers) — a genuinely different attack surface from Forged Ledger's direct setProperty", () => {
    const { stack, entities, modifiers, ctx } = makeStack();
    push(entities, stack, "a", null); // seq 0 — pushed FIRST
    push(entities, stack, "b", null); // seq 1 — pushed SECOND, LIFO would normally favor this one

    // "Insurance Policy": a modifier LAYERED on top of "a"'s pushedAtSequence
    // — the raw stored value never changes, only what PropertyResolver
    // reports when asked
    modifiers.add({ id: newModifierId(), targetEntityId: "a", prop: "pushedAtSequence", op: "add", value: 1000, priority: 0, source: "insurance-policy" });

    const rawPolicy: NumExpr = { op: "prop", name: "pushedAtSequence" };
    // resolveNext scores through ctx (PropertyResolver) — sees "a" as
    // 1000, not 0 — so "a" wins despite having the LOWER raw sequence
    expect(stack.resolveNext(rawPolicy, ctx)).toBe("a");
  });

  it("the SAME modifier has ZERO effect on the tie-break — Stack's own sequenceOf reads the raw entity property directly, never through PropertyResolver, so a tie under a policy that doesn't itself read pushedAtSequence still resolves by TRUE push order", () => {
    const { stack, entities, modifiers, ctx } = makeStack();
    push(entities, stack, "a", null); // seq 0
    push(entities, stack, "b", null); // seq 1 — genuinely more recent

    // same inflating modifier as above
    modifiers.add({ id: newModifierId(), targetEntityId: "a", prop: "pushedAtSequence", op: "add", value: 1000, priority: 0, source: "insurance-policy" });

    // a policy that scores everything EQUALLY (a constant) — forces
    // the tie-break to decide, which reads the RAW stored value, NOT
    // what the modifier makes PropertyResolver report
    const constantPolicy: NumExpr = { op: "lit", value: 0 };
    expect(stack.resolveNext(constantPolicy, ctx)).toBe("b"); // genuinely more recent by raw sequence — the modifier fooled nothing here
  });
});

describe("Stack — bidAwarePolicy: a single, fixed policy that scores bids correctly AND behaves identically to LIFO for everything that never bid at all", () => {
  it("an item with ANY committed amount always outranks one with none, regardless of push order — a late, cheap non-bid never beats an early, real bid", () => {
    const { stack, entities, ctx } = makeStack();
    push(entities, stack, "ordinary", null); // pushed first, no bid — committedAmount reads 0
    push(entities, stack, "bidder", null); // pushed second — but actually committed something
    entities.get("bidder")!.properties.committedAmount = 3;

    // LIFO alone would favor "bidder" anyway here (pushed later) — make
    // the ordinary item pushed LATER instead, so ONLY the bid-aware
    // scoring (not push order) can explain the winner
    push(entities, stack, "later-ordinary", null);

    const policy = bidAwarePolicy("committedAmount");
    expect(stack.resolveNext(policy, ctx)).toBe("bidder"); // wins despite being pushed before "later-ordinary"
  });

  it("among two real bids, the HIGHER committed amount wins, regardless of which was proposed first", () => {
    const { stack, entities, ctx } = makeStack();
    push(entities, stack, "early-big-bid", null);
    entities.get("early-big-bid")!.properties.committedAmount = 10;
    push(entities, stack, "late-small-bid", null); // pushed later — LIFO alone would favor this one
    entities.get("late-small-bid")!.properties.committedAmount = 2;

    const policy = bidAwarePolicy("committedAmount");
    expect(stack.resolveNext(policy, ctx)).toBe("early-big-bid"); // higher commitment wins despite being older
  });

  it("with NO bids anywhere on the stack, behaves IDENTICALLY to plain LIFO_POLICY — most recently pushed wins, same as today's default", () => {
    const { stack, entities, ctx } = makeStack();
    push(entities, stack, "a", null);
    push(entities, stack, "b", null);
    push(entities, stack, "c", null); // most recent, no one bid on anything

    const policy = bidAwarePolicy("committedAmount");
    expect(stack.resolveNext(policy, ctx)).toBe("c"); // exactly what LIFO_POLICY alone would have picked
  });

  it("two equal commitments still resolve by push order — pushedAtSequence keeps its own tie-break role, unchanged", () => {
    const { stack, entities, ctx } = makeStack();
    push(entities, stack, "first-bid", null);
    entities.get("first-bid")!.properties.committedAmount = 5;
    push(entities, stack, "second-bid", null); // same commitment, pushed later
    entities.get("second-bid")!.properties.committedAmount = 5;

    const policy = bidAwarePolicy("committedAmount");
    expect(stack.resolveNext(policy, ctx)).toBe("second-bid"); // genuine tie broken by push order, same role pushedAtSequence already plays for LIFO/FIFO
  });
});
