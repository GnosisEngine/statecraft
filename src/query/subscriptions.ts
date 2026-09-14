/**
 * Query subscription dispatch — the payoff for splitting dependency
 * extraction out as a structural, entity-independent walk (Layer 1).
 *
 * This is a minimal slice of Layer 2 (Event Bus) included here because a
 * query subscription registry is the direct consumer that proves Layer 1's
 * dependency extraction is actually useful, not just symmetric. The full
 * event bus (entity-mutation events, action/phase events, rule triggers)
 * is built out properly in Layer 2.
 */

import type { DepKey } from "./types.ts";

export type ChangeKind = { kind: "tag"; tag: string } | { kind: "prop"; prop: string } | { kind: "zone" } | { kind: "owner" };

function changeKindToDepKey(change: ChangeKind): DepKey {
  switch (change.kind) {
    case "tag":
      return `tag:${change.tag}`;
    case "prop":
      return `prop:${change.prop}`;
    case "zone":
      return "zone";
    case "owner":
      return "owner";
  }
}

export interface QuerySubscription {
  readonly id: string;
  readonly deps: ReadonlySet<DepKey>;
  unsubscribe(): void;
}

/**
 * Registers a set of dependency keys against a callback. Call `notify` with
 * the change(s) that just happened; only subscriptions whose deps intersect
 * the change set get their callback invoked.
 */
export class SubscriptionRegistry {
  private nextId = 0;
  private subs = new Map<string, { deps: ReadonlySet<DepKey>; callback: () => void }>();

  subscribe(deps: ReadonlySet<DepKey>, callback: () => void): QuerySubscription {
    const id = `sub-${this.nextId++}`;
    this.subs.set(id, { deps, callback });
    return {
      id,
      deps,
      unsubscribe: () => this.subs.delete(id),
    };
  }

  /** Notify the registry that one or more changes occurred; fires matching subscriptions once each. */
  notify(changes: ChangeKind[]): void {
    const changedDeps = new Set(changes.map(changeKindToDepKey));
    for (const { deps, callback } of this.subs.values()) {
      for (const dep of deps) {
        if (changedDeps.has(dep)) {
          callback();
          break;
        }
      }
    }
  }

  get size(): number {
    return this.subs.size;
  }
}
