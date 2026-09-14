/**
 * Layer 8 — Forking: ForkedEventLog.
 *
 * A fork does NOT copy its parent's commands — it references the parent
 * log and stores only its own divergent tail, exactly the "shared-prefix-
 * with-pointer" design from the persistence conversation: copying every
 * ancestor's commands into every fork would make storage blow up the
 * moment forking is used liberally (which the whole point of forking
 * encourages).
 *
 * CommandLog is the shared shape both EventLog (Layer 7) and
 * ForkedEventLog satisfy, so a fork's parent can be either a root game's
 * plain EventLog or another fork — fork-of-a-fork chains work by the same
 * recursion through getAll(), with no special-casing for depth.
 */

import type { LoggedCommand, LogEntry } from "../persistence/event-log.ts";

export interface CommandLog {
  getAll(): readonly LoggedCommand[];
  getSince(sequence: number): readonly LoggedCommand[];
  readonly length: number;
  readonly seed?: number;
}

export class ForkedEventLog implements CommandLog {
  private ownCommands: LoggedCommand[] = [];

  constructor(
    private readonly parent: CommandLog,
    /** Parent commands with sequence <= this are inherited; pass -1 to fork from nothing. */
    private readonly forkPointSequence: number,
    readonly seed?: number,
  ) {}

  append(entry: LogEntry): LoggedCommand {
    const command: LoggedCommand = {
      sequence: this.forkPointSequence + 1 + this.ownCommands.length,
      loggedAt: new Date().toISOString(),
      entry,
    };
    this.ownCommands.push(command);
    return command;
  }

  /** Inherited prefix (from the parent, up to the fork point) followed by this fork's own commands, in order. */
  getAll(): readonly LoggedCommand[] {
    const inherited = this.parent.getAll().filter((c) => c.sequence <= this.forkPointSequence);
    return [...inherited, ...this.ownCommands];
  }

  getSince(sequence: number): readonly LoggedCommand[] {
    return this.getAll().filter((c) => c.sequence > sequence);
  }

  get length(): number {
    return this.forkPointSequence + 1 + this.ownCommands.length;
  }
}
