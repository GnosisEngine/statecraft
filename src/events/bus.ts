/**
 * Layer 2 — Event Bus.
 *
 * Generic pub/sub over GameEvent. Deliberately dumb: it doesn't know about
 * queries, rules, or persistence — those are all just subscribers. This is
 * what "same bus, different subscribers" means in practice:
 *   - Layer 1's SubscriptionRegistry subscribes to recompute aggregates
 *     (wired via wireQuerySubscriptions, see subscriptions-wiring.ts)
 *   - Layer 5's rule engine will subscribe to fire triggered effects
 *   - Layer 7's persistence will subscribe (via onAny) to append to the
 *     event log
 * None of those subscribers know about each other, and none of this file
 * knows about any of them.
 */

import type { GameEvent, GameEventType } from "./types.ts";

type HandlerFor<T extends GameEventType> = (event: Extract<GameEvent, { type: T }>) => void;
type Unsubscribe = () => void;

const DEFAULT_MAX_EMIT_DEPTH = 64;

export class EventBus {
  private handlers = new Map<GameEventType, Set<(event: GameEvent) => void>>();
  private wildcardHandlers = new Set<(event: GameEvent) => void>();
  private emitDepth = 0;

  /**
   * maxEmitDepth guards against reaction cascades: a rule (or any
   * subscriber) whose effect causes the same event type — or a chain
   * leading back to it — to fire again, recursing through emit()
   * synchronously with nothing to stop it. Real, bounded combo chains
   * (a triggers b triggers c) are fine and expected; this only trips for
   * a genuine runaway loop, and does so with a clear, catchable error
   * instead of a raw native "Maximum call stack size exceeded" a few
   * frames later at some unrelated call site. Override the default if a
   * specific game's legitimate chains run deeper than 64.
   */
  constructor(private readonly maxEmitDepth: number = DEFAULT_MAX_EMIT_DEPTH) {}

  /** Subscribe to one event type. Returns an unsubscribe function. */
  on<T extends GameEventType>(type: T, handler: HandlerFor<T>): Unsubscribe {
    const set = this.handlers.get(type) ?? new Set();
    const wrapped = handler as (event: GameEvent) => void;
    set.add(wrapped);
    this.handlers.set(type, set);
    return () => set.delete(wrapped);
  }

  /** Subscribe to every event, regardless of type. Used by cross-cutting concerns (logging, persistence). */
  onAny(handler: (event: GameEvent) => void): Unsubscribe {
    this.wildcardHandlers.add(handler);
    return () => this.wildcardHandlers.delete(handler);
  }

  emit(event: GameEvent): void {
    if (this.emitDepth >= this.maxEmitDepth) {
      throw new Error(
        `EventBus.emit: exceeded max cascade depth (${this.maxEmitDepth}) emitting "${event.type}". ` +
          `This almost always means a rule or effect handler is re-triggering itself, directly or via a ` +
          `chain, producing an unbounded reaction loop rather than a bounded combo — check for a handler ` +
          `whose mutation unconditionally causes the same (or an equivalent) event to fire again.`,
      );
    }
    this.emitDepth++;
    try {
      for (const handler of this.handlers.get(event.type) ?? []) {
        handler(event);
      }
      for (const handler of this.wildcardHandlers) {
        handler(event);
      }
    } finally {
      this.emitDepth--;
    }
  }
}
