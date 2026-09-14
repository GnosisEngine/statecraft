/**
 * Layer 8 — Forking: materializeFork.
 *
 * Turns an ACCEPTED ForkRecord into an actually-playable branch: replays
 * the parent up to the fork point (from the nearest snapshot at or before
 * it, if one is supplied, rather than always from the very start — the
 * performance note from the persistence design), then hands back a fresh
 * ForkedEventLog, a cloned RuleTable, and a cloned SeatMap, each ready to
 * diverge from the parent independently.
 *
 * This function doesn't itself decide what "materialize" means for a
 * pending or declined fork — it only accepts "accepted" records, since a
 * fork isn't a real playable branch (and its state shouldn't be built at
 * all) until the invited seat-holder(s) have actually agreed to it.
 *
 * Seed boundary: the replay performed IN here reconstructs the PARENT's
 * shared prefix, so it must run against a SeededRandom seeded from the
 * PARENT's original seed (bound into deps.replayHandlers by the caller)
 * — that's what makes the reconstructed pre-fork-point state match what
 * actually happened. The returned `log.seed` (== record.seed) is a
 * DIFFERENT, fresh seed for the fork's own commands going forward — the
 * caller constructs a new SeededRandom from it for anything the fork
 * does AFTER this function returns. Nothing in this function itself
 * needs to switch seeds mid-replay; the boundary falls exactly at the
 * point where materializeFork hands control back to the caller.
 */

import type { EntityStore } from "../events/entity-store.ts";
import type { Hierarchy } from "../events/hierarchy.ts";
import type { Stack } from "../events/stack.ts";
import type { ModifierStore } from "../properties/modifier-store.ts";
import { replayCommands, type ReplayHandlers } from "../persistence/replay.ts";
import { restoreSnapshot, type Snapshot } from "../persistence/snapshot.ts";
import type { PendingActionRegistry } from "../actions/pending-action-registry.ts";
import type { ActionDefinition } from "../actions/action-definition.ts";
import type { RuleTable } from "../rules/rule-table.ts";
import { ForkedEventLog, type CommandLog } from "./forked-event-log.ts";
import type { ForkRecord } from "./fork-record.ts";
import type { SeatMap } from "./seat-map.ts";

export interface MaterializeForkDeps {
  parentLog: CommandLog;
  parentRuleTable: RuleTable;
  parentSeatMap: SeatMap;
  /** Nearest snapshot at or before the fork point, or omit to replay from the very start. */
  baseSnapshot?: Snapshot;
  /** Fresh, empty stores for the fork — caller constructs these against whatever bus the fork will use. */
  entities: EntityStore;
  modifiers: ModifierStore;
  /** Fresh, empty Hierarchy instances for the fork, one per name the game registers — same "fresh store" role as entities/modifiers above. Required (even as []) for the same reason snapshot.ts's own params are: an omitted hierarchy here means its state silently never gets restored, no error, just gone. */
  hierarchies: readonly Hierarchy[];
  /** Fresh Stack instances for the fork, wrapping the SAME Hierarchy instances passed above — same required-even-as-[] reasoning. */
  stacks: readonly Stack[];
  /** Fresh PendingActionRegistry for the fork, or null if this game doesn't use one — same reasoning as snapshot.ts's own param. */
  pendingActionRegistry: PendingActionRegistry | null;
  /** Looks up this game's own ActionDefinition by actionId — only ever consulted if the base snapshot has pending actions; pass anything (e.g. `() => undefined`) if pendingActionRegistry is null. */
  lookupAction: (actionId: string) => ActionDefinition | undefined;
  /** Same shape as Layer 7's replay dispatch — bound to the fork's own fresh stores. */
  replayHandlers: ReplayHandlers;
}

export interface MaterializedFork {
  log: ForkedEventLog;
  ruleTable: RuleTable;
  seatMap: SeatMap;
}

export function materializeFork(record: ForkRecord, deps: MaterializeForkDeps): MaterializedFork {
  if (record.status !== "accepted") {
    throw new Error(`Fork "${record.id}" must be accepted before it can be materialized (status: "${record.status}")`);
  }

  if (deps.baseSnapshot) {
    restoreSnapshot(deps.baseSnapshot, deps.entities, deps.modifiers, deps.hierarchies, deps.stacks, deps.pendingActionRegistry, deps.lookupAction);
  }

  const floor = deps.baseSnapshot?.atSequence ?? -1;
  const commandsToReplay = deps.parentLog
    .getSince(floor)
    .filter((c) => c.sequence <= record.forkPointSequence);
  replayCommands(commandsToReplay, deps.replayHandlers);

  const log = new ForkedEventLog(deps.parentLog, record.forkPointSequence, record.seed);
  const ruleTable = deps.parentRuleTable.clone(`${record.parentGameId}::fork::${record.id}`);
  const seatMap = deps.parentSeatMap.clone();

  return { log, ruleTable, seatMap };
}
