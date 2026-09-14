/**
 * Layer 6 (engine primitive) — PriorityTracker.
 *
 * The one genuinely missing piece from the "priority loop" this engine
 * has been building toward: tracking WHOSE TURN IT IS TO ACT OR PASS,
 * within a phase, separately from whose TURN it is overall (that's
 * TurnCycle's job) and separately from what's pending (that's Stack's).
 * Nothing before this tracked that at all — Stack can rank and resolve
 * pending items the moment it's asked to, but nothing decided WHEN to
 * ask.
 *
 * This class does NOT know about Stack, and Stack does NOT know about
 * this class — they're deliberately independent primitives a room
 * composes together, not a single merged mechanism. That composition
 * has exactly two shapes, and only one of them needs this class at all:
 *
 *   INTERACTIVE phases (main-phase-style): priority starts with the
 *   active player. Each holder either pushes something new onto a Stack
 *   (which resets priority back to the active player — a fresh
 *   proposal means everyone gets a fresh chance to react to it) or
 *   passes (which advances priority to the next seat). Only once every
 *   seat has passed CONSECUTIVELY, with nothing new pushed in between,
 *   does the room actually call Stack.resolveNext() — then priority
 *   resets again, since the board just changed. This class is exactly
 *   that bookkeeping: whose turn to decide is it right now, and have
 *   all seats passed in a row since the last reset.
 *
 *   AUTO-DRAINING phases (upkeep/end-style): push, resolve immediately,
 *   repeat until Stack.size() is 0 — no pause, no players consulted,
 *   ever. This needs NO PriorityTracker at all; it's already fully
 *   expressible with Stack's own existing methods. Reaching for this
 *   class in an auto-draining phase would be a mistake, not a subset of
 *   correct usage.
 *
 * Deliberately NOT built into PhaseDefinition as a "resolution mode"
 * enum, and deliberately not coupled to Stack directly — baking in a
 * fixed set of named modes now would be exactly the kind of premature,
 * rigid decision "stay flexible, don't cover every edge case yet" is
 * warning against. A room composes these two primitives however its
 * own phases actually need to; a THIRD strategy (neither fully
 * interactive nor fully auto-draining) is possible later without an
 * engine change, because nothing here assumes it's the only kind.
 *
 * Whoever currently holds priority is tagged (default: "holds-priority")
 * on their own seat entity — same externalize-as-queryable-state
 * discipline Stack's stackDepth/pushedAtSequence and cyberfixer's own
 * active-turn tag already follow, so a card's timingCondition can check
 * "only when I currently hold priority" as an ordinary BoolExpr, with
 * zero new QueryContext capability.
 */

import type { EntityId } from "../core/id.ts";
import type { EntityStore } from "../events/entity-store.ts";

export class PriorityTracker {
  private holderIndex: number | null = null;
  private consecutivePasses = 0;

  constructor(
    private readonly seatOrder: readonly EntityId[],
    private readonly entities: EntityStore,
    private readonly priorityTag: string = "holds-priority",
  ) {
    if (seatOrder.length === 0) {
      throw new Error("PriorityTracker: seatOrder must have at least one seat");
    }
  }

  /** Throws if reset() hasn't been called yet — there's no meaningful "current holder" before the first round starts, and defaulting to seatOrder[0] would silently assume that's always the right starting seat, which isn't the caller's to assume here. */
  get currentHolder(): EntityId {
    if (this.holderIndex === null) {
      throw new Error("PriorityTracker: reset() must be called at least once before currentHolder is meaningful");
    }
    return this.seatOrder[this.holderIndex]!;
  }

  /**
   * Starts (or restarts) a priority round at `startingWith` — call this
   * whenever something happens that everyone should get a fresh chance
   * to react to: a phase beginning, a new item pushed, or an item just
   * having resolved. Clears the consecutive-pass count, since a fresh
   * round means nobody has passed on THIS state yet.
   */
  reset(startingWith: EntityId): void {
    const index = this.seatOrder.indexOf(startingWith);
    if (index === -1) {
      throw new Error(`PriorityTracker: "${startingWith}" is not in this tracker's seat order`);
    }
    this.holderIndex = index;
    this.consecutivePasses = 0;
    this.syncTag();
  }

  /**
   * The current holder declines to act, advancing priority to the next
   * seat in order. Returns whether EVERY seat has now passed
   * consecutively since the last reset — the caller's own signal that
   * it's actually time to resolve (e.g. call Stack.resolveNext()), not
   * something this class decides or acts on itself.
   */
  pass(): { allPassed: boolean } {
    if (this.holderIndex === null) {
      throw new Error("PriorityTracker: reset() must be called before pass()");
    }
    this.consecutivePasses++;
    const allPassed = this.consecutivePasses >= this.seatOrder.length;
    this.holderIndex = (this.holderIndex + 1) % this.seatOrder.length;
    this.syncTag();
    return { allPassed };
  }

  private syncTag(): void {
    const holder = this.currentHolder;
    for (const seatId of this.seatOrder) {
      if (seatId === holder) this.entities.addTag(seatId, this.priorityTag);
      else this.entities.removeTag(seatId, this.priorityTag);
    }
  }
}
