/**
 * Layer 7 — Snapshot.
 *
 * A snapshot is everything needed to reconstruct world state at a given
 * log sequence without replaying from the very start: every entity (via
 * Layer 0's serialize/deserialize, so tags survive the Set<->JSON
 * boundary), every active modifier (Layer 3), every named Hierarchy
 * (Layer 2) a game registers, every named Stack (also Layer 2, built on
 * Hierarchy), and every currently-pending proposal a game's
 * PendingActionRegistry is tracking (Layer 4) — resolved property
 * values depend on the first two; anything built on Hierarchy (a
 * deck's undrawn pool, a squad's membership) depends on the third; a
 * Stack's OWN bookkeeping (sequenceCounter, which items are currently
 * pending — not the tree shape itself, which the underlying Hierarchy
 * already covers) depends on the fourth; and whether a resolveNext'd
 * item can actually be resolved at all (rather than crashing the
 * instant it's picked) depends on the fifth. `hierarchies` and `stacks`
 * are REQUIRED parameters, not optional-with-an-empty-default: an
 * omitted one here means its entire state silently vanishes on
 * restore — no error, just gone — which is exactly the failure mode
 * this format exists to prevent, so leaving one out has to be a
 * conscious, visible choice (pass `[]`), never an accident of a
 * forgotten argument. This is not a hypothetical concern for Stack
 * specifically: without restoring sequenceCounter correctly, the very
 * next push after a resume would be stamped with a LOWER
 * pushedAtSequence than items that were genuinely pushed before the
 * snapshot, silently corrupting LIFO/FIFO/any custom resolution policy
 * immediately after resume.
 *
 * `pendingActionRegistry` is different from hierarchies/stacks in one
 * way worth being explicit about: it's a SINGULAR, REQUIRED parameter
 * (not an array), and it's `PendingActionRegistry | null` rather than
 * defaulting to "empty" — `null` means "this game doesn't use one at
 * all," an explicit, conscious statement, not a stand-in for "forgot to
 * pass it." Unlike Hierarchy/Stack, this class has no name-based,
 * multiple-instance concept — a game either has the one registry
 * tracking pending proposals, or it doesn't use interactive priority at
 * all and there's nothing to track.
 *
 * Restoring uses EntityStore/ModifierStore/Hierarchy/Stack/
 * PendingActionRegistry's own loadRaw — deliberately not
 * add()/setParent()/push()/set() — so materializing a snapshot never
 * fires entity:created, hierarchy:parentChanged, or any stack:* event
 * for every entity/link/item as if a game's whole state had just
 * sprung into existence in one live turn.
 *
 * Restore order matters and restoreSnapshot enforces it automatically:
 * Hierarchies before Stacks (a Stack's own loadRaw only restores
 * sequenceCounter/pending, never parent-links, so the tree structure
 * has to already be correct by the time it runs), and Stacks before
 * PendingActionRegistry (its own integrity check — see below — needs
 * every Stack already restored to check against).
 *
 * The integrity check: after restoring pendingActionRegistry, every
 * entry it now holds is cross-checked against every restored Stack —
 * if NONE of them consider that entry's itemId currently pending,
 * restoreSnapshot throws immediately, rather than leaving a
 * registry entry that will confusingly fail (or silently point at
 * nothing) the first time something tries to act on it. This is the
 * concrete fix for "Ghost in the Machine": a pending proposal's own
 * ActionDefinition can't survive serialization (it's a live object with
 * function fields), so `lookupAction` re-derives it from the game's own
 * action registry by whatever `actionId` was stored instead — a
 * missing lookup (the game's own registered actions changed shape since
 * this snapshot was taken) is exactly the other failure loadRaw itself
 * already guards, thrown loudly there rather than producing a
 * registry that looks fine until the first time that entry resolves.
 *
 * Cadence policy (snapshot every N commands, or on-demand) is a decision
 * for whatever schedules calls to createSnapshot — this file only
 * defines the format and the two operations, not when to use them.
 */

import { deserializeEntity, serializeEntity, type SerializedEntity } from "../core/entity.ts";
import type { EntityStore } from "../events/entity-store.ts";
import type { Hierarchy, SerializedHierarchy } from "../events/hierarchy.ts";
import type { Stack, SerializedStack } from "../events/stack.ts";
import type { Modifier } from "../properties/modifier.ts";
import type { ModifierStore } from "../properties/modifier-store.ts";
import type { ActionDefinition } from "../actions/action-definition.ts";
import type { PendingActionRegistry, SerializedPendingAction } from "../actions/pending-action-registry.ts";

export interface Snapshot {
  /** The log sequence this snapshot reflects state AFTER (see EventLog). */
  atSequence: number;
  entities: SerializedEntity[];
  modifiers: Modifier[];
  hierarchies: SerializedHierarchy[];
  stacks: SerializedStack[];
  /** null means the game doesn't use a PendingActionRegistry at all — see this file's own header for why that's different from hierarchies/stacks defaulting to []. */
  pendingActions: SerializedPendingAction[] | null;
}

export function createSnapshot(
  entities: EntityStore,
  modifiers: ModifierStore,
  atSequence: number,
  hierarchies: readonly Hierarchy[],
  stacks: readonly Stack[],
  pendingActionRegistry: PendingActionRegistry | null,
): Snapshot {
  return {
    atSequence,
    entities: [...entities.getAllEntities()].map(serializeEntity),
    modifiers: modifiers.getAll(),
    hierarchies: hierarchies.map((h) => h.serialize()),
    stacks: stacks.map((s) => s.serialize()),
    pendingActions: pendingActionRegistry === null ? null : pendingActionRegistry.serialize(),
  };
}

/**
 * Loads a snapshot into fresh (or emptied) stores. Uses loadRaw — see
 * file header for why. `hierarchies`/`stacks` must include every
 * instance named in the snapshot — restoring throws if one's missing,
 * rather than silently skipping that state. Hierarchies are restored
 * before Stacks, and Stacks before pendingActionRegistry, deliberately
 * (see file header on both ordering and the integrity check).
 *
 * `lookupAction` is only ever consulted if `snapshot.pendingActions`
 * isn't null — pass whatever function looks up this game's own
 * ActionDefinition by id (e.g. `(id) => content.actions.get(id)`); a
 * game with no PendingActionRegistry at all can pass anything here
 * (e.g. `() => undefined`), since it will never be called.
 */
export function restoreSnapshot(
  snapshot: Snapshot,
  entities: EntityStore,
  modifiers: ModifierStore,
  hierarchies: readonly Hierarchy[],
  stacks: readonly Stack[],
  pendingActionRegistry: PendingActionRegistry | null,
  lookupAction: (actionId: string) => ActionDefinition | undefined,
): void {
  for (const wire of snapshot.entities) {
    entities.loadRaw(deserializeEntity(wire));
  }
  for (const modifier of snapshot.modifiers) {
    modifiers.loadRaw(modifier);
  }
  const hierarchiesByName = new Map(hierarchies.map((h) => [h.name, h]));
  for (const serialized of snapshot.hierarchies) {
    const h = hierarchiesByName.get(serialized.name);
    if (!h) {
      throw new Error(`restoreSnapshot: no Hierarchy named "${serialized.name}" was provided to restore into — pass every hierarchy the snapshot references.`);
    }
    h.loadRaw(serialized);
  }
  const stacksByName = new Map(stacks.map((s) => [s.name, s]));
  for (const serialized of snapshot.stacks) {
    const s = stacksByName.get(serialized.name);
    if (!s) {
      throw new Error(`restoreSnapshot: no Stack named "${serialized.name}" was provided to restore into — pass every stack the snapshot references.`);
    }
    s.loadRaw(serialized);
  }
  if (snapshot.pendingActions !== null) {
    if (pendingActionRegistry === null) {
      throw new Error(`restoreSnapshot: this snapshot has pending actions, but no PendingActionRegistry was provided to restore into.`);
    }
    pendingActionRegistry.loadRaw(snapshot.pendingActions, lookupAction);
    // Integrity check: every restored entry must correspond to
    // something at least one restored Stack still considers pending —
    // see this file's own header for why this specifically catches
    // "Ghost in the Machine"-shaped corruption rather than deferring it
    // to whenever that item happens to resolve.
    for (const entry of snapshot.pendingActions) {
      const stillPending = stacks.some((s) => s.has(entry.itemId));
      if (!stillPending) {
        throw new Error(
          `restoreSnapshot: pending action "${entry.itemId}" (actionId "${entry.actionId}") was restored into ` +
            `PendingActionRegistry, but no restored Stack considers it currently pending — the snapshot's own ` +
            `Stack and PendingActionRegistry data have drifted out of sync with each other.`,
        );
      }
    }
  }
}
