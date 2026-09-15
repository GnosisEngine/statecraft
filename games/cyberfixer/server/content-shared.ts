/**
 * games/cyberfixer/server/content-shared.ts
 *
 * Everything from content.ts that's genuinely standalone — types,
 * constants, and pure functions that never touch buildContent()'s own
 * closure (entities/bus/seatOrder and the registries built from them).
 * Extracted specifically so a reader (or a future game skimming this
 * one as a worked example) can see what this game's own vocabulary and
 * shape ARE without wading through the 700+ line function that wires
 * it all together — see content.ts's own header for that part.
 */

import type { BoolExpr, CompareOp, NumExpr } from "../../../src/query/types.ts";
import type { EventBus } from "../../../src/events/bus.ts";
import { evaluateNumExpr } from "../../../src/query/interpreter.ts";
import type { QueryFunctionRegistry } from "../../../src/query/functions.ts";
import type { HierarchyRegistry } from "../../../src/query/hierarchy-registry.ts";
import type { Hierarchy } from "../../../src/events/hierarchy.ts";
import type { Stack } from "../../../src/events/stack.ts";
import type { PriorityTracker } from "../../../src/phases/priority-tracker.ts";
import type { Deck } from "./deck.ts";
import type { ActionRegistry } from "../../../src/actions/action-definition.ts";
import type { AbilityRegistry } from "../../../src/actions/activate.ts";
import type { EffectHandlerRegistry } from "../../../src/actions/effect-handler.ts";
import type { PendingActionRegistry } from "../../../src/actions/pending-action-registry.ts";
import type { PhaseDefinition } from "../../../src/phases/phase-definition.ts";
import type { RuleTable } from "../../../src/rules/rule-table.ts";
import type { RuleHandlerRegistry } from "../../../src/rules/rule-handler.ts";
import type { PropertyBoundsRegistry } from "../../../src/properties/property-bounds.ts";
import type { PropertyResolver } from "../../../src/properties/property-resolver.ts";
import { namespacedTag } from "../../../src/core/tags.ts";
import type { EntityStore } from "../../../src/events/entity-store.ts";
import type { EntityId } from "../../../src/core/id.ts";

/** Faction tags — purely descriptive/flavor for this simple example; no faction-specific rules yet. */
export const FACTIONS = ["corporations", "gangs", "shimmer", "politics"] as const;
export type Faction = (typeof FACTIONS)[number];

export const CONTRACTOR_TAG = "contractor";
export const CONTRACT_TAG = "contract";
export const CONTRACT_TYPE_TAG_PREFIX = "contract-type:";

/**
 * This game's own namespaced-tag wrappers, built on the engine's
 * generic namespacedTag — one function per namespace this game
 * actually uses, so every construction site is grep-able by function
 * name (e.g. every call to `abilityTag(...)`) rather than by string
 * pattern, and a typo in the namespace itself (not the id) becomes
 * structurally impossible rather than a silent runtime miss.
 * `pref`/`weak` are deliberately NOT wrapped here — those are engine-
 * level conventions checked directly by `resolvePerformerCapability`
 * (see action-definition.ts), so they use `namespacedTag` there
 * instead of a game-specific wrapper.
 */
export function abilityTag(id: string): string {
  return namespacedTag("ability", id);
}
export function factionTag(faction: Faction): string {
  return namespacedTag("faction", faction);
}

export function discardZoneIdFor(fixerId: EntityId): EntityId {
  return `${fixerId}-discard`;
}

export function boardZoneIdFor(fixerId: EntityId): EntityId {
  return `${fixerId}-board`;
}

export function deckZoneIdFor(fixerId: EntityId): EntityId {
  return `${fixerId}-deck-zone`;
}

export function handZoneIdFor(fixerId: EntityId): EntityId {
  return `${fixerId}-hand-zone`;
}

/** `{op:"compare", left:{op:"prop",name},cmp,right:{op:"lit",value}}` — the shape a bare property-vs-literal check takes now that compare's both sides are full NumExprs. Small helper purely to keep call sites readable. */
export function propertyCompare(name: string, cmp: CompareOp, value: number): BoolExpr {
  return { op: "compare", left: { op: "prop", name }, cmp, right: { op: "lit", value } };
}

/**
 * Only cards actually ON THE BOARD count toward inflow/outflow. This
 * `inZone` check was missing before the hand/deck pipeline existed —
 * every contractor was placed directly in play at setup, so there was
 * never a card sitting anywhere else to expose the gap. The moment a
 * card can sit in a deck or hand (undrawn/undeployed), it would
 * otherwise have silently started contributing to its owner's totals
 * before ever being played.
 */
export function incomeSourcesOwnedBy(fixerId: EntityId): BoolExpr {
  return {
    op: "and",
    exprs: [
      { op: "or", exprs: [{ op: "hasTag", tag: CONTRACTOR_TAG }, { op: "hasTag", tag: CONTRACT_TAG }] },
      { op: "ownedBy", fixerId },
      { op: "inZone", zoneId: boardZoneIdFor(fixerId) },
    ],
  };
}

/** The fold expression for "this fixer's total `prop` across everything they own that's actually on the board." */
export function sumOwnedExpr(fixerId: EntityId, prop: string) {
  return { op: "fold" as const, fold: "sum" as const, of: { op: "prop" as const, name: prop }, where: incomeSourcesOwnedBy(fixerId) };
}

/**
 * Recomputes every fixer's inflow from their current board. Exported
 * standalone (not just a rule handler) because it also needs to run
 * ONCE, explicitly, right after setupMatch and before the turn cycle
 * starts — otherwise the very first phase:started (which resets the
 * first fixer's outflow, bounded by THIS inflow value) would fire before
 * inflow has ever been computed for real, capping outflow at a stale
 * placeholder instead of the actual starting board total.
 */
export function recomputeInflow(seatOrder: readonly EntityId[], entities: EntityStore, resolver: PropertyResolver): void {
  for (const fixerId of seatOrder) {
    const inflow = evaluateNumExpr(sumOwnedExpr(fixerId, "inflow"), fixerId, resolver);
    entities.setProperty(fixerId, "inflow", inflow);
  }
}

// --- contracts -------------------------------------------------------

export interface ContractDefinition {
  id: string;
  basePayout: number;
  /** A BoolExpr, evaluated with the fixer who owns the contract as the ambient subject — e.g. `{op:"compare", left:{op:"fold",fold:"count",where:{op:"hasTag",tag:"ai"}}, cmp:"eq", right:{op:"lit",value:0}}`. */
  bonus?: { when: BoolExpr; amount: number };
  cancelWhen?: BoolExpr;
  cancelPenalty?: { amount: number; durationTurns: number };
}

export class ContractRegistry {
  private defs = new Map<string, ContractDefinition>();
  register(def: ContractDefinition): void {
    this.defs.set(def.id, def);
  }
  get(id: string): ContractDefinition | undefined {
    return this.defs.get(id);
  }
}

export function contractTypeOf(entityTags: ReadonlySet<string>): string | undefined {
  for (const tag of entityTags) {
    if (tag.startsWith(CONTRACT_TYPE_TAG_PREFIX)) return tag.slice(CONTRACT_TYPE_TAG_PREFIX.length);
  }
  return undefined;
}

export interface CyberFixerContent {
  actions: ActionRegistry;
  /** Abilities reached through the single generic "activate" action (registered in `actions`), dispatched by ctx.params.abilityId — e.g. "shakedown". A card grants one by carrying an `ability:<id>` tag. */
  abilities: AbilityRegistry;
  effectHandlers: EffectHandlerRegistry;
  ruleTable: RuleTable;
  ruleHandlers: RuleHandlerRegistry;
  contracts: ContractRegistry;
  queryFunctions: QueryFunctionRegistry;
  bounds: PropertyBoundsRegistry;
  /** What "everyone's ready" means for THIS game — the lobby gate, evaluated against the table. Owned here, not room.ts, since "how many fixers need to ready up" is game content, not composition-root plumbing. */
  pregamePhase: PhaseDefinition;
  /** Trivial for now — no rich postgame content yet, just an immediately-completable stage so Match's lifecycle is whole. */
  postgamePhase: PhaseDefinition;
  /**
   * The three phases within EVERY fixer's turn — upkeep (fully
   * automatic: draw, contract re-evaluation/cancellation, penalty
   * ticking — no player commitments legal here, and per the theme's own
   * "golfer" framing, nothing here is counterable, ever), main (the
   * only phase with agency — deploy/activate are legal here, and this
   * is where the interactive stack/priority loop actually applies), and
   * end (same automatic shape as upkeep — currently no end-of-turn
   * triggers exist, so this phase is honestly a no-op for now, kept for
   * structural completeness). All three share the SAME completionGate
   * (the shared "resolution" stack must be empty) — see stack below.
   */
  turnPhases: PhaseDefinition[];
  /** Phase ids that auto-advance the moment their own completionGate is satisfied — no player message needed, ever. Currently upkeep and end (fully automatic, no commitments legal there); main is deliberately absent — it always waits for an explicit phaseAdvance. */
  autoAdvancingPhaseIds: ReadonlySet<string>;
  /** The Hierarchy underlying `stack` below — exposed separately because Stack itself has no public getter for its own underlying Hierarchy. Needed by room.ts's own Snapshot calls: every Hierarchy a game registers must be passed to createSnapshot/restoreSnapshot, and this one is easy to miss since it's normally only ever touched THROUGH Stack. */
  resolutionHierarchy: Hierarchy;
  /**
   * The ONE stack shared by every phase in a turn — upkeep/end auto-
   * drain it (push, resolve immediately, no pause, ever); main pauses
   * for priority between pushes. Stack itself has no idea which mode
   * applies; that's entirely in how room.ts drives it per phase. See
   * README.md's "Reactive priority" section for the full reasoning.
   */
  stack: Stack;
  /**
   * Moved here (from being constructed directly in room.ts) so effect
   * handlers can be given a reference to it too — see this field's own
   * use in ActionApi/PerformActionDeps for why that needed
   * PendingActionRegistry to exist before room.ts's own deps object was
   * built, not after. room.ts still owns the propose/push/pass/resolve
   * FLOW (this is just the data), and still does its own cleanup
   * (delete + entity removal) once an item resolves or fizzles.
   */
  pendingActions: PendingActionRegistry;
  /** APNAP priority tracking — see PriorityTracker's own docs. Constructed and exposed, but NOT actually used anywhere in room.ts's real message handling: with exactly two fixers and no seating-order rotation requirement at all, main phase's own pass-priority ended up simpler as real content instead (a passed-priority tag per fixer — see this file's own pass-priority section, below). Left available rather than removed, in case a future phase or a different game built on this same content genuinely needs seating-order rotation. */
  priority: PriorityTracker;
  /** "Every fixer has passed" — read by room.ts's own "pass" message handler. A plain fold over the passed-priority tag, reset automatically by content's own rules whenever the shared resolution stack changes (push/resolve/counter/reparent) — see this file's own pass-priority section. */
  allFixersPassed: BoolExpr;
  /**
   * The resolution policy room.ts reads when resolving the shared
   * stack — currently LIFO, ALWAYS, for every match. This is a
   * DELIBERATE STUB, not an oversight: a card that changes the active
   * policy for the rest of a turn ("Escalate the Chain") would need
   * this to become live, per-match, mutable state a card's effect can
   * overwrite — a small registry, similar in shape to
   * PendingActionRegistry, holding "the currently active policy" as one
   * slot room.ts reads from instead of this fixed constant. Confirmed
   * explicitly: stays fixed until a real policy-shifting card actually
   * gets built, not before.
   */
  resolutionPolicy: NumExpr;
  /** The concrete Hierarchy tracking undrawn contractors — needed by room.ts directly for PropertyResolver/PhaseRunnerDeps wiring and Snapshot's hierarchies param. Game CONTENT code should reach for `deck` below instead; this is engine-facing plumbing, not this game's own vocabulary. */
  deckHierarchy: Hierarchy;
  /** deckHierarchy registered under DECK_HIERARCHY_NAME, for query-time childOf/descendantOf use (and threading into PropertyResolver/PhaseRunnerDeps) — read-only from this side. */
  hierarchies: HierarchyRegistry;
  /** "Deck" as THIS GAME's own concept — a thin, named wrapper over deckHierarchy (see deck.ts). What draft/drawCard actually call. */
  deck: Deck;
}

/** Name of the Hierarchy/Stack shared by every phase in a turn. */
export const RESOLUTION_STACK_NAME = "resolution";

/**
 * Everything a section of `buildContent()` might need, bundled so an
 * extracted `register<Section>(ctx)` function can take one parameter
 * instead of a long, easy-to-typo positional list — the same shape
 * `ReflexDeps` already proved out for the engine-level `registerReflex`.
 * Not every section needs every field; a section's own function
 * signature should still only destructure what it actually uses, so a
 * reader can tell what a section touches from its own signature alone,
 * not from this shared bag's full shape.
 */
export interface BuildContext {
  seatOrder: readonly EntityId[];
  entities: EntityStore;
  bus: EventBus;
  actions: ActionRegistry;
  abilities: AbilityRegistry;
  effectHandlers: EffectHandlerRegistry;
  ruleTable: RuleTable;
  ruleHandlers: RuleHandlerRegistry;
  contracts: ContractRegistry;
  queryFunctions: QueryFunctionRegistry;
  bounds: PropertyBoundsRegistry;
  deckHierarchy: Hierarchy;
  deck: Deck;
  hierarchies: HierarchyRegistry;
  resolutionHierarchy: Hierarchy;
  stack: Stack;
  pendingActions: PendingActionRegistry;
  priority: PriorityTracker;
  discardZoneIds: ReadonlySet<EntityId>;
}

