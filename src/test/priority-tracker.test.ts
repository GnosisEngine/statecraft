import { describe, expect, it } from "vitest";
import { EventBus } from "../events/bus.ts";
import { EntityStore } from "../events/entity-store.ts";
import { Hierarchy } from "../events/hierarchy.ts";
import { Stack, LIFO_POLICY } from "../events/stack.ts";
import { PropertyResolver } from "../properties/property-resolver.ts";
import { ModifierStore } from "../properties/modifier-store.ts";
import { createCard, createHand } from "../core/entity.ts";
import { PriorityTracker } from "../phases/priority-tracker.ts";

function makeTracker(seatOrder: readonly string[]) {
  const bus = new EventBus();
  const entities = new EntityStore(bus);
  for (const seatId of seatOrder) entities.add(createHand([], { id: seatId }));
  const tracker = new PriorityTracker(seatOrder, entities);
  return { tracker, entities, seatOrder };
}

describe("PriorityTracker — basic reset/pass mechanics", () => {
  it("throws if used before the first reset()", () => {
    const { tracker } = makeTracker(["fixer-A", "fixer-B"]);
    expect(() => tracker.currentHolder).toThrow(/reset\(\) must be called/);
    expect(() => tracker.pass()).toThrow(/reset\(\) must be called/);
  });

  it("reset() starts priority at the given seat", () => {
    const { tracker } = makeTracker(["fixer-A", "fixer-B"]);
    tracker.reset("fixer-B");
    expect(tracker.currentHolder).toBe("fixer-B");
  });

  it("throws resetting to a seat not in this tracker's own seat order", () => {
    const { tracker } = makeTracker(["fixer-A", "fixer-B"]);
    expect(() => tracker.reset("not-a-real-seat")).toThrow(/is not in this tracker's seat order/);
  });

  it("throws constructing with an empty seat order", () => {
    const bus = new EventBus();
    const entities = new EntityStore(bus);
    expect(() => new PriorityTracker([], entities)).toThrow(/must have at least one seat/);
  });

  it("pass() advances to the next seat in round-robin order, wrapping around", () => {
    const { tracker } = makeTracker(["fixer-A", "fixer-B", "fixer-C"]);
    tracker.reset("fixer-A");
    tracker.pass();
    expect(tracker.currentHolder).toBe("fixer-B");
    tracker.pass();
    expect(tracker.currentHolder).toBe("fixer-C");
    tracker.pass();
    expect(tracker.currentHolder).toBe("fixer-A"); // wrapped around
  });

  it("allPassed is only true once EVERY seat has passed consecutively since the last reset — generalizes correctly beyond 2 players", () => {
    const { tracker } = makeTracker(["fixer-A", "fixer-B", "fixer-C"]);
    tracker.reset("fixer-A");
    expect(tracker.pass().allPassed).toBe(false); // A passed — 1 of 3
    expect(tracker.pass().allPassed).toBe(false); // B passed — 2 of 3
    expect(tracker.pass().allPassed).toBe(true); // C passed — all 3, in a row
  });

  it("reset() clears the pass count — a fresh proposal means everyone gets a fresh chance to react, not partial credit toward the old count", () => {
    const { tracker } = makeTracker(["fixer-A", "fixer-B"]);
    tracker.reset("fixer-A");
    tracker.pass(); // 1 of 2 passed
    tracker.reset("fixer-A"); // something new happened — restart the round
    expect(tracker.pass().allPassed).toBe(false); // back to 1 of 2, not 2 of 2
    expect(tracker.pass().allPassed).toBe(true);
  });

  it("a single-seat tracker (degenerate case) reports allPassed after exactly one pass — no special-casing needed", () => {
    const { tracker } = makeTracker(["solo"]);
    tracker.reset("solo");
    expect(tracker.pass().allPassed).toBe(true);
  });
});

describe("PriorityTracker — externalized as a queryable tag, same discipline as stackDepth/active-turn", () => {
  it("tags exactly the current holder with 'holds-priority' (default tag name) and untags everyone else, kept correct across reset and pass", () => {
    const { tracker, entities } = makeTracker(["fixer-A", "fixer-B"]);
    tracker.reset("fixer-A");
    expect(entities.get("fixer-A")?.tags.has("holds-priority")).toBe(true);
    expect(entities.get("fixer-B")?.tags.has("holds-priority")).toBe(false);

    tracker.pass();
    expect(entities.get("fixer-A")?.tags.has("holds-priority")).toBe(false);
    expect(entities.get("fixer-B")?.tags.has("holds-priority")).toBe(true);
  });

  it("supports a custom tag name, so a game can avoid colliding with its own tag vocabulary", () => {
    const bus = new EventBus();
    const entities = new EntityStore(bus);
    entities.add(createHand([], { id: "fixer-A" }));
    entities.add(createHand([], { id: "fixer-B" }));
    const tracker = new PriorityTracker(["fixer-A", "fixer-B"], entities, "my-custom-priority-tag");
    tracker.reset("fixer-A");
    expect(entities.get("fixer-A")?.tags.has("my-custom-priority-tag")).toBe(true);
    expect(entities.get("fixer-A")?.tags.has("holds-priority")).toBe(false); // the default name is NOT also applied
  });
});

describe("PriorityTracker + Stack composed together — the actual 'interactive phase' pattern this exists for", () => {
  it("walks the exact worked trace from the priority-loop design: A pushes, B responds, both pass to resolve B, both pass again to resolve A", () => {
    const bus = new EventBus();
    const entities = new EntityStore(bus);
    const modifiers = new ModifierStore(bus);
    const ctx = new PropertyResolver(entities, modifiers);
    const hierarchy = new Hierarchy("main-stack", bus);
    entities.add(createHand([], { id: "fixer-A" }));
    entities.add(createHand([], { id: "fixer-B" }));
    const stack = new Stack(hierarchy, entities, bus, "fixer-A"); // anchor doesn't matter for this trace
    const priority = new PriorityTracker(["fixer-A", "fixer-B"], entities);

    // A is active; A pushes X
    entities.add(createCard("X", { id: "x" }));
    stack.push("x", null);
    priority.reset("fixer-A"); // a fresh push always resets priority to the active player

    // A declines to respond to their own proposal; priority moves to B
    expect(priority.pass().allPassed).toBe(false);
    expect(priority.currentHolder).toBe("fixer-B");

    // B pushes Y in response to X
    entities.add(createCard("Y", { id: "y" }));
    stack.push("y", "x");
    priority.reset("fixer-A"); // Y is new — everyone gets a fresh chance to react to IT

    // both pass on Y — time to resolve
    expect(priority.pass().allPassed).toBe(false); // A passes
    expect(priority.pass().allPassed).toBe(true); // B passes too — all passed

    const resolvedY = stack.resolveNext(LIFO_POLICY, ctx);
    expect(resolvedY).toBe("y");
    priority.reset("fixer-A"); // the board just changed — fresh round

    // both pass again — X can now resolve (nothing left responding to it)
    expect(priority.pass().allPassed).toBe(false);
    expect(priority.pass().allPassed).toBe(true);
    expect(stack.resolveNext(LIFO_POLICY, ctx)).toBe("x");

    expect(stack.size()).toBe(0); // fully drained — this is what lets the phase actually complete
  });
});
