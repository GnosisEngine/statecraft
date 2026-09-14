/**
 * Layer 2 (engine primitive) — Stack.
 *
 * A tree of pending, not-yet-resolved items, built on Hierarchy — same
 * relationship Deck (games/cyberfixer/server/deck.ts) has to Hierarchy,
 * but living in the engine, since reactive priority isn't fixer-
 * flavored: any turn-based card game on this engine would want it.
 *
 * This is deliberately a TREE, not a fixed-order chain: a card can
 * respond to ANY currently-pending item, not just the most recent one,
 * so one item can have several simultaneous responses stacked against
 * it. What resolves next is decided separately from the tree's shape —
 * see "resolution policy" below. Two things that look like one
 * mechanism in a plain LIFO stack are genuinely separate here:
 *
 *  - The CAUSAL STRUCTURE (who responded to what) — the tree itself,
 *    unchanged Hierarchy machinery. childOf/descendantOf answer real
 *    relational questions ("is this a direct response to that," "is
 *    this nested inside a response to that, at any depth") with zero
 *    new interpreter surface.
 *  - The RESOLUTION POLICY (given everything currently pending, which
 *    one actually goes next) — a single NumExpr, scored against every
 *    current LEAF (a pending item with nothing responding to it yet).
 *    Whichever leaf scores highest resolves next. LIFO and FIFO are
 *    just two instances of this one rule, not separate mechanisms —
 *    see LIFO_POLICY/FIFO_POLICY below. A card that "seizes control of
 *    resolution order" is ordinary content: it changes which NumExpr a
 *    game reads as the active policy (e.g. a tagged property on the
 *    table), nothing in Stack itself needs to change for that.
 *
 * INVARIANT: a parent never resolves while it still has an unresolved
 * child — you can't finish reacting to something while a reaction to
 * YOUR reaction is still outstanding. This is enforced structurally:
 * resolveNext only ever scores and removes LEAVES. Countering can
 * still target a non-leaf item directly (a "fizzle"-style effect on
 * something deeper), which splices whatever was responding to it up to
 * its own parent — the tree survives, nothing is silently orphaned.
 *
 * pushedAtSequence is a monotonic counter stamped on every pushed item.
 * It is what lets LIFO/FIFO be expressed as ordinary NumExpr reads
 * rather than special-cased traversal directions, and it is the
 * UNCONDITIONAL tie-break every resolution policy inherits for free:
 * whatever a policy scores, ties resolve highest-sequence-first (most
 * recently pushed), so resolution order stays fully deterministic no
 * matter how a custom policy scores leaves — required for replay/fork
 * correctness, the same discipline this entire engine already holds
 * itself to everywhere else.
 *
 * stackDepth:<name> is the same discipline applied to the stack's own
 * aggregate size — a property Stack itself keeps on a caller-supplied
 * anchor entity (see the constructor), updated on every push/resolve/
 * counter (reparent never changes it — it only moves an item, never
 * adds or removes one). This is what lets a card's own timingCondition
 * check "is anything currently pending" as an ordinary BoolExpr, e.g.
 * gating an ability to main-phase windows with nothing on the stack —
 * without Stack needing a new QueryContext capability, just a fact
 * externalized the same way pushedAtSequence already is.
 *
 * Randomness does NOT belong in a resolution policy — NumExpr is
 * deliberately pure (see IR_SPEC.md), and query evaluation has to stay
 * a seed-free function of state for replay to hold. A card wanting
 * "randomize resolution order" is a one-time EFFECT (using
 * api.randomFor, exactly like a deck draw) that writes a priority
 * property onto each currently-pending item; the ongoing policy stays
 * a pure read of whatever that effect wrote. The policy itself never
 * needs to know those values were randomly assigned.
 */

import type { EntityId } from "../core/id.ts";
import { currentOwner } from "../core/entity.ts";
import type { EntityStore } from "./entity-store.ts";
import type { Hierarchy } from "./hierarchy.ts";
import type { EventBus } from "./bus.ts";
import type { NumExpr } from "../query/types.ts";
import { evaluateNumExpr, type QueryContext } from "../query/interpreter.ts";

const EMPTY_STACK_LABELS: ReadonlyMap<string, EntityId> = new Map();

/** The default policy: highest pushedAtSequence resolves first — "most recently pushed," classic stack behavior. */
export const LIFO_POLICY: NumExpr = { op: "prop", name: "pushedAtSequence" };

/** The reverse: lowest raw sequence scores highest (negated), so the OLDEST pending item resolves first — a queue instead of a stack. Same underlying data as LIFO_POLICY, opposite arithmetic; no separate "direction" concept needed anywhere in Stack itself. */
export const FIFO_POLICY: NumExpr = { op: "mul", left: { op: "lit", value: -1 }, right: { op: "prop", name: "pushedAtSequence" } };

/**
 * Wire/snapshot format for one Stack's OWN bookkeeping — deliberately
 * NOT the tree structure itself (that's the underlying Hierarchy's job,
 * already captured by SerializedHierarchy/Snapshot). `pending` is
 * captured explicitly, not recomputed from the restored Hierarchy,
 * because "currently pending" isn't fully recoverable from Hierarchy
 * alone — a resolved or countered item is indistinguishable, from
 * Hierarchy's own point of view, from one that was never pushed at all.
 */
export interface SerializedStack {
  name: string;
  sequenceCounter: number;
  pending: EntityId[];
}

export class Stack {
  private sequenceCounter = 0;
  private pending = new Set<EntityId>();

  constructor(
    private readonly hierarchy: Hierarchy,
    private readonly entities: EntityStore,
    private readonly bus: EventBus,
    /**
     * The entity Stack writes its own summary properties onto —
     * currently just `stackDepth:<name>` (see push/removeInternal).
     * Must already exist in `entities` before any push/resolve/counter
     * call — EntityStore.setProperty throws on an unknown id, same as
     * every other mutation method.
     *
     * This exists specifically so facts like "is anything currently
     * pending" are ordinary queryable entity state (a BoolExpr/NumExpr
     * can read it, e.g. an ActionDefinition.timingCondition gating an
     * ability to "only when nothing is pending") rather than trapped
     * inside this class as private, unqueryable bookkeeping — the same
     * discipline pushedAtSequence already follows, extended to the
     * stack's own aggregate size.
     */
    private readonly anchorEntityId: EntityId,
  ) {}

  /** stackDepth is namespaced by stack name so multiple stacks can share the same anchor entity without colliding — same colon-namespacing convention already used for tags elsewhere (ability:<id>, pref:<category>). */
  private get depthPropertyName(): string {
    return `stackDepth:${this.hierarchy.name}`;
  }

  /** Name of the underlying Hierarchy — included on every emitted event so a rule can filter by which stack, if a game ever has more than one. */
  get name(): string {
    return this.hierarchy.name;
  }

  /** Pushes a new pending item, responding to `parentId` (or null for a fresh, unrelated proposal — a new root). Stamps pushedAtSequence on the item entity itself, and updates the anchor's stackDepth property. */
  push(itemId: EntityId, parentId: EntityId | null): void {
    this.hierarchy.setParent(itemId, parentId);
    this.entities.setProperty(itemId, "pushedAtSequence", this.sequenceCounter++);
    this.pending.add(itemId);
    this.entities.setProperty(this.anchorEntityId, this.depthPropertyName, this.pending.size);
    this.bus.emit({ type: "stack:pushed", stack: this.hierarchy.name, itemId, parentId });
  }

  /** How many items are currently pending, across the whole tree. */
  size(): number {
    return this.pending.size;
  }

  /** Is this specific item currently pending (leaf or not)? Needed by restoreSnapshot's own integrity check — confirming every restored PendingAction actually corresponds to something a restored Stack still considers pending, not a leftover from a corrupted or mismatched snapshot. */
  has(itemId: EntityId): boolean {
    return this.pending.has(itemId);
  }

  /** Every currently pending item with NOTHING responding to it yet — the only valid candidates a resolution policy scores among. A parent with unresolved children is never a candidate; see this file's own header for why. */
  leaves(): EntityId[] {
    return [...this.pending].filter((id) => this.hierarchy.childrenOf(id).length === 0);
  }

  /**
   * Scores every current leaf under `policy` (evaluated with each leaf
   * as its own ambient subject) and resolves (removes) whichever scores
   * highest — ties broken by highest pushedAtSequence, unconditionally
   * (see this file's header). Throws if nothing is pending.
   *
   * Each candidate's evaluation binds "performer" (via LabelScope, the
   * SAME mechanism a fold's `as` already uses — just bound by this
   * caller instead of by a fold) to that candidate's own current owner
   * — the top of its ownership stack, if it has one — so a policy CAN
   * reference `{op:"prop", name:"inflow", subject:{op:"ref",
   * label:"performer"}}` to score by who's behind a pending item, not
   * just the item's own properties. This needed no new grammar and no
   * new EntityRef variant: content pushes an item with `ownership:
   * [performerId]` set (the engine's own NATIVE ownership field,
   * unchanged), and this is simply the first caller to bind a
   * top-level label rather than leaving that mechanism exclusively to
   * folds. A candidate with no owner at all simply doesn't get
   * "performer" bound for its own evaluation — a policy referencing it
   * for that specific candidate throws the same "unbound label" error
   * any other unbound ref would, rather than silently resolving to
   * something arbitrary.
   */
  resolveNext(policy: NumExpr, ctx: QueryContext): EntityId {
    const candidates = this.leaves();
    if (candidates.length === 0) {
      throw new Error(`Stack "${this.hierarchy.name}": nothing pending to resolve`);
    }
    const score = (id: EntityId): number => evaluateNumExpr(policy, id, ctx, this.labelsFor(id));
    let best = candidates[0]!;
    let bestScore = score(best);
    let bestSeq = this.sequenceOf(best);
    for (let i = 1; i < candidates.length; i++) {
      const id = candidates[i]!;
      const candidateScore = score(id);
      const seq = this.sequenceOf(id);
      if (candidateScore > bestScore || (candidateScore === bestScore && seq > bestSeq)) {
        best = id;
        bestScore = candidateScore;
        bestSeq = seq;
      }
    }
    const parentId = this.removeInternal(best);
    this.bus.emit({ type: "stack:resolved", stack: this.hierarchy.name, itemId: best });
    this.maybeEmitExposure(parentId, "stack:exposedAfterResolution");
    return best;
  }

  /** Builds the label scope for evaluating a candidate's own score — currently just "performer", bound to its current owner if it has one. */
  private labelsFor(itemId: EntityId): ReadonlyMap<string, EntityId> {
    const entity = this.entities.get(itemId);
    const owner = entity ? currentOwner(entity) : undefined;
    return owner === undefined ? EMPTY_STACK_LABELS : new Map([["performer", owner]]);
  }

  /** Removes ANY pending item — not necessarily a leaf — without letting it resolve (e.g. a "counter" effect). Whatever was responding to it (if anything) splices up to its own parent; the tree survives structurally intact. Whether a game ALSO wants to cascade-remove everything above it ("fizzle") is a content decision — see games/cyberfixer's own handling for the analogous chain-era case; nothing here decides that automatically. */
  counter(itemId: EntityId): void {
    const parentId = this.removeInternal(itemId);
    this.bus.emit({ type: "stack:countered", stack: this.hierarchy.name, itemId });
    this.maybeEmitExposure(parentId, "stack:exposedAfterCounter");
  }

  /**
   * Moves an already-pending item to respond to a DIFFERENT parent —
   * the primitive that makes cards dynamically restructure the pending
   * tree (not just change resolution order, actually re-route causal
   * structure). Guarded the same way Hierarchy itself is guarded
   * against cycles: newParentId can't be itemId, and can't already be
   * a descendant of itemId (which would make itemId its own ancestor
   * once reparented).
   *
   * Deliberately NO ownership check on either itemId or newParentId —
   * a card can reparent ANY currently-pending item, including an
   * opponent's, under ANY other currently-pending item, including one
   * it doesn't control. Same philosophy as counter(): the engine stays
   * mechanically permissive (valid tree, no cycles), and a specific
   * card's own targetQuery decides who's actually allowed to invoke
   * this against what. "Bury" — reparenting an opponent's leaf under
   * something new so it's temporarily ineligible to resolve — is a
   * real, intended tactic this enables, not an oversight: it's
   * DELAY, not DENIAL (unlike counter, which is permanent), since the
   * buried item is never removed and becomes eligible again the moment
   * whatever's now on top of it clears (the SAME exposure event any
   * other removal fires). And it can't be exploited into an unbounded
   * stall: this phase's own completion requirement is "stackDepth == 0
   * AND both players passed" (see stackDepth's own doc comment) —
   * NEITHER player can advance past this phase while anything remains
   * pending, so a "bury forever" strategy just means the CURRENT
   * phase takes longer to resolve, bounded by both players' finite
   * resources to keep feeding it, never an escape from resolving it
   * at all.
   *
   * newParentId is also NOT required to itself be pending — reparenting
   * under an arbitrary (or even nonexistent) entity is well-defined,
   * if unusual: the item keeps its own leaf-eligibility exactly as
   * before (leaves() only checks whether an item HAS children, never
   * whether its own parent is valid), and simply won't fire an exposure
   * event for that parent later, since maybeEmitExposure only fires for
   * parents this Stack actually tracks as pending.
   */
  reparent(itemId: EntityId, newParentId: EntityId | null): void {
    if (!this.pending.has(itemId)) {
      throw new Error(`Stack "${this.hierarchy.name}": "${itemId}" is not currently on this stack`);
    }
    if (newParentId !== null) {
      if (newParentId === itemId) {
        throw new Error(`Stack "${this.hierarchy.name}": cannot reparent "${itemId}" to itself`);
      }
      if (this.hierarchy.isDescendantOf(newParentId, itemId)) {
        throw new Error(`Stack "${this.hierarchy.name}": reparenting "${itemId}" under "${newParentId}" would create a cycle — "${newParentId}" is already a descendant of "${itemId}"`);
      }
    }
    const oldParentId = this.hierarchy.getParent(itemId) ?? null;
    this.hierarchy.setParent(itemId, newParentId);
    this.bus.emit({ type: "stack:reparented", stack: this.hierarchy.name, itemId, oldParentId, newParentId });
    this.maybeEmitExposure(oldParentId, "stack:exposedAfterReparent");
  }

  private sequenceOf(itemId: EntityId): number {
    return this.entities.get(itemId)?.properties.pushedAtSequence ?? 0;
  }

  /** Removes itemId from the tree, splicing every one of its (zero or more) children up to ITS OWN parent so the rest of the tree survives intact, and updates the anchor's stackDepth property. Called by both resolveNext and counter, so this is the ONE place that needs to keep stackDepth correct — not duplicated in each caller. Returns itemId's former parent, for the caller's own exposure check. */
  private removeInternal(itemId: EntityId): EntityId | null | undefined {
    const parentId = this.hierarchy.getParent(itemId);
    if (parentId === undefined) {
      throw new Error(`Stack "${this.hierarchy.name}": "${itemId}" is not currently on this stack`);
    }
    for (const child of this.hierarchy.childrenOf(itemId)) {
      this.hierarchy.setParent(child, parentId);
    }
    this.hierarchy.remove(itemId);
    this.pending.delete(itemId);
    this.entities.setProperty(this.anchorEntityId, this.depthPropertyName, this.pending.size);
    return parentId;
  }

  /** A parent becomes newly eligible to resolve exactly when its LAST remaining child is removed or moved away — fires the given exposure event only in that exact case, never speculatively. */
  private maybeEmitExposure(parentId: EntityId | null | undefined, eventType: "stack:exposedAfterResolution" | "stack:exposedAfterCounter" | "stack:exposedAfterReparent"): void {
    if (parentId !== null && parentId !== undefined && this.pending.has(parentId) && this.hierarchy.childrenOf(parentId).length === 0) {
      this.bus.emit({ type: eventType, stack: this.hierarchy.name, itemId: parentId });
    }
  }

  /** Captures this Stack's own bookkeeping — NOT the tree structure, which the underlying Hierarchy already serializes separately. Used by Snapshot (Layer 7). */
  serialize(): SerializedStack {
    return { name: this.hierarchy.name, sequenceCounter: this.sequenceCounter, pending: [...this.pending] };
  }

  /**
   * Restores this Stack's own bookkeeping from a snapshot — pair this
   * with restoring the underlying Hierarchy's own state FIRST (the tree
   * structure), since this only restores sequenceCounter/pending, not
   * parent-links. Fires no events — reconstructing prior state isn't a
   * live mutation, same principle as EntityStore/Hierarchy's own
   * loadRaw. Throws on a name mismatch rather than silently loading one
   * stack's data into a differently-named instance.
   */
  loadRaw(data: SerializedStack): void {
    if (data.name !== this.hierarchy.name) {
      throw new Error(`Stack.loadRaw: data is for stack "${data.name}", but this is "${this.hierarchy.name}"`);
    }
    this.sequenceCounter = data.sequenceCounter;
    this.pending = new Set(data.pending);
  }
}
