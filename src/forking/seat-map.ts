/**
 * Layer 8 — Forking: SeatMap.
 *
 * Who controls each seat is its own branchable piece of state, separate
 * from game state itself — a fork can reassign a seat (a different real
 * player takes over, or later, a bot stands in) without that being part
 * of the replayable command log. Same copy-on-write pattern as RuleTable:
 * clone() gives a fork its own independent mapping to diverge.
 */

import type { EntityId } from "../core/id.ts";

export class SeatMap {
  private assignments: Map<EntityId, string>;

  constructor(initial?: ReadonlyMap<EntityId, string>) {
    this.assignments = new Map(initial);
  }

  assign(seatId: EntityId, identity: string): void {
    this.assignments.set(seatId, identity);
  }

  get(seatId: EntityId): string | undefined {
    return this.assignments.get(seatId);
  }

  entries(): ReadonlyMap<EntityId, string> {
    return this.assignments;
  }

  clone(): SeatMap {
    return new SeatMap(this.assignments);
  }
}
