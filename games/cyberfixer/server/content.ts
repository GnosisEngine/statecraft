/**
 * games/cyberfixer/server/content.ts — Layer 10 content.
 *
 * Everything here is built entirely out of Layers 0-9 — this file IS the
 * "cyberpunk fixer" game the whole engine was originally motivated by.
 *
 * BoolExpr/NumExpr (Layer 1) replaced the earlier Query/Aggregate split
 * outright. That split had a real, felt cost HERE specifically:
 * `ContractCondition` ({ countWhere, cmp, value }) used to exist as a
 * bespoke, content-level reinvention of "compare a count against a
 * threshold" — built because Query couldn't reference an Aggregate
 * directly. It doesn't exist anymore: a contract's condition is just a
 * plain BoolExpr now (`{ op: "compare", left: { op: "fold", fold:
 * "count", where }, cmp, right: { op: "lit", value } }`), because
 * BoolExpr can hold a fold directly. See ContractDefinition below.
 *
 * Comparing two properties (e.g. "how many turns since this card was
 * discarded") still needs the `call` op — that's arithmetic derived from
 * something the grammar doesn't reach on its own (a stored turn number
 * versus the live current one), not something add/sub alone resolves,
 * since "current turn" isn't a property on the card itself. See
 * hasBeenDiscardedForXTurns below.
 *
 * CONTRACTS: a Contract card generates inflow conditionally — a base
 * payout, an optional bonus while some condition holds, and an optional
 * cancellation: if a DIFFERENT condition trips, the contract is
 * discarded outright and its owner takes a penalty for a fixed number of
 * turns. A new contract type is a new registry entry, not new rule code.
 *
 * OUTFLOW is a per-turn SPEND BUDGET, not a passive drain: it resets at
 * the start of each fixer's own turn to the sum of their in-play cards'
 * `outflowGrant`, and is spent down as actions are performed (shakedown's
 * cost now draws from `outflow`, not a separate resource pool — there
 * isn't one anymore). It's bounded above by that fixer's current inflow
 * via a PropertyBound registered right here in game content — the engine
 * (PropertyBoundsRegistry) has no idea what "inflow" or "outflow" even
 * mean, it just knows how to cap one named property against another.
 * "outflow" and "outflowGrant" are deliberately different property names:
 * the fixer's spendable total vs. how much one card contributes to it.
 *
 * HAND/DECK/DRAW: each fixer's deck (games/cyberfixer/server/deck.ts,
 * wrapping the engine's Hierarchy) is an unordered pool in an owner-only
 * zone — no draw order exists until the literal moment of drawing (see
 * Deck.draw). "draft" (a one-time, free, untimed action — no
 * timingCondition at all, since it's a pregame choice, not a turn
 * action) lets a fixer pick exactly 3 cards from their OWN deck straight
 * onto their board. From then on, "draw-card" (a rule, not a player
 * action — automatic, once per turn) draws one card at random from the
 * remaining pool into hand, and "deploy" (a player action, costing
 * outflow) moves a card from hand onto the board. A card only ever
 * contributes to inflow/
 * outflow once it's actually ON THE BOARD — see incomeSourcesOwnedBy's
 * `inZone` check below, which didn't exist before this pipeline, because
 * every card started already in play and there was nothing else it
 * needed to exclude.
 *
 * LOBBY: Match's pregame stage (Layer 6, previously unused here) now
 * gates the turn cycle behind a real lobby — "ready" requires having
 * drafted first, and the pregame phase's completion gate (readyCount >=
 * every seat) only opens once ALL fixers have readied up. This is what
 * fixes the earlier race: draw-card can't fire before a fixer has
 * drafted, because playing (and its first phase:started) can't begin
 * until everyone already has.
 *
 * DECK DRAWS use a Hierarchy (not the engine's Deck/cardOrder — that's
 * still a valid primitive, just not the right one HERE): each undrawn
 * contractor is classified under its owning fixer with NO siblingIndex,
 * an unordered pool. Drawing is Hierarchy.drawRandom, which picks
 * uniformly and removes the drawn entity — no concrete draw order is
 * EVER computed or stored for the remainder, so nothing (a memory read,
 * a snapshot) can reveal what's coming before it's actually drawn. Each
 * fixer's draws use their OWN isolated RandomRegistry domain
 * (`${fixerId}:deck`, derived from the match's one seed) specifically so
 * the order/timing of unrelated random-consuming actions anywhere else
 * in the match can never perturb what a fixer's own deck produces next.
 */

import type { BoolExpr, CompareOp, NumExpr } from "../../../src/query/types.ts";
import { evaluateBoolExpr, evaluateNumExpr } from "../../../src/query/interpreter.ts";
import { QueryFunctionRegistry } from "../../../src/query/functions.ts";
import { HierarchyRegistry } from "../../../src/query/hierarchy-registry.ts";
import { Hierarchy } from "../../../src/events/hierarchy.ts";
import { Stack, LIFO_POLICY } from "../../../src/events/stack.ts";
import { PriorityTracker } from "../../../src/phases/priority-tracker.ts";
import { Deck, DECK_HIERARCHY_NAME, deckRandomDomain } from "./deck.ts";
import type { EventBus } from "../../../src/events/bus.ts";
import type { ActionDefinition } from "../../../src/actions/action-definition.ts";
import { ActionRegistry } from "../../../src/actions/action-definition.ts";
import { createAbilityRegistry, buildActivateAction, buildActivateEffectHandler, type AbilityRegistry } from "../../../src/actions/activate.ts";
import { EffectHandlerRegistry } from "../../../src/actions/effect-handler.ts";
import { ALWAYS_TRUE_QUERY, type PhaseDefinition } from "../../../src/phases/phase-definition.ts";
import { RuleTable } from "../../../src/rules/rule-table.ts";
import { RuleHandlerRegistry } from "../../../src/rules/rule-handler.ts";
import { newModifierId } from "../../../src/properties/modifier.ts";
import { PropertyBoundsRegistry } from "../../../src/properties/property-bounds.ts";
import type { PropertyResolver } from "../../../src/properties/property-resolver.ts";
import { currentOwner } from "../../../src/core/entity.ts";
import type { EntityStore } from "../../../src/events/entity-store.ts";
import type { EntityId } from "../../../src/core/id.ts";

/** Faction tags — purely descriptive/flavor for this simple example; no faction-specific rules yet. */
export const FACTIONS = ["corporations", "gangs", "shimmer", "politics"] as const;
export type Faction = (typeof FACTIONS)[number];

export const CONTRACTOR_TAG = "contractor";
export const CONTRACT_TAG = "contract";
export const CONTRACT_TYPE_TAG_PREFIX = "contract-type:";

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
function propertyCompare(name: string, cmp: CompareOp, value: number): BoolExpr {
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
function incomeSourcesOwnedBy(fixerId: EntityId): BoolExpr {
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
function sumOwnedExpr(fixerId: EntityId, prop: string) {
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

function contractTypeOf(entityTags: ReadonlySet<string>): string | undefined {
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
  /** APNAP priority tracking for main phase's interactive stack use — see PriorityTracker's own docs. Unused during upkeep/end, which never consult it at all. */
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

/** Builds fresh, independent registries — call once per room/match, never shared across matches. `bus` is needed because deckHierarchy/the resolution Stack (Layer 2) announce their own mutations on it, same as EntityStore/ModifierStore do. `entities` is needed because Stack/PriorityTracker externalize their own bookkeeping (pushedAtSequence, stackDepth, priority tags) as real entity state — see each one's own docs for why. */
export function buildContent(seatOrder: readonly EntityId[], bus: EventBus, entities: EntityStore): CyberFixerContent {
  const actions = new ActionRegistry();
  const abilities = createAbilityRegistry();
  const effectHandlers = new EffectHandlerRegistry();
  const ruleTable = new RuleTable("cyberfixer-rules");
  const ruleHandlers = new RuleHandlerRegistry();
  const contracts = new ContractRegistry();
  const queryFunctions = new QueryFunctionRegistry();
  const bounds = new PropertyBoundsRegistry();
  const deckHierarchy = new Hierarchy(DECK_HIERARCHY_NAME, bus);
  const deck = new Deck(deckHierarchy);
  const hierarchies = new HierarchyRegistry();
  hierarchies.register(deckHierarchy);
  const resolutionHierarchy = new Hierarchy(RESOLUTION_STACK_NAME, bus);
  hierarchies.register(resolutionHierarchy);
  // "table-1" is the SAME anchor turnCounter/readyCount already live on
  // (see setup.ts) — setupMatch runs AFTER buildContent, but neither
  // Stack nor PriorityTracker write anything until actually used
  // (push/resolveNext/counter/reparent, reset/pass respectively), so
  // constructing them before "table-1" exists is safe; only USING them
  // requires it to already exist, which setupMatch guarantees by then.
  const stack = new Stack(resolutionHierarchy, entities, bus, "table-1");
  const priority = new PriorityTracker(seatOrder, entities);
  const resolutionPolicy: NumExpr = LIFO_POLICY;
  bounds.set("outflow", { min: 0, max: { refProp: "inflow" } });

  const discardZoneIds = new Set(seatOrder.map(discardZoneIdFor));

  // --- shakedown (an ABILITY, reached through the generic "activate"
  // action — see games/cyberfixer/server/content.ts's header and
  // src/actions/activate.ts) ------------------------------------------

  const shakedown: ActionDefinition = {
    id: "shakedown",
    category: () => "coercion",
    targetsOwn: false,
    targetsOthers: true,
    minTargets: () => 1,
    maxTargets: () => 1,
    targetQuery: (ctx) => ({
      op: "and",
      exprs: [
        { op: "hasTag", tag: CONTRACTOR_TAG },
        { op: "not", expr: { op: "ownedBy", fixerId: ctx.actingFixerId } },
        // Same fix as incomeSourcesOwnedBy above: a contractor still
        // sitting in an opponent's deck or hand isn't a legal target —
        // only one actually on SOME board (in play) is.
        { op: "or", exprs: seatOrder.map((fixerId) => ({ op: "inZone" as const, zoneId: boardZoneIdFor(fixerId) })) },
      ],
    }),
    // hasTag: CONTRACTOR_TAG stays here (on TOP of activate's own
    // ability:shakedown tag check) deliberately — belt-and-suspenders,
    // same reasoning as the ownership check every other action gets:
    // an entity could in principle carry ability:shakedown without
    // being a contractor (a future card kind), and this keeps that
    // case out even though nothing today would trigger it.
    performerCondition: () => ({ op: "hasTag", tag: CONTRACTOR_TAG }),
    // active-turn alone isn't enough — it stays true through upkeep AND
    // end too, not just main. phase:main (see sync-current-phase above)
    // is what actually enforces "agency only in main phase": without
    // it, nothing stopped a shakedown from being proposed during
    // upkeep, before this gap was caught.
    timingCondition: (ctx) => ({ op: "and", exprs: [{ op: "hasTag", tag: "active-turn", subject: ctx.actingFixerId }, duringMainPhase] }),
    cost: () => ({ prop: "outflow", amount: 4 }),
    effect: "shakedownEffect",
  };
  abilities.register(shakedown);

  // The ONE generic entry point every ability (shakedown, and whatever
  // gets added later) is actually reached through — see
  // src/actions/activate.ts for what this dispatches and why.
  actions.register(buildActivateAction(abilities));
  effectHandlers.register("activateEffect", buildActivateEffectHandler(abilities, effectHandlers));

  effectHandlers.register("shakedownEffect", (ctx, api) => {
    const targetId = ctx.targetIds[0]!;
    api.entities.addTag(targetId, "shaken");
    api.modifiers.add({
      id: newModifierId(),
      targetEntityId: targetId,
      prop: "inflow",
      op: "add",
      value: -3,
      priority: 0,
      source: "shakedown",
    });
  });

  // --- draft: pregame, pick exactly 3 cards from your own deck straight onto your board ---

  const draft: ActionDefinition = {
    id: "draft",
    category: () => "setup",
    targetsOwn: true,
    targetsOthers: false,
    minTargets: () => 3,
    maxTargets: () => 3,
    targetQuery: (ctx) => ({
      op: "and",
      exprs: [
        { op: "or", exprs: [{ op: "hasTag", tag: CONTRACTOR_TAG }, { op: "hasTag", tag: CONTRACT_TAG }] },
        { op: "inZone", zoneId: deckZoneIdFor(ctx.actingFixerId) },
      ],
    }),
    // performerId is the FIXER itself (self-owned — see setup.ts) since
    // there's no natural contractor to perform a meta-level "choose your
    // starting lineup" action through. Guarded against re-drafting once
    // already done.
    performerCondition: () => ({ op: "not", expr: { op: "hasTag", tag: "drafted" } }),
    // Explicit, not just incidentally true from tag state — "any action
    // that can fire needs to be gated by phase," the same principle
    // that caught deploy/shakedown being usable outside main. Belt-and-
    // suspenders here too: re-drafting is ALREADY blocked by the
    // "drafted" tag once a fixer has drafted, but stating the phase
    // restriction explicitly means this stays correct even if that tag
    // logic ever changes, rather than being an accident of it.
    timingCondition: () => ({ op: "hasTag", tag: "phase:pregame", subject: "table-1" }),
    effect: "draftEffect",
  };
  actions.register(draft);

  effectHandlers.register("draftEffect", (ctx, api) => {
    for (const cardId of ctx.targetIds) {
      deck.removeFromPool(cardId); // no longer part of the draw pool
      api.entities.moveToZone(cardId, boardZoneIdFor(ctx.actingFixerId));
    }
    api.entities.addTag(ctx.performerId, "drafted");
    // Belt-and-suspenders now that "ready" (below) requires "drafted"
    // first and Match's pregame gate requires ALL fixers ready before
    // playing begins — by the time the first real turn starts, every
    // fixer has already drafted, so the per-turn phase:started reset
    // would compute the same thing anyway. Kept for robustness in case
    // that invariant is ever violated (e.g. a future action bypasses it).
    resetOutflowFor(ctx.actingFixerId, api.entities, api.resolver);
  });

  // --- ready: pregame lobby — once every fixer has readied up (and only after drafting), the match begins ---

  const ready: ActionDefinition = {
    id: "ready",
    category: () => "setup",
    targetsOwn: false,
    targetsOthers: false,
    minTargets: () => 0,
    maxTargets: () => 0,
    targetQuery: () => ({ op: "kindIs", kind: "card" }), // unused — ready takes no targets
    performerCondition: () => ({
      op: "and",
      exprs: [{ op: "hasTag", tag: "drafted" }, { op: "not", expr: { op: "hasTag", tag: "ready" } }],
    }),
    // Same reasoning as draft's own timingCondition above.
    timingCondition: () => ({ op: "hasTag", tag: "phase:pregame", subject: "table-1" }),
    effect: "readyEffect",
  };
  actions.register(ready);

  effectHandlers.register("readyEffect", (ctx, api) => {
    api.entities.addTag(ctx.performerId, "ready");
    const current = api.resolver.getProperty("table-1", "readyCount") ?? 0;
    api.entities.setProperty("table-1", "readyCount", current + 1);
  });

  const pregamePhase: PhaseDefinition = {
    id: "pregame",
    gateSubject: "table",
    completionGate: propertyCompare("readyCount", "gte", seatOrder.length),
  };
  const postgamePhase: PhaseDefinition = { id: "postgame", gateSubject: "table", completionGate: ALWAYS_TRUE_QUERY };

  // All three turn phases share this gate: none of them can complete
  // while anything remains pending on the shared resolution stack. For
  // upkeep/end this is mostly a defensive check (room.ts auto-drains
  // BEFORE attempting to advance those phases, so it's already empty by
  // construction) — for main, this IS the real gate, since main's stack
  // is interactive and only drains when both fixers actually pass.
  const resolutionStackEmpty: BoolExpr = propertyCompare(`stackDepth:${RESOLUTION_STACK_NAME}`, "eq", 0);
  // Shared by every action/ability whose timingCondition needs "we are
  // currently in main phase" — extracted specifically so future cards
  // reuse this instead of hand-writing the tag check themselves. That
  // hand-written duplication is exactly what let deploy/shakedown go
  // unnoticed as usable outside main for as long as they did — a single
  // shared constant is easier to get right by example than a pattern
  // each new ability's author has to remember and re-derive correctly.
  const duringMainPhase: BoolExpr = { op: "hasTag", tag: "phase:main", subject: "table-1" };
  const upkeepPhase: PhaseDefinition = { id: "upkeep", gateSubject: "activeFixer", completionGate: resolutionStackEmpty };
  const mainPhase: PhaseDefinition = { id: "main", gateSubject: "activeFixer", completionGate: resolutionStackEmpty };
  const endPhase: PhaseDefinition = { id: "end", gateSubject: "activeFixer", completionGate: resolutionStackEmpty };
  const turnPhases: PhaseDefinition[] = [upkeepPhase, mainPhase, endPhase];
  const autoAdvancingPhaseIds: ReadonlySet<string> = new Set(["upkeep", "end"]);

  // --- deploy: play a card from hand onto your board, spending outflow ---

  const deploy: ActionDefinition = {
    id: "deploy",
    category: () => "logistics",
    targetsOwn: false,
    targetsOthers: false,
    minTargets: () => 0,
    maxTargets: () => 0,
    targetQuery: () => ({ op: "kindIs", kind: "card" }), // unused — deploy takes no targets
    performerCondition: () => ({
      op: "and",
      exprs: [
        { op: "or", exprs: [{ op: "hasTag", tag: CONTRACTOR_TAG }, { op: "hasTag", tag: CONTRACT_TAG }] },
        { op: "or", exprs: seatOrder.map((fixerId) => ({ op: "inZone" as const, zoneId: handZoneIdFor(fixerId) })) },
      ],
    }),
    cost: () => ({ prop: "outflow", amount: 2 }),
    timingCondition: (ctx) => ({ op: "and", exprs: [{ op: "hasTag", tag: "active-turn", subject: ctx.actingFixerId }, duringMainPhase] }),
    effect: "deployEffect",
  };
  actions.register(deploy);

  effectHandlers.register("deployEffect", (ctx, api) => {
    api.entities.moveToZone(ctx.performerId, boardZoneIdFor(ctx.actingFixerId));
  });

  // --- contracts: recompute, cancel + discard, expire the penalty --

  // Runs BEFORE recompute-fixer-metrics (lower priority number = earlier)
  // so a contract's own inflow is current by the time fixer totals sum
  // it. Deliberately bound to phase:started (scoped to upkeep), NOT
  // action:resolved — this used to recompute continuously, after every
  // single action, anywhere in the match. The phase design settled on
  // something different: contracts are a DISCRETE, PREDICTABLE reckoning
  // that happens once per turn, at upkeep, not a live reaction to
  // whatever just happened. A contract flipping against you is the
  // theme's own "infinite risk" made mechanical — and per upkeep's own
  // "golfer" framing (once the ball's in the air, physics has it, no
  // response is possible), this is also why cancellation is
  // uncounterable: it never goes through the stack at all, upkeep has
  // no pause to interject into in the first place.
  ruleTable.add({ id: "recompute-contracts", trigger: "phase:started", match: (event) => event.phaseId === "upkeep", priority: 0, effect: "recomputeContracts" });
  ruleHandlers.register("recomputeContracts", (_event, api) => {
    for (const contract of api.entities.getAllEntities()) {
      if (!contract.tags.has(CONTRACT_TAG)) continue;
      if (contract.properties.discardedAt !== undefined) continue; // already discarded — resolved, don't reprocess

      const typeId = contractTypeOf(contract.tags);
      const def = typeId ? contracts.get(typeId) : undefined;
      if (!def) continue;

      if (def.cancelWhen && evaluateBoolExpr(def.cancelWhen, contract.id, api.resolver)) {
        api.entities.setProperty(contract.id, "inflow", 0); // stop contributing to the aggregate immediately, regardless of what follows
        const ownerId = currentOwner(contract);
        if (ownerId) {
          if (def.cancelPenalty) {
            api.modifiers.add({
              id: newModifierId(),
              targetEntityId: ownerId,
              prop: "inflow",
              op: "add",
              value: def.cancelPenalty.amount,
              priority: 0,
              source: `contract-cancel:${contract.id}`,
            });
          }
          api.entities.moveToZone(contract.id, discardZoneIdFor(ownerId)); // triggers stamp-discarded-at below
        }
        continue;
      }

      let payout = def.basePayout;
      if (def.bonus && evaluateBoolExpr(def.bonus.when, contract.id, api.resolver)) payout += def.bonus.amount;
      api.entities.setProperty(contract.id, "inflow", payout);
    }
  });

  ruleTable.add({
    id: "recompute-fixer-inflow",
    trigger: "action:resolved",
    priority: 10,
    effect: "recomputeFixerInflow",
  });
  ruleHandlers.register("recomputeFixerInflow", (_event, api) => {
    recomputeInflow(seatOrder, api.entities, api.resolver);
  });

  /**
   * Shared by both the per-turn reset rule below AND draft's effect
   * handler. Necessary because of a real sequencing gap: turnCycle.start()
   * fires the very first phase:started (which normally resets outflow)
   * before either client has even connected, let alone drafted — so that
   * first reset always computes 0 (nothing's on the board yet). Without
   * this, a fixer who drafts afterward would be stuck at 0 outflow until
   * their turn genuinely comes around again.
   */
  function resetOutflowFor(fixerId: EntityId, entities: EntityStore, resolver: PropertyResolver): void {
    const grant = evaluateNumExpr(sumOwnedExpr(fixerId, "outflowGrant"), fixerId, resolver);
    entities.setProperty(fixerId, "outflow", grant);
  }

  // Deliberately its OWN rule on a DIFFERENT trigger from inflow — outflow
  // is a per-turn SPEND BUDGET, not a passively-recalculated total. If it
  // were recomputed after every action (like inflow), spending it down
  // via an action's cost would get immediately overwritten by the next
  // recompute. It only resets at the START of the fixer whose turn it is
  // — phase:started's own subjectId IS that fixer (gateSubject:
  // "activeFixer"), so no extra filtering is needed to target the right
  // one. The stored value can exceed inflow; outflow's PropertyBound
  // (registered above) is what actually caps what anything ever READS.
  ruleTable.add({ id: "reset-outflow-budget", trigger: "phase:started", match: (event) => event.phaseId === "upkeep", effect: "resetOutflowBudget" });
  ruleHandlers.register("resetOutflowBudget", (event, api) => {
    const e = event as Extract<typeof event, { type: "phase:started" }>;
    resetOutflowFor(e.subjectId, api.entities, api.resolver);
  });

  // Tags exactly the newly-active fixer with "active-turn" (used by
  // timingCondition on deploy/shakedown, and by anything else that
  // needs to know whose turn it is) and untags everyone else. This USED
  // to be a private method on CyberFixerRoom, called manually at two
  // call sites — moved here so ANY rig sharing this same RuleEngine
  // (a test rig, room.ts, anything else) gets it automatically as a
  // real consequence of phase:started firing, rather than every caller
  // needing to remember a bespoke sync step. A real bug was caught by
  // this move: a test rig using a genuine Match/TurnCycle without going
  // through CyberFixerRoom's own tagging method silently never set
  // "active-turn" at all, which meant every shakedown attempt in that
  // rig was silently rejected — the test still passed, because it never
  // checked the actual outcome of that specific action. See
  // determinism.test.ts's own hardened assertions for the fix on that
  // side.
  ruleTable.add({ id: "sync-active-turn", trigger: "phase:started", match: (event) => event.phaseId === "upkeep", effect: "syncActiveTurn" });
  ruleHandlers.register("syncActiveTurn", (event, api) => {
    const e = event as Extract<typeof event, { type: "phase:started" }>;
    for (const fixerId of seatOrder) {
      if (fixerId === e.subjectId) api.entities.addTag(fixerId, "active-turn");
      else api.entities.removeTag(fixerId, "active-turn");
    }
  });

  // Deliberately UNSCOPED (fires on every phase transition, not just
  // upkeep) — this needs to reflect whichever phase is CURRENTLY active
  // at all times, not just once per turn. Externalizes something that
  // was previously only in-memory (TurnCycle.currentPhase, a plain
  // getter with no query-time visibility at all) as a real, queryable
  // tag on the table — the SAME externalize-as-entity-state discipline
  // every other piece of engine bookkeeping in this game already
  // follows (active-turn, stackDepth, pushedAtSequence). This is what
  // makes "agency only in main phase" an ENFORCED rule rather than a
  // design intention nothing actually checks: deploy/shakedown's own
  // timingCondition below reads this tag directly.
  ruleTable.add({ id: "sync-current-phase", trigger: "phase:started", effect: "syncCurrentPhase" });
  ruleHandlers.register("syncCurrentPhase", (event, api) => {
    const e = event as Extract<typeof event, { type: "phase:started" }>;
    // Covers ALL FIVE phase ids that can ever fire phase:started — not
    // just the three turn phases. pregame/postgame are real PhaseRunner
    // instances too (see Match's own constructor), so they fire this
    // event exactly the same way — leaving them out here would mean
    // "table-1" carries NO phase:<id> tag at all during pregame, an
    // absence a card author could easily miss when writing a
    // timingCondition that tries to gate "pregame only" (draft/ready)
    // against a tag that was never actually being set.
    for (const phaseId of ["pregame", "upkeep", "main", "end", "postgame"]) {
      if (phaseId === e.phaseId) api.entities.addTag("table-1", `phase:${phaseId}`);
      else api.entities.removeTag("table-1", `phase:${phaseId}`);
    }
  });

  // --- pass-priority: the simplified, non-rotating pass mechanism for
  // the shared "resolution" stack ---------------------------------------
  //
  // Deliberately NOT strict APNAP (see PriorityTracker, an available but
  // unused engine primitive) — either fixer may pass or propose a new
  // response at any moment, in any order; a plain "who has passed" tag
  // plus a fold counting who hasn't is the whole mechanism. What's below
  // is JUST the reset half — clearing that tag whenever something
  // changes and both fixers should get a fresh chance to react.
  //
  // Bound to all FOUR primary stack mutation events (pushed, resolved,
  // countered, reparented) — not just "something new was exposed."
  // Binding only to the exposedAfter* variants was the version that
  // shipped a real bug ("Filibuster"): if A resolves and exposes NOTHING
  // new (a standalone root with no parent), the exposedAfter events
  // never fire at all, so passed-priority would never clear, and
  // whatever's next would silently auto-resolve without either fixer
  // ever getting a chance to react to the board having just changed.
  // Binding to the PRIMARY events instead covers that case for free —
  // "the board changed" is true any time something resolves, is
  // countered, or is reparented, regardless of what that happens to
  // expose.
  for (const trigger of ["stack:pushed", "stack:resolved", "stack:countered", "stack:reparented"] as const) {
    ruleTable.add({ id: `reset-priority-on-${trigger}`, trigger, effect: "resetPriorityPass" });
  }
  ruleHandlers.register("resetPriorityPass", (_event, api) => {
    for (const fixerId of seatOrder) api.entities.removeTag(fixerId, "passed-priority");
  });

  /** "Every fixer has passed" — a plain fold, not a stateful counter. Read by room.ts's own "pass" message handler to decide whether to resolve now. */
  const allFixersPassed: BoolExpr = {
    op: "compare",
    left: {
      op: "fold",
      fold: "count",
      where: { op: "and", exprs: [{ op: "kindIs", kind: "hand" }, { op: "not", expr: { op: "hasTag", tag: "passed-priority" } }] },
    },
    cmp: "eq",
    right: { op: "lit", value: 0 },
  };

  // --- has-active-response: "does anything currently respond to me" as an
  // ordinary, queryable tag ------------------------------------------------
  //
  // The direct answer to "Surveillance State"'s own design question — a
  // targetQuery like {op:"not", expr:{op:"hasTag", tag:"has-active-response"}}
  // is exactly as expressible as active-turn/phase:main/passed-priority
  // already are, once this tag is correctly maintained. This is Option 1
  // from that design discussion: externalize the fact as a maintained tag,
  // not a grammar extension (Option 3) or a registered QueryFunction
  // (Option 2) — cheapest, and the same shape every other cross-cutting
  // fact in this game already uses.
  //
  // Bound to hierarchy:parentChanged directly, NOT stack:pushed/
  // stack:reparented — this is deliberate, and it's the one real subtlety
  // here worth explaining. Stack.counter() on a NON-leaf item with
  // multiple children splices every one of them up to the grandparent by
  // calling Hierarchy.setParent directly (see stack.ts's own
  // removeInternal) — which fires hierarchy:parentChanged for each
  // spliced child, but does NOT fire stack:pushed or stack:reparented at
  // all for that step. A rule bound only to those two events would
  // silently miss every splice-caused "this entity just gained a
  // response" case — exactly the kind of gap "Filibuster" already taught
  // this game to watch for once. hierarchy:parentChanged fires
  // uniformly for every setParent call underneath ALL of push/reparent/
  // splice, so binding here catches every case by construction rather
  // than by enumerating each Stack method that could cause it.
  ruleTable.add({
    id: "sync-has-active-response-on-parent-change",
    trigger: "hierarchy:parentChanged",
    match: (event) => event.hierarchy === RESOLUTION_STACK_NAME && event.parentId !== null && event.parentId !== undefined,
    effect: "tagHasActiveResponse",
  });
  ruleHandlers.register("tagHasActiveResponse", (event, api) => {
    const e = event as Extract<typeof event, { type: "hierarchy:parentChanged" }>;
    // match() already guarantees parentId is a real EntityId here.
    api.entities.addTag(e.parentId as EntityId, "has-active-response");
  });

  // The untagging half: a parent becomes newly childless EXACTLY when one
  // of the three exposure events fires for it (see stack.ts's own
  // maybeEmitExposure) — that's already the precise "this item just lost
  // its LAST child" signal, so there's no need to separately recompute
  // child counts here.
  //
  // One honest gap: an item removed (resolved/countered) while it STILL
  // had its own children (i.e. it was mid-tree, not a leaf) keeps its OWN
  // "has-active-response" tag stale — the exposure event that fires is
  // about ITS parent (which may still have other children after the
  // splice, and so may not even fire at all), never about the removed
  // item itself. Harmless in real play: room.ts always fully removes a
  // pending-item placeholder entity from EntityStore once it resolves or
  // is countered, so a stale tag on an entity that no longer exists can
  // never be observed by anything. See content.test.ts's own "THE SPLICE
  // CASE" test for the precise trace.
  for (const trigger of ["stack:exposedAfterResolution", "stack:exposedAfterCounter", "stack:exposedAfterReparent"] as const) {
    ruleTable.add({ id: `untag-has-active-response-on-${trigger}`, trigger, effect: "untagHasActiveResponse" });
  }
  ruleHandlers.register("untagHasActiveResponse", (event, api) => {
    const e = event as Extract<typeof event, { type: "stack:exposedAfterResolution" | "stack:exposedAfterCounter" | "stack:exposedAfterReparent" }>;
    api.entities.removeTag(e.itemId, "has-active-response");
  });

  // Automatic — a rule, not a player action. Gated on "drafted" so a
  // fixer's very first turn doesn't draw a card into hand before they've
  // even chosen their starting 3.
  ruleTable.add({
    id: "draw-card",
    trigger: "phase:started",
    match: (event) => event.phaseId === "upkeep",
    subject: (event) => event.subjectId,
    condition: { op: "hasTag", tag: "drafted" },
    effect: "drawCard",
  });
  ruleHandlers.register("drawCard", (event, api) => {
    const e = event as Extract<typeof event, { type: "phase:started" }>;
    if (!api.randomFor) {
      throw new Error("drawCard: no RandomRegistry was wired in — cannot draw without this fixer's isolated deck stream");
    }
    const drawnId = deck.draw(e.subjectId, api.randomFor(deckRandomDomain(e.subjectId)));
    if (!drawnId) return; // empty deck, no-op
    api.entities.moveToZone(drawnId, handZoneIdFor(e.subjectId));
  });

  ruleTable.add({
    id: "stamp-discarded-at",
    trigger: "entity:zoneChanged",
    match: (event) => discardZoneIds.has(event.newZoneId ?? ""),
    subject: (event) => event.entityId,
    effect: "stampDiscardedAt",
  });
  ruleHandlers.register("stampDiscardedAt", (event, api) => {
    const e = event as Extract<typeof event, { type: "entity:zoneChanged" }>;
    const currentTurn = api.resolver.getProperty("table-1", "turnCounter") ?? 0;
    api.entities.setProperty(e.entityId, "discardedAt", currentTurn);
  });

  // Increments once per individual turn (phase:started fires exactly
  // once per turn change, for either fixer) — deliberately a RULE, not
  // something room.ts mirrors after calling tryAdvance(): phase:started
  // fires SYNCHRONOUSLY inside tryAdvance(), before it ever returns to
  // room code, so imperative mirroring after the call would always be
  // one turn stale by the time tick-contract-penalties (below) reads it.
  // Ordering both off the same event, by priority, is what actually
  // guarantees correctness here. Seeded at 0 in setup.ts — this fires on
  // the very first phase:started too (from turnCycle.start()), taking it
  // to 1 for turn 1, exactly as if it had always been reactive.
  ruleTable.add({ id: "increment-turn-counter", trigger: "phase:started", match: (event) => event.phaseId === "upkeep", priority: -10, effect: "incrementTurnCounter" });
  ruleHandlers.register("incrementTurnCounter", (_event, api) => {
    const current = api.resolver.getProperty("table-1", "turnCounter") ?? 0;
    api.entities.setProperty("table-1", "turnCounter", current + 1);
  });

  // Runs once per individual turn (phase:started fires for every turn
  // change, regardless of which fixer) — checks every discarded card
  // that still has a pending cancellation penalty, via the SAME modifier
  // `source` string used to apply it, and removes the modifier once
  // hasBeenDiscardedForXTurns says its window has passed.
  ruleTable.add({ id: "tick-contract-penalties", trigger: "phase:started", match: (event) => event.phaseId === "upkeep", priority: 0, effect: "tickContractPenalties" });
  ruleHandlers.register("tickContractPenalties", (_event, api) => {
    for (const card of api.entities.getAllEntities()) {
      if (card.properties.discardedAt === undefined) continue;
      const ownerId = currentOwner(card);
      if (!ownerId) continue;

      const typeId = contractTypeOf(card.tags);
      const def = typeId ? contracts.get(typeId) : undefined;
      const duration = def?.cancelPenalty?.durationTurns;
      if (duration === undefined) continue;

      const pending = api.modifiers.getModifiersFor(ownerId, "inflow").find((m) => m.source === `contract-cancel:${card.id}`);
      if (!pending) continue; // already removed, or this card never had a pending penalty

      const stillWithinWindow = evaluateBoolExpr(
        { op: "call", fn: "hasBeenDiscardedForXTurns", args: { turns: duration } },
        card.id,
        api.resolver,
      );
      if (!stillWithinWindow) api.modifiers.remove(pending.id);
    }
  });

  queryFunctions.register("hasBeenDiscardedForXTurns", {
    evaluate: (subjectId, ctx, args) => {
      const discardedAt = ctx.getEntity(subjectId)?.properties.discardedAt; // raw, not ctx.getProperty — must distinguish "never discarded" from "discarded at turn 0"
      if (discardedAt === undefined) return false;
      const currentTurn = ctx.getProperty("table-1", "turnCounter") ?? 0;
      const turns = (args?.turns as number) ?? 0;
      return currentTurn - discardedAt < turns;
    },
    dependencies: () => ["prop:discardedAt", "prop:turnCounter"],
  });

  // Worked example from the design conversation: pays +1 while in play;
  // +5 more if no AI-tagged entity is anywhere on the table; cancels
  // outright (discarded, -1 inflow for 3 turns) the moment any AI enters
  // play. Registered as content — not pre-placed in a starting match;
  // see setup.ts for what's actually dealt at game start today.
  contracts.register({
    id: "no-ai-bonus",
    basePayout: 1,
    bonus: { when: { op: "compare", left: { op: "fold", fold: "count", where: { op: "hasTag", tag: "ai" } }, cmp: "eq", right: { op: "lit", value: 0 } }, amount: 5 },
    cancelWhen: { op: "compare", left: { op: "fold", fold: "count", where: { op: "hasTag", tag: "ai" } }, cmp: "gt", right: { op: "lit", value: 0 } },
    cancelPenalty: { amount: -1, durationTurns: 3 },
  });

  // --- defeat --------------------------------------------------------

  ruleTable.add({
    id: "check-defeat",
    trigger: "entity:propertyChanged",
    match: (event) => event.prop === "inflow",
    subject: (event) => event.entityId,
    condition: propertyCompare("inflow", "lte", 0),
    effect: "markDefeated",
  });
  ruleHandlers.register("markDefeated", (event, api) => {
    const e = event as Extract<typeof event, { type: "entity:propertyChanged" }>;
    api.entities.addTag(e.entityId, "defeated");
  });

  return { actions, abilities, effectHandlers, ruleTable, ruleHandlers, contracts, queryFunctions, bounds, pregamePhase, postgamePhase, turnPhases, autoAdvancingPhaseIds, resolutionHierarchy, stack, priority, allFixersPassed, resolutionPolicy, deckHierarchy, hierarchies, deck };
}
