/**
 * Layer 9.1 — Room lifecycle & seat assignment: SeatAssigner.
 *
 * This is where Layer 8's SeatMap actually gets used live, not just as
 * fork-branching metadata: a joining client's identity gets mapped onto a
 * seat here, for the duration of a real match.
 *
 * Deliberately has no Colyseus import at all — claiming a seat for an
 * identity is pure logic, fully testable without booting a room or a
 * server. TableRoom (table-room.ts) is the thin framework glue that calls
 * into this from onJoin.
 *
 * Seat ownership, once claimed, is NOT released on disconnect — a card
 * game shouldn't hand a player's seat to someone else mid-match. That's
 * what makes claimSeat idempotent-by-identity the actual mechanism behind
 * "reconnect and get your seat back": a brand new connection with the
 * same identity finds its existing seat via seatFor before ever needing
 * Colyseus's own session-level reconnection token as a fallback.
 */

import type { EntityId } from "../core/id.ts";
import type { SeatMap } from "../forking/seat-map.ts";

export class NoFreeSeatsError extends Error {
  constructor() {
    super("No free seats available");
  }
}

export class SeatAssigner {
  constructor(
    private readonly seatMap: SeatMap,
    private readonly seatOrder: readonly EntityId[],
  ) {}

  /** The seat already assigned to this identity, if any. */
  seatFor(identity: string): EntityId | undefined {
    for (const seatId of this.seatOrder) {
      if (this.seatMap.get(seatId) === identity) return seatId;
    }
    return undefined;
  }

  /** Returns this identity's existing seat if it has one; otherwise claims the next free seat. */
  claimSeat(identity: string): EntityId {
    const existing = this.seatFor(identity);
    if (existing) return existing;

    const free = this.seatOrder.find((seatId) => this.seatMap.get(seatId) === undefined);
    if (!free) throw new NoFreeSeatsError();

    this.seatMap.assign(free, identity);
    return free;
  }

  get isFull(): boolean {
    return this.seatOrder.every((seatId) => this.seatMap.get(seatId) !== undefined);
  }

  get seats(): readonly EntityId[] {
    return this.seatOrder;
  }
}
