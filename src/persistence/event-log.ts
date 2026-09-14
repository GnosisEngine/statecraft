/**
 * Layer 7 — EventLog.
 *
 * Logs COMMANDS (what a player or the system decided to do), not every
 * low-level entity mutation. An action's effect handler mutating a dozen
 * properties, and the rules that fire in response, are all deterministic
 * consequences of the action being performed against a given world state
 * — replaying the one logged command (see replay.ts) re-derives all of
 * that by re-running the same pipeline, through the same rule engine,
 * rather than needing every intermediate mutation logged separately.
 * This is what keeps the log small and keeps "replay" meaning "re-run
 * the same process," not "reapply a giant list of raw diffs."
 *
 * Only CONFIRMED commands belong here — see performActionAndLog /
 * advancePhaseAndLog in replay.ts, which log only after `ok: true`. A
 * rejected proposal produced no state change, so it isn't part of the
 * deterministic input sequence; if replaying a logged command ever gets
 * rejected when the original succeeded, that's a determinism bug worth
 * surfacing loudly, not something to paper over by logging rejections.
 */

import type { ActionContext } from "../actions/action-definition.ts";
import type { EntityId } from "../core/id.ts";

export type LogEntry =
  | { kind: "action"; actionId: string; intent: ActionContext; respondingTo?: EntityId | null }
  | { kind: "phaseAdvance" }
  | { kind: "pass"; seatId: EntityId };

export interface LoggedCommand {
  /** Position in the log — authoritative for ordering and for fork points (Layer 8). */
  sequence: number;
  /** ISO timestamp, for humans/debugging ONLY — replay must never read this. */
  loggedAt: string;
  entry: LogEntry;
}

export class EventLog {
  /**
   * The RNG seed this run started from (see SeededRandom). Recorded once,
   * here, since it's the one piece of non-command setup a replay needs
   * to reconstruct the same "random" sequence.
   */
  readonly seed?: number;
  private commands: LoggedCommand[] = [];

  constructor(seed?: number) {
    this.seed = seed;
  }

  append(entry: LogEntry): LoggedCommand {
    const command: LoggedCommand = {
      sequence: this.commands.length,
      loggedAt: new Date().toISOString(),
      entry,
    };
    this.commands.push(command);
    return command;
  }

  getAll(): readonly LoggedCommand[] {
    return this.commands;
  }

  /** Commands strictly after `sequence` — e.g. reconnect/resync: a client sends the last sequence it saw and gets everything since. */
  getSince(sequence: number): readonly LoggedCommand[] {
    return this.commands.filter((c) => c.sequence > sequence);
  }

  get length(): number {
    return this.commands.length;
  }
}
