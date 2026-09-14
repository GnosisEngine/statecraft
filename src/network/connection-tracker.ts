/**
 * Layer 9.1 — Room lifecycle & seat assignment: ConnectionTracker.
 *
 * Whether a seat's current client is actively connected is separate from
 * who OWNS the seat (that's SeatMap/SeatAssigner). A disconnected player
 * still owns their seat — this just tracks live/stale status so other
 * clients can show "Runner (disconnected)" without touching ownership.
 */

import type { EntityId } from "../core/id.ts";

export class ConnectionTracker {
  private connected = new Map<EntityId, boolean>();

  setConnected(seatId: EntityId, isConnected: boolean): void {
    this.connected.set(seatId, isConnected);
  }

  isConnected(seatId: EntityId): boolean {
    return this.connected.get(seatId) ?? false;
  }
}
