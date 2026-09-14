/**
 * Layer 9.3 — Intent ingestion: validation.
 *
 * The write-side counterpart to 9.2's visibility filtering: 9.2 stops a
 * client from READING state they shouldn't see; this stops a client from
 * WRITING state on someone else's behalf. Pure functions, no Colyseus
 * import — table-room.ts (or a game-specific room built on it) is the
 * thin glue that calls these from onMessage handlers.
 *
 * A submitted intent's actingFixerId is NEVER taken from the client —
 * it's always the seat the server already knows this session occupies
 * (TableRoom.seatOf, Layer 9.1). That alone stops "submit an action as
 * someone else's fixer," but it doesn't stop a subtler version of the
 * same problem: submitting a LEGITIMATE action as yourself, but through a
 * PERFORMER (contractor) you don't actually control. Layer 4's pipeline
 * has no general concept of "who's allowed to invoke this performer at
 * all" — only "is this specific action legal given a performer and
 * targets" — so that ownership guard belongs here, at the boundary,
 * rather than being silently absent from every action definition unless
 * someone remembers to add it. A content-specific action that WANTS to
 * let one fixer act through another's contractor (a "mind control"
 * effect) isn't precluded by this — it just has to be modeled as its own
 * explicit decision rather than falling out of a gap in the default path.
 */

import { currentOwner, type Entity } from "../core/entity.ts";
import type { EntityId } from "../core/id.ts";
import type { ActionContext } from "../actions/action-definition.ts";

export interface RawActionIntent {
  actionId: string;
  performerId: EntityId;
  targetIds: EntityId[];
  params?: Record<string, unknown>;
  /**
   * Which currently-pending item (if any) this proposal is responding
   * to — omitted or null means a fresh, unrelated root. Deliberately
   * NOT threaded into ActionContext/ValidatedActionIntent below: this
   * is a room-level concern about WHERE to push onto the shared
   * resolution stack, not part of the game-logic intent any
   * targetQuery/performerCondition/effect handler ever needs to see.
   * The room itself is responsible for validating this against what's
   * actually currently pending before acting on it — a stale claim
   * (something that resolved or was countered between the client
   * rendering and this message arriving) gets rejected the same way an
   * illegal target already is, never trusted blindly.
   */
  respondingTo?: EntityId | null;
}

export type ValidatedActionIntent =
  | { ok: true; actionId: string; intent: ActionContext }
  | { ok: false; reason: string };

export function validateActionIntent(
  raw: RawActionIntent,
  senderSeatId: EntityId,
  getEntity: (id: EntityId) => Entity | undefined,
): ValidatedActionIntent {
  const performer = getEntity(raw.performerId);
  if (!performer) {
    return { ok: false, reason: `unknown performer: ${raw.performerId}` };
  }

  const owner = currentOwner(performer);
  if (owner !== senderSeatId) {
    return { ok: false, reason: `seat "${senderSeatId}" does not control performer "${raw.performerId}"` };
  }

  return {
    ok: true,
    actionId: raw.actionId,
    intent: {
      performerId: raw.performerId,
      actingFixerId: senderSeatId,
      targetIds: raw.targetIds,
      params: raw.params,
    },
  };
}

export type ValidatedTurn = { ok: true } | { ok: false; reason: string };

/**
 * Only the currently active fixer may act. Used for phase-advance
 * requests (see validatePhaseAdvanceIntent below) — action-level timing
 * (whether a given action requires active-turn, is reactive/instant-
 * speed, phase-gated, etc.) is a content decision now, expressed as
 * ActionDefinition.timingCondition (a BoolExpr) and enforced inside the
 * pipeline itself (src/actions/pipeline.ts), not here.
 */
export function validateActiveTurn(senderSeatId: EntityId, activeFixerId: EntityId): ValidatedTurn {
  if (senderSeatId !== activeFixerId) {
    return { ok: false, reason: `it is not seat "${senderSeatId}"'s turn (active fixer is "${activeFixerId}")` };
  }
  return { ok: true };
}

export type ValidatedPhaseAdvance = ValidatedTurn;

/** Only the currently active fixer may request a phase advance — no forcing someone else's turn along. */
export function validatePhaseAdvanceIntent(senderSeatId: EntityId, activeFixerId: EntityId): ValidatedPhaseAdvance {
  return validateActiveTurn(senderSeatId, activeFixerId);
}
