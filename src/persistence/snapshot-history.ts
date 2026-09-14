/**
 * Layer 7 — SnapshotHistory.
 *
 * `room.ts` (and Snapshot itself) only ever kept the SINGLE most recent
 * snapshot — every earlier one is overwritten the moment a new one is
 * taken, which is exactly right for resume/replay (all that's ever needed
 * there is "the newest thing before the fork/crash point"). This class is
 * for a genuinely different purpose: retaining a real HISTORY of
 * snapshots, so a query can ask "what was true as of some earlier
 * moment," not just "what's true now."
 *
 * This is the second of two ways this engine can answer a "what changed"
 * question, and the two are NOT interchangeable — picking the wrong one
 * for a given card is a real design mistake, not a style choice:
 *
 *   - The FIRST, cheaper way (used everywhere else in this engine so
 *     far): a rule stamps a moment into state ONCE, the instant it
 *     happens (pushedAtSequence, ownedSinceTurn, discardedAtTurn), and
 *     the query layer reads that stamp forever after as an ordinary
 *     present-tense fact. Zero storage overhead beyond one property;
 *     answers in O(1). This is the RIGHT tool whenever a card's author
 *     can anticipate, in advance, which moment matters.
 *   - This class: retain actual, complete snapshots of the past, and
 *     let ANY BoolExpr/NumExpr — including ones nobody anticipated when
 *     the game shipped — be evaluated against a frozen prior moment.
 *     Real storage cost (one full Snapshot per retained point), and a
 *     real retention-policy decision (how far back is "back enough").
 *     This is the right tool ONLY for questions genuinely unanticipated
 *     in advance — a card added after the fact that wants to ask
 *     something about history no existing rule ever stamped.
 *
 * Retention is a REQUIRED, explicit choice (maxRetained), not a silent
 * "keep everything forever" default — unbounded retention is a real,
 * available choice (pass Infinity), but it has to be asked for on
 * purpose, the same "no silent, possibly-wrong default" discipline this
 * engine already applies to Snapshot's own hierarchies/stacks params.
 */

import type { Snapshot } from "./snapshot.ts";
import { restoreSnapshot } from "./snapshot.ts";
import { EventBus } from "../events/bus.ts";
import { EntityStore } from "../events/entity-store.ts";
import { Hierarchy } from "../events/hierarchy.ts";
import { Stack } from "../events/stack.ts";
import { ModifierStore } from "../properties/modifier-store.ts";
import { PropertyResolver } from "../properties/property-resolver.ts";
import { HierarchyRegistry } from "../query/hierarchy-registry.ts";
import { evaluateBoolExpr, evaluateNumExpr, type QueryContext } from "../query/interpreter.ts";
import type { BoolExpr, NumExpr } from "../query/types.ts";
import type { EntityId } from "../core/id.ts";
import type { ActionDefinition } from "../actions/action-definition.ts";
import { PendingActionRegistry } from "../actions/pending-action-registry.ts";

export interface SnapshotHistoryOptions {
  /** Maximum number of snapshots to retain at once — the oldest is pruned the instant a new one pushes the count over this. Pass Infinity to keep every snapshot ever taken (a real, explicit choice, not a default). */
  maxRetained: number;
}

export class SnapshotHistory {
  private snapshots: Snapshot[] = []; // kept sorted by atSequence, ascending

  constructor(private readonly options: SnapshotHistoryOptions) {
    if (options.maxRetained < 1) {
      throw new Error(`SnapshotHistory: maxRetained must be at least 1 (got ${options.maxRetained})`);
    }
  }

  /** Records a new snapshot, pruning the oldest retained one(s) if this exceeds maxRetained. Snapshots must be recorded in non-decreasing atSequence order — this class is a history, not a general-purpose sorted set, and enforces that its own record of the past is itself coherent. */
  record(snapshot: Snapshot): void {
    const last = this.snapshots[this.snapshots.length - 1];
    if (last && snapshot.atSequence < last.atSequence) {
      throw new Error(
        `SnapshotHistory.record: snapshot at sequence ${snapshot.atSequence} is older than the most recently recorded one (${last.atSequence}) — snapshots must be recorded in order.`,
      );
    }
    this.snapshots.push(snapshot);
    while (this.snapshots.length > this.options.maxRetained) {
      this.snapshots.shift();
    }
  }

  /**
   * The most recent retained snapshot AT OR BEFORE `sequence` — the
   * honest "as of that moment" answer, since a snapshot might not exist
   * at exactly that sequence (the cadence that schedules snapshots is a
   * separate concern this class doesn't own). Returns undefined if
   * nothing retained goes back that far — either it was pruned by
   * maxRetained, or genuinely predates the first snapshot ever taken.
   * This is a deliberate, honest "we don't know," the same shape as
   * PropertyResolver.getProperty returning undefined for a missing
   * entity — never a thrown error, and never a silent wrong guess.
   */
  at(sequence: number): Snapshot | undefined {
    let best: Snapshot | undefined;
    for (const snap of this.snapshots) {
      if (snap.atSequence <= sequence) best = snap;
      else break;
    }
    return best;
  }

  /** Every currently retained snapshot's own sequence number, oldest first — for introspection and testing, not meant as a query mechanism itself. */
  retainedSequences(): readonly number[] {
    return this.snapshots.map((s) => s.atSequence);
  }
}

/**
 * Which named Hierarchy/Stack instances a game's snapshots reference, and
 * how to look up an ActionDefinition by id — everything
 * materializeHistoricalContext needs to reconstruct a snapshot into a
 * fresh, throwaway set of stores, without knowing anything else about
 * the specific game. `stacks` pairs each Stack's own hierarchy name with
 * the anchor entity it was originally built with — SerializedStack
 * itself never stores the anchor (see stack.ts's own SerializedStack
 * shape), so whoever reconstructs one has to already know it, the same
 * way the live game already does.
 */
export interface HistoricalContextConfig {
  hierarchyNames: readonly string[];
  stacks: readonly { hierarchyName: string; anchorEntityId: EntityId }[];
  lookupAction: (actionId: string) => ActionDefinition | undefined;
}

export interface MaterializedHistoricalContext {
  entities: EntityStore;
  resolver: QueryContext;
}

/**
 * Reconstructs a snapshot into a completely fresh, throwaway set of
 * stores — a new EventBus nothing else ever wires to, new EntityStore/
 * ModifierStore/Hierarchy/Stack instances that exist ONLY for this one
 * read. Nothing here ever touches live game state, and nothing produced
 * by evaluating a query against the result can ever mutate anything —
 * restoreSnapshot's own loadRaw-based restoration fires no entity, hierarchy,
 * or stack event either, so no rule anywhere reacts to this materialization
 * happening at all. This is exactly what makes it safe to call arbitrarily
 * often, from arbitrarily many places, without ever risking cross-
 * contamination with the live match.
 */
export function materializeHistoricalContext(snapshot: Snapshot, config: HistoricalContextConfig): MaterializedHistoricalContext {
  const bus = new EventBus();
  const entities = new EntityStore(bus);
  const modifiers = new ModifierStore(bus);
  const hierarchies = config.hierarchyNames.map((name) => new Hierarchy(name, bus));
  const hierarchyRegistry = new HierarchyRegistry();
  for (const h of hierarchies) hierarchyRegistry.register(h);
  const hierarchiesByName = new Map(hierarchies.map((h) => [h.name, h]));
  const stacks = config.stacks.map(({ hierarchyName, anchorEntityId }) => {
    const hierarchy = hierarchiesByName.get(hierarchyName);
    if (!hierarchy) {
      throw new Error(`materializeHistoricalContext: HistoricalContextConfig's own stacks list names hierarchy "${hierarchyName}", which isn't in hierarchyNames.`);
    }
    return new Stack(hierarchy, entities, bus, anchorEntityId);
  });
  const pendingActionRegistry = new PendingActionRegistry();

  restoreSnapshot(snapshot, entities, modifiers, hierarchies, stacks, pendingActionRegistry, config.lookupAction);

  const resolver = new PropertyResolver(entities, modifiers, undefined, undefined, hierarchyRegistry);
  return { entities, resolver };
}

/**
 * The actual "query the past" entry point: finds the retained snapshot
 * at or before `atSequence`, materializes it into a throwaway context,
 * and evaluates `expr` against it exactly the way it would be evaluated
 * against live state — same interpreter, same grammar, zero special
 * cases. Returns undefined (not a thrown error, and never a guess) if
 * nothing retained goes back that far — see SnapshotHistory.at's own
 * docs for why that's the honest answer, not a failure.
 */
export function evaluatePastBoolExpr(history: SnapshotHistory, atSequence: number, subjectId: EntityId, expr: BoolExpr, config: HistoricalContextConfig): boolean | undefined {
  const snapshot = history.at(atSequence);
  if (!snapshot) return undefined;
  const { resolver } = materializeHistoricalContext(snapshot, config);
  return evaluateBoolExpr(expr, subjectId, resolver);
}

/** NumExpr counterpart to evaluatePastBoolExpr — same reasoning throughout. */
export function evaluatePastNumExpr(history: SnapshotHistory, atSequence: number, subjectId: EntityId, expr: NumExpr, config: HistoricalContextConfig): number | undefined {
  const snapshot = history.at(atSequence);
  if (!snapshot) return undefined;
  const { resolver } = materializeHistoricalContext(snapshot, config);
  return evaluateNumExpr(expr, subjectId, resolver);
}
