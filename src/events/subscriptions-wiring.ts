/**
 * Layer 2 — wiring the EventBus to Layer 1's SubscriptionRegistry.
 *
 * This is the piece that makes the whole query-everywhere model actually
 * cheap: entity mutations (via EntityStore) emit GameEvents; this function
 * translates those into the coarse ChangeKind vocabulary the
 * SubscriptionRegistry already understands, so aggregate properties, phase
 * gates, and action-legality checks all recompute automatically and only
 * when something they structurally depend on changes.
 *
 * Deliberately a standalone function, not a method on EventBus or
 * EntityStore — the registry is one subscriber among several (rules and
 * the event log are the others, added in later layers), and none of them
 * should need to know about each other.
 */

import type { EventBus } from "./bus.ts";
import type { SubscriptionRegistry } from "../query/subscriptions.ts";

export function wireQuerySubscriptions(bus: EventBus, registry: SubscriptionRegistry): () => void {
  const unsubscribes = [
    bus.on("entity:tagAdded", (e) => registry.notify([{ kind: "tag", tag: e.tag }])),
    bus.on("entity:tagRemoved", (e) => registry.notify([{ kind: "tag", tag: e.tag }])),
    bus.on("entity:propertyChanged", (e) => registry.notify([{ kind: "prop", prop: e.prop }])),
    bus.on("entity:zoneChanged", () => registry.notify([{ kind: "zone" }])),
    bus.on("entity:ownershipChanged", () => registry.notify([{ kind: "owner" }])),
    // A modifier is a property mutation by another name — same ChangeKind.
    bus.on("modifier:added", (e) => registry.notify([{ kind: "prop", prop: e.modifier.prop }])),
    bus.on("modifier:removed", (e) => registry.notify([{ kind: "prop", prop: e.modifier.prop }])),
  ];
  return () => unsubscribes.forEach((off) => off());
}
