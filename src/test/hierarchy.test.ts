import { describe, expect, it, vi } from "vitest";
import { EventBus } from "../events/bus.ts";
import { Hierarchy } from "../events/hierarchy.ts";
import { HierarchyRegistry } from "../query/hierarchy-registry.ts";
import { SeededRandom } from "../persistence/seeded-random.ts";

describe("Hierarchy", () => {
  it("setParent classifies a child, getParent reads it back, and emits hierarchy:parentChanged", () => {
    const bus = new EventBus();
    const spy = vi.fn();
    bus.on("hierarchy:parentChanged", spy);
    const h = new Hierarchy("board", bus);

    expect(h.getParent("card-1")).toBeUndefined(); // never classified

    h.setParent("card-1", "zone-1");
    expect(h.getParent("card-1")).toBe("zone-1");
    expect(spy).toHaveBeenCalledWith({ type: "hierarchy:parentChanged", hierarchy: "board", childId: "card-1", parentId: "zone-1", siblingIndex: undefined });
  });

  it("null is a real, distinct classification (a root) from undefined (never classified)", () => {
    const bus = new EventBus();
    const h = new Hierarchy("board", bus);
    const spy = vi.fn();
    bus.on("hierarchy:parentChanged", spy);

    h.setParent("card-1", null); // classify as a root — must NOT be treated as a no-op just because null looks "empty"
    expect(h.getParent("card-1")).toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("setParent no-ops (no event) when the new parent AND siblingIndex are both unchanged", () => {
    const bus = new EventBus();
    const h = new Hierarchy("board", bus);
    h.setParent("card-1", "zone-1", 2);

    const spy = vi.fn();
    bus.on("hierarchy:parentChanged", spy);
    h.setParent("card-1", "zone-1", 2); // identical — true no-op
    expect(spy).not.toHaveBeenCalled();

    h.setParent("card-1", "zone-1", 5); // same parent, different index — real change
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("remove un-classifies a child entirely — distinct from setParent(child, null)", () => {
    const bus = new EventBus();
    const h = new Hierarchy("board", bus);
    h.setParent("card-1", "zone-1");
    h.remove("card-1");
    expect(h.getParent("card-1")).toBeUndefined();

    // remove on an already-unclassified (or never-classified) child is a no-op, no event
    const spy = vi.fn();
    bus.on("hierarchy:parentChanged", spy);
    h.remove("card-1");
    expect(spy).not.toHaveBeenCalled();
  });

  it("childrenOf is always computed, never a stored array, and sorted by siblingIndex", () => {
    const bus = new EventBus();
    const h = new Hierarchy("deck", bus);
    h.setParent("c", "deck-1", 2);
    h.setParent("a", "deck-1", 0);
    h.setParent("b", "deck-1", 1);
    h.setParent("elsewhere", "some-other-parent", 0);

    expect(h.childrenOf("deck-1")).toEqual(["a", "b", "c"]);
    expect(h.childrenOf("nonexistent-parent")).toEqual([]);
  });

  it("childrenOf treats entities with no explicit siblingIndex as sorting first (index 0)", () => {
    const bus = new EventBus();
    const h = new Hierarchy("deck", bus);
    h.setParent("no-index", "p");
    h.setParent("has-index", "p", 5);
    expect(h.childrenOf("p")).toEqual(["no-index", "has-index"]);
  });

  it("isDescendantOf walks arbitrarily deep, both true and false cases", () => {
    const bus = new EventBus();
    const h = new Hierarchy("board", bus);
    h.setParent("grandchild", "child");
    h.setParent("child", "parent");
    h.setParent("parent", "grandparent");
    h.setParent("grandparent", null);

    expect(h.isDescendantOf("grandchild", "parent")).toBe(true);
    expect(h.isDescendantOf("grandchild", "grandparent")).toBe(true);
    expect(h.isDescendantOf("grandchild", "grandchild")).toBe(false); // not its own descendant
    expect(h.isDescendantOf("parent", "grandchild")).toBe(false); // wrong direction
    expect(h.isDescendantOf("unrelated", "parent")).toBe(false);
  });

  it("isDescendantOf throws loudly on a genuine cycle, rather than looping forever or silently returning false", () => {
    const bus = new EventBus();
    const h = new Hierarchy("board", bus);
    h.setParent("a", "b");
    h.setParent("b", "a"); // cycle

    expect(() => h.isDescendantOf("a", "nonexistent-target")).toThrow(/cycle detected/);
  });

  it("isDescendantOf on a long ACYCLIC chain exceeding maxDepth returns false, not a throw", () => {
    const bus = new EventBus();
    const h = new Hierarchy("board", bus);
    // a chain of 5 links, but maxDepth is only 3 — the true ancestor is out of reach
    h.setParent("n1", "n2");
    h.setParent("n2", "n3");
    h.setParent("n3", "n4");
    h.setParent("n4", "n5");
    h.setParent("n5", null);

    expect(h.isDescendantOf("n1", "n5", 3)).toBe(false); // out of depth budget, no cycle — just not found
    expect(h.isDescendantOf("n1", "n5", 10)).toBe(true); // enough budget, found
  });

  it("drawRandom only ever draws from the UNORDERED pool — never a sibling that has an explicit siblingIndex", () => {
    const bus = new EventBus();
    const h = new Hierarchy("deck", bus);
    h.setParent("ordered", "deck-1", 0); // has an index — NOT part of the pool
    h.setParent("pooled", "deck-1"); // no index — IS part of the pool

    const drawn = h.drawRandom("deck-1", new SeededRandom(1));
    expect(drawn).toBe("pooled");
  });

  it("drawRandom removes the drawn entity from the hierarchy entirely", () => {
    const bus = new EventBus();
    const h = new Hierarchy("deck", bus);
    h.setParent("only-card", "deck-1");

    const drawn = h.drawRandom("deck-1", new SeededRandom(1));
    expect(drawn).toBe("only-card");
    expect(h.getParent("only-card")).toBeUndefined(); // fully un-classified, not left as a root
  });

  it("drawRandom returns undefined when the pool is empty, without throwing", () => {
    const bus = new EventBus();
    const h = new Hierarchy("deck", bus);
    expect(h.drawRandom("empty-deck", new SeededRandom(1))).toBeUndefined();
  });

  it("drawRandom is deterministic — the same seed draws the same card first", () => {
    const bus1 = new EventBus();
    const h1 = new Hierarchy("deck", bus1);
    for (const id of ["a", "b", "c", "d", "e"]) h1.setParent(id, "deck-1");

    const bus2 = new EventBus();
    const h2 = new Hierarchy("deck", bus2);
    for (const id of ["a", "b", "c", "d", "e"]) h2.setParent(id, "deck-1");

    expect(h1.drawRandom("deck-1", new SeededRandom(42))).toBe(h2.drawRandom("deck-1", new SeededRandom(42)));
  });

  it("draining the whole pool via repeated drawRandom yields every card exactly once — no duplicates, no omissions, structurally provable regardless of RNG quality", () => {
    const bus = new EventBus();
    const h = new Hierarchy("deck", bus);
    const cardIds = Array.from({ length: 10 }, (_, i) => `card-${i}`);
    for (const id of cardIds) h.setParent(id, "deck-1");

    const random = new SeededRandom(7);
    const drawn: string[] = [];
    let next: string | undefined;
    while ((next = h.drawRandom("deck-1", random)) !== undefined) drawn.push(next);

    expect(drawn.sort()).toEqual([...cardIds].sort());
    expect(h.drawRandom("deck-1", random)).toBeUndefined(); // pool genuinely exhausted
  });

  it("serialize captures every classification, omitting siblingIndex entirely (not as undefined) when absent", () => {
    const bus = new EventBus();
    const h = new Hierarchy("board", bus);
    h.setParent("ordered", "root", 3);
    h.setParent("pooled", "root"); // no siblingIndex
    h.setParent("also-root", null);

    const serialized = h.serialize();
    expect(serialized.name).toBe("board");
    expect(serialized.entries).toEqual(
      expect.arrayContaining([
        { childId: "ordered", parentId: "root", siblingIndex: 3 },
        { childId: "pooled", parentId: "root" }, // no siblingIndex key at all
        { childId: "also-root", parentId: null },
      ]),
    );
    // specifically: the "pooled" entry has NO siblingIndex property, not siblingIndex: undefined
    const pooledEntry = serialized.entries.find((e) => e.childId === "pooled")!;
    expect("siblingIndex" in pooledEntry).toBe(false);
  });

  it("serialize survives a REAL JSON.stringify/parse round-trip without siblingIndex turning into null", () => {
    const bus = new EventBus();
    const h = new Hierarchy("board", bus);
    h.setParent("pooled", "root"); // no siblingIndex — this is the exact case a tuple encoding would corrupt

    const throughRealJson = JSON.parse(JSON.stringify(h.serialize()));
    const restoredInto = new Hierarchy("board", new EventBus());
    restoredInto.loadRaw(throughRealJson);

    // if siblingIndex had become null instead of staying absent, this would
    // now (incorrectly) be treated as a real siblingIndex value
    expect(restoredInto.childrenOf("root")).toEqual(["pooled"]);
  });

  it("loadRaw replaces this hierarchy's ENTIRE prior state and fires no events", () => {
    const bus = new EventBus();
    const h = new Hierarchy("board", bus);
    h.setParent("stale-entry", "old-parent"); // will NOT survive the loadRaw below

    const spy = vi.fn();
    bus.on("hierarchy:parentChanged", spy);
    h.loadRaw({ name: "board", entries: [{ childId: "fresh-entry", parentId: "new-parent", siblingIndex: 1 }] });

    expect(spy).not.toHaveBeenCalled(); // restoring prior state isn't a live mutation
    expect(h.getParent("stale-entry")).toBeUndefined(); // gone, not merged
    expect(h.getParent("fresh-entry")).toBe("new-parent");
    expect(h.childrenOf("new-parent")).toEqual(["fresh-entry"]);
  });

  it("loadRaw throws on a name mismatch rather than silently loading mismatched data", () => {
    const bus = new EventBus();
    const h = new Hierarchy("board", bus);
    expect(() => h.loadRaw({ name: "squad", entries: [] })).toThrow(/data is for hierarchy "squad", but this is "board"/);
  });
});

describe("HierarchyRegistry", () => {
  it("resolves by explicit name", () => {
    const bus = new EventBus();
    const board = new Hierarchy("board", bus);
    const registry = new HierarchyRegistry();
    registry.register(board);

    const result = registry.resolve("board");
    expect(result).toEqual({ ok: true, hierarchy: board });
  });

  it("an unregistered explicit name fails with a clear reason", () => {
    const registry = new HierarchyRegistry();
    const result = registry.resolve("nope");
    expect(result).toEqual({ ok: false, reason: 'no hierarchy registered for "nope"' });
  });

  it("omitting the name resolves to the ONE registered hierarchy, if there's exactly one", () => {
    const bus = new EventBus();
    const board = new Hierarchy("board", bus);
    const registry = new HierarchyRegistry();
    registry.register(board);

    expect(registry.resolve(undefined)).toEqual({ ok: true, hierarchy: board });
  });

  it("omitting the name with ZERO hierarchies registered fails with a clear reason", () => {
    const registry = new HierarchyRegistry();
    expect(registry.resolve(undefined)).toEqual({ ok: false, reason: "no hierarchies are registered for this game" });
  });

  it("omitting the name with MULTIPLE hierarchies registered fails — ambiguous, must be explicit", () => {
    const bus = new EventBus();
    const registry = new HierarchyRegistry();
    registry.register(new Hierarchy("board", bus));
    registry.register(new Hierarchy("squad", bus));

    const result = registry.resolve(undefined);
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toMatch(/hierarchy name required.*board.*squad|hierarchy name required.*squad.*board/);
  });
});
