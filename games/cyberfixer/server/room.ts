/**
 * games/cyberfixer/server/room.ts
 *
 * Thin composition root: everything here is calling into Layers 4-9
 * (action pipeline, rule engine, Match/turn cycle, seat assignment,
 * sync, intent validation) with this game's own content (content.ts)
 * and starting state (setup.ts).
 *
 * Every confirmed action/phaseAdvance is logged (EventLog, via
 * performActionAndLog/advancePhaseAndLog) and a Snapshot is taken every
 * SNAPSHOT_INTERVAL confirmed commands. Kept IN MEMORY only, for now —
 * this makes a match's history genuinely replayable/forkable WITHIN this
 * process (the actual mechanism proven correct by
 * determinism.test.ts and content.test.ts's Hierarchy-aware Snapshot
 * tests), but does NOT yet mean a match survives a process crash — that
 * needs the log/snapshots written somewhere durable (disk, a database),
 * which is a real, separate decision (what storage, what format) this
 * file deliberately doesn't make unilaterally.
 */

import { Client } from "colyseus";
import { StateView, type MapSchema } from "@colyseus/schema";
import { TableRoom, type TableRoomCreateOptions } from "../../../src/network/table-room.ts";
import type { EntitySchemaInstance } from "../../../src/network/schema.ts";
import { SyncManager } from "../../../src/network/sync-manager.ts";
import { validateActionIntent, validateActiveTurn, validatePhaseAdvanceIntent, type RawActionIntent } from "../../../src/network/intent.ts";
import { EventBus } from "../../../src/events/bus.ts";
import { EntityStore } from "../../../src/events/entity-store.ts";
import { ModifierStore } from "../../../src/properties/modifier-store.ts";
import { PropertyResolver } from "../../../src/properties/property-resolver.ts";
import { SeededRandom, randomSeed, deriveSeed } from "../../../src/persistence/seeded-random.ts";
import { RandomRegistry } from "../../../src/persistence/random-registry.ts";
import { EventLog } from "../../../src/persistence/event-log.ts";
import { performActionAndLog, advancePhaseAndLog, passAndLog } from "../../../src/persistence/replay.ts";
import { createSnapshot, type Snapshot } from "../../../src/persistence/snapshot.ts";
import { RuleEngine } from "../../../src/rules/rule-engine.ts";
import { performAction, proposeAction, resolveEffect, type ActionResult, type PerformActionDeps } from "../../../src/actions/pipeline.ts";
import type { ActionContext, ActionDefinition } from "../../../src/actions/action-definition.ts";
import { PendingActionRegistry } from "../../../src/actions/pending-action-registry.ts";
import { PhaseHandlerRegistry, type PhaseDefinition } from "../../../src/phases/phase-definition.ts";
import { TurnCycle } from "../../../src/phases/turn-cycle.ts";
import { Match } from "../../../src/phases/match.ts";
import { SubscriptionRegistry } from "../../../src/query/subscriptions.ts";
import { wireQuerySubscriptions } from "../../../src/events/subscriptions-wiring.ts";
import { evaluateBoolExpr } from "../../../src/query/interpreter.ts";
import { createCard } from "../../../src/core/entity.ts";
import type { EntityId } from "../../../src/core/id.ts";
import { buildContent, recomputeInflow, type CyberFixerContent } from "./content.ts";
import { deckRandomDomain } from "./deck.ts";
import { setupMatch } from "./setup.ts";

/** Every N confirmed commands, a fresh Snapshot is taken — a tunable cadence, not a load-bearing correctness constant. Small enough to matter for a game this size; not tuned against any real production load yet. */
const SNAPSHOT_INTERVAL = 5;

export default class CyberFixerRoom extends TableRoom {
  private entities!: EntityStore;
  private content!: CyberFixerContent;
  private deps!: PerformActionDeps;
  private resolver!: PropertyResolver;
  private turnCycle!: TurnCycle;
  private match!: Match;
  private sync!: SyncManager;
  private seatOrder!: readonly EntityId[];
  private log!: EventLog;
  private pendingActions!: PendingActionRegistry;
  private lastSnapshot: Snapshot | null = null;

  onCreate(options: TableRoomCreateOptions): void {
    super.onCreate(options);
    this.seatOrder = options.seatOrder;

    const bus = new EventBus();
    this.entities = new EntityStore(bus);
    const modifiers = new ModifierStore(bus);

    // ONE shared master seed for the whole match. `random` (general
    // purpose — rule effects, action effects, phase effects) is seeded
    // directly from it, unchanged from before. Each fixer's deck draws
    // use a SEPARATELY DERIVED, isolated stream instead of this one —
    // see deriveSeed's own docs for why: a single shared stream would
    // let the timing/order of ANY unrelated random-consuming action
    // anywhere in the match perturb what a fixer's own deck draws next.
    // Both still trace back to the one master seed, so the fork-reseed
    // design (one seed per game/fork, everything reproducible from it)
    // holds — a fork's new master seed automatically re-derives every
    // per-fixer stream too, with no extra bookkeeping.
    const matchSeed = randomSeed();
    this.log = new EventLog(matchSeed);
    this.pendingActions = new PendingActionRegistry();
    const random = new SeededRandom(matchSeed);
    const randomRegistry = new RandomRegistry();
    for (const fixerId of options.seatOrder) {
      randomRegistry.register(deckRandomDomain(fixerId), new SeededRandom(deriveSeed(matchSeed, deckRandomDomain(fixerId))));
    }

    this.content = buildContent(options.seatOrder, bus, this.entities);
    this.resolver = new PropertyResolver(this.entities, modifiers, this.content.queryFunctions, this.content.bounds, this.content.hierarchies);

    const ruleEngine = new RuleEngine(
      this.content.ruleTable,
      this.content.ruleHandlers,
      this.entities,
      modifiers,
      this.resolver,
      random,
      randomRegistry,
    );
    ruleEngine.wire(bus);

    this.sync = new SyncManager(this.entities, this.state.entities as unknown as MapSchema<EntitySchemaInstance>);
    this.sync.wire(bus);

    // Setup must run AFTER SyncManager is wired — entity:created events
    // fire synchronously the moment each entity is add()ed, and
    // SyncManager only mirrors events it was subscribed to catch.
    // Populating state before wiring would silently mean nothing from
    // initial setup ever reaches any client's synced view.
    setupMatch(this.entities, options.seatOrder, this.content.deck);

    this.deps = {
      entities: this.entities,
      resolver: this.resolver,
      modifiers,
      handlers: this.content.effectHandlers,
      bus,
      random,
      randomRegistry,
    };

    const phases: PhaseDefinition[] = this.content.turnPhases;
    const registry = new SubscriptionRegistry();
    wireQuerySubscriptions(bus, registry);
    const phaseRunnerDeps = {
      entities: this.entities,
      modifiers,
      random,
      randomRegistry,
      resolver: this.resolver,
      registry,
      handlers: new PhaseHandlerRegistry(),
      bus,
      hierarchies: this.content.hierarchies,
    };
    this.turnCycle = new TurnCycle(phases, options.seatOrder, "table-1", phaseRunnerDeps);
    this.match = new Match(this.content.pregamePhase, this.content.postgamePhase, this.turnCycle, "table-1", phaseRunnerDeps);
    // Starts PREGAME, not playing — no active fixer to tag yet. Once
    // "ready" advances the match into "playing", the first phase:started
    // fires and content's own "sync-active-turn" rule (content.ts) tags
    // the newly-active fixer automatically — nothing here needs to do
    // it manually.
    this.match.start();

    this.onMessage("action", (client: Client, message: RawActionIntent) => {
      const seatId = this.seatOf(client.sessionId);
      if (!seatId) return;

      const definition = this.content.actions.get(message.actionId);
      if (!definition) {
        client.send("action-result", { ok: false, reason: `unknown action: ${message.actionId}` });
        return;
      }

      const validated = validateActionIntent(message, seatId, (id) => this.entities.get(id));
      if (!validated.ok) {
        client.send("action-result", { ok: false, reason: validated.reason });
        return;
      }

      const inMainPhase = this.match.stage === "playing" && this.turnCycle.currentPhase.id === "main";
      const result = inMainPhase
        ? this.proposeAndPush(message, validated.intent, definition, seatId)
        : performActionAndLog(this.log, message.actionId, validated.intent, () => performAction(validated.intent, definition, this.deps));
      client.send("action-result", result);
      this.maybeSnapshot();

      // "ready" is the one action that can advance the match stage
      // itself. Checked generically (not just for actionId === "ready")
      // so any future pregame-only action gets the same treatment for
      // free — advancement is driven by whether the gate is now
      // satisfied, not by which specific action was just performed.
      if (result.ok && this.match.stage === "pregame" && this.match.canAdvance()) {
        // Must run before the match transitions into "playing": that
        // transition fires the first phase:started, which resets the
        // first fixer's outflow bounded by their CURRENT inflow — which
        // needs to be the real starting total already, not a placeholder.
        recomputeInflow(this.seatOrder, this.entities, this.resolver);
        advancePhaseAndLog(this.log, () => this.match.tryAdvance());
        this.maybeSnapshot();
        this.autoAdvanceThroughAutomaticPhases();
      }
    });

    this.onMessage("pass", (client: Client) => {
      const seatId = this.seatOf(client.sessionId);
      if (!seatId) return;

      const inMainPhase = this.match.stage === "playing" && this.turnCycle.currentPhase.id === "main";
      if (!inMainPhase) {
        client.send("pass-result", { ok: false, reason: "pass is only meaningful during main phase" });
        return;
      }
      if (this.content.stack.size() === 0) {
        client.send("pass-result", { ok: false, reason: "nothing is currently pending to pass on" });
        return;
      }

      // Deliberately no "is it your turn" check — the simplified,
      // non-rotating pass mechanism lets either fixer pass or propose a
      // new response at any moment, in any order (see content.ts's own
      // pass-priority section). Passing twice in a row before the other
      // fixer responds is a harmless no-op (addTag is idempotent), not
      // an error to reject.
      const result = passAndLog(this.log, seatId, () => {
        this.entities.addTag(seatId, "passed-priority");
        return { ok: true as const };
      });
      client.send("pass-result", result);

      if (evaluateBoolExpr(this.content.allFixersPassed, "table-1", this.resolver)) {
        const resolvedId = this.content.stack.resolveNext(this.content.resolutionPolicy, this.resolver);
        const pending = this.pendingActions.get(resolvedId);
        if (!pending) {
          throw new Error(`pass: resolved stack item "${resolvedId}" has no stored PendingAction — this should be unreachable`);
        }
        // Cleanup happens either way — fizzled or genuinely resolved,
        // this item is done and no longer pending, either way. Only
        // the broadcast itself differs, so both fixers (not just
        // whoever sent this pass) know which one actually happened.
        const outcome = resolveEffect(pending.intent, pending.definition, pending.capability, pending.adjustedCost, this.deps);
        this.pendingActions.delete(resolvedId);
        this.entities.remove(resolvedId); // the placeholder pending-item entity has served its purpose
        this.broadcast("resolution-result", { resolvedId, actionId: pending.definition.id, fizzled: outcome.fizzled, reason: outcome.reason });
      }

      this.maybeSnapshot();
    });

    this.onMessage("phaseAdvance", (client: Client) => {
      const seatId = this.seatOf(client.sessionId);
      if (!seatId) return;

      if (this.match.stage !== "playing") {
        client.send("phase-result", { ok: false, reason: "match hasn't started yet — waiting on the lobby" });
        return;
      }

      const validated = validatePhaseAdvanceIntent(seatId, this.turnCycle.activeFixerId);
      if (!validated.ok) {
        client.send("phase-result", { ok: false, reason: validated.reason });
        return;
      }
      const result = advancePhaseAndLog(this.log, () => this.match.tryAdvance());
      client.send("phase-result", result);
      this.maybeSnapshot();
      this.autoAdvanceThroughAutomaticPhases();
    });
  }

  /**
   * Validates and, if legal, PROPOSES a main-phase action onto the
   * shared resolution stack instead of resolving it immediately — the
   * actual point of main phase having a real, interactive stack at all.
   * Cost is paid now, at proposal time (see proposeAction's own docs) —
   * non-refundable if this is later countered rather than resolved.
   *
   * respondingTo is validated against what's ACTUALLY currently
   * pending, not trusted from the client — a stale claim (something
   * that already resolved or was countered between the client
   * rendering the board and this message arriving) is rejected with a
   * clear reason, the same way an illegal target already is.
   *
   * The pending item's own id is derived from log.length, NOT a
   * separately-incrementing counter — a rejected proposal is never
   * logged (see EventLog's own docs), so a counter that incremented on
   * every ATTEMPT would drift from what replay reconstructs, which only
   * ever sees CONFIRMED commands. log.length only grows on confirmed
   * commands too, so deriving the id from it stays identical between a
   * live run and a replay of the same log.
   */
  private proposeAndPush(message: RawActionIntent, intent: ActionContext, definition: ActionDefinition, seatId: EntityId): ActionResult {
    const respondingTo = message.respondingTo ?? null;
    if (respondingTo !== null && !this.pendingActions.has(respondingTo)) {
      return { ok: false, reason: `"${respondingTo}" is not currently pending — it may have already resolved or been countered` };
    }

    const pendingId = `pending-${this.log.length}`;
    return performActionAndLog(
      this.log,
      message.actionId,
      intent,
      () => {
        const proposed = proposeAction(intent, definition, this.deps);
        if (proposed.ok) {
          const pendingCard = createCard(`Pending: ${definition.id}`, { id: pendingId, ownership: [seatId] });
          pendingCard.tags.add("pending-action"); // discoverable marker — a client (or a future card's targetQuery) can find every currently-proposed item without guessing from the id's own prefix
          this.entities.add(pendingCard);
          this.content.stack.push(pendingId, respondingTo);
          this.pendingActions.set(pendingId, { intent, actionId: message.actionId, definition, capability: proposed.capability, adjustedCost: proposed.adjustedCost });
        }
        return proposed;
      },
      respondingTo,
    );
  }

  /**
   * Keeps calling tryAdvance() as long as the CURRENT phase is one of
   * content's own autoAdvancingPhaseIds (upkeep/end — fully automatic,
   * no player commitments legal there) and the gate is actually
   * satisfied — so a single ready-up or phaseAdvance message carries
   * the match all the way to the next phase that actually needs a
   * player (main), rather than stopping one step short and leaving the
   * match stuck in an automatic phase with nobody able to move it.
   * Stops the moment either condition fails: current phase isn't
   * auto-advancing (main — always waits for an explicit phaseAdvance),
   * or the gate genuinely isn't satisfied yet (something's still
   * pending on the shared resolution stack).
   *
   * Calls maybeSnapshot() after EVERY individual advance, not once at
   * the end — the snapshot cadence is "every SNAPSHOT_INTERVAL
   * commands," and a burst of several auto-advances landing back to
   * back could otherwise jump straight past the exact log length that
   * cadence is watching for, skipping a snapshot entirely rather than
   * just taking it one command later than usual.
   */
  private autoAdvanceThroughAutomaticPhases(): void {
    while (
      this.match.stage === "playing" &&
      this.content.autoAdvancingPhaseIds.has(this.turnCycle.currentPhase.id) &&
      this.match.canAdvance()
    ) {
      const result = advancePhaseAndLog(this.log, () => this.match.tryAdvance());
      this.maybeSnapshot();
      if (!result.ok) break; // defensive — canAdvance() already checked this, but never loop on a failure
    }
  }

  /** Every SNAPSHOT_INTERVAL confirmed commands, captures entities/modifiers/every registered Hierarchy AND Stack AND pending proposal — see EventLog/Snapshot's own docs for why a rejected command (log.length unchanged) never triggers this. content.stack (the shared resolution stack), its own underlying Hierarchy, and this.pendingActions are all real, live instances now — omitting any would silently lose their bookkeeping on any resume, exactly the bug Snapshot's own hierarchies/stacks/pendingActionRegistry params exist to prevent (see snapshot.ts's header — "Ghost in the Machine"). */
  private maybeSnapshot(): void {
    if (this.log.length > 0 && this.log.length % SNAPSHOT_INTERVAL === 0) {
      this.lastSnapshot = createSnapshot(
        this.entities,
        this.deps.modifiers,
        this.log.length - 1,
        [this.content.deckHierarchy, this.content.resolutionHierarchy],
        [this.content.stack],
        this.pendingActions,
      );
    }
  }

  onJoin(client: Client, options: { identity: string }): void {
    super.onJoin(client, options);
    const seatId = this.seatOf(client.sessionId)!;
    const view = new StateView();
    client.view = view;
    this.sync.registerSeat(seatId, view);
  }
}
