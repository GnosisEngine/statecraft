/**
 * Layer 8 — Forking: ForkRecord & ForkRegistry.
 *
 * Models forking as you specified: a player proposes a fork (with a
 * description of why) and invites the other seat-holder(s); the fork only
 * becomes a live, playable branch once accepted. "proposed" and "pending"
 * collapse into a single "pending" status here — in this model, proposing
 * a fork always means the invite already went out in the same step, so
 * there's no separate draft state between them worth representing.
 */

import type { EntityId } from "../core/id.ts";
import { randomSeed } from "../persistence/seeded-random.ts";

export type ForkStatus = "pending" | "accepted" | "declined" | "expired";

export interface ForkRecord {
  id: string;
  parentGameId: string;
  forkPointSequence: number;
  description: string;
  proposedBy: EntityId;
  invitedSeats: EntityId[];
  status: ForkStatus;
  /** Informational only — never read by fork logic itself. */
  createdAt: string;
  /**
   * Fresh RNG seed for this fork's own post-fork-point randomness.
   * Deliberately NOT the parent's seed — reusing it would make every
   * "random" outcome after the fork point identical to whatever the
   * parent timeline produced for the same draws, which defeats the
   * point of exploring a different branch (and lets anyone who saw the
   * parent's outcome predict the fork's). Generated once, here, at
   * propose time — same moment the rest of the fork's identity
   * (description, invitedSeats) is fixed.
   */
  seed: number;
}

export interface ProposeForkParams {
  id: string;
  parentGameId: string;
  forkPointSequence: number;
  description: string;
  proposedBy: EntityId;
  invitedSeats: EntityId[];
}

export class ForkRegistry {
  private records = new Map<string, ForkRecord>();

  propose(params: ProposeForkParams): ForkRecord {
    const record: ForkRecord = { ...params, status: "pending", createdAt: new Date().toISOString(), seed: randomSeed() };
    this.records.set(record.id, record);
    return record;
  }

  accept(forkId: string): ForkRecord {
    return this.transition(forkId, "accepted");
  }

  decline(forkId: string): ForkRecord {
    return this.transition(forkId, "declined");
  }

  expire(forkId: string): ForkRecord {
    return this.transition(forkId, "expired");
  }

  get(forkId: string): ForkRecord | undefined {
    return this.records.get(forkId);
  }

  /** Forks proposed FROM this game — the fork tree's children at this node. */
  forksOf(parentGameId: string): ForkRecord[] {
    return [...this.records.values()].filter((r) => r.parentGameId === parentGameId);
  }

  private transition(forkId: string, status: ForkStatus): ForkRecord {
    const record = this.records.get(forkId);
    if (!record) {
      throw new Error(`Unknown fork: ${forkId}`);
    }
    if (record.status !== "pending") {
      throw new Error(`Fork "${forkId}" is already "${record.status}" — cannot transition to "${status}"`);
    }
    const updated: ForkRecord = { ...record, status };
    this.records.set(forkId, updated);
    return updated;
  }
}
