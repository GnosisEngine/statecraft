/**
 * Layer 7 — Replay.
 *
 * replayCommands doesn't know what "performing an action" or "advancing a
 * phase" actually does — it just dispatches each logged command to
 * whichever concrete callback the caller supplies (bound to a real
 * ActionRegistry/TurnCycle instance elsewhere). Keeping this decoupled is
 * what lets Layer 7 stay ignorant of exactly which Layer 4/6 objects a
 * given game session is using.
 *
 * Every LoggedCommand was, by construction (see logIfConfirmed below),
 * only ever appended after the original attempt returned ok:true. So if
 * replaying one now comes back ok:false, the replay did NOT reconstruct
 * the same state the original run had at this point — that's a
 * determinism bug (an unseeded random call, a wall-clock read, iteration
 * order depending on insertion timing), not a normal rejection, and
 * replayCommands throws rather than silently drifting from what actually
 * happened.
 */

import type { ActionContext } from "../actions/action-definition.ts";
import type { EntityId } from "../core/id.ts";
import type { EventLog, LoggedCommand } from "./event-log.ts";

export interface ReplayResult {
  ok: boolean;
  reason?: string;
}

export interface ReplayHandlers {
  performAction(actionId: string, intent: ActionContext, respondingTo?: EntityId | null): ReplayResult;
  advancePhase(): ReplayResult;
  pass(seatId: EntityId): ReplayResult;
}

export class ReplayDivergenceError extends Error {
  constructor(command: LoggedCommand, result: ReplayResult) {
    super(
      `Replay divergence at sequence ${command.sequence}: this command (kind: "${command.entry.kind}") was ` +
        `logged as a CONFIRMED success but replaying it now returned ok:false` +
        (result.reason ? ` ("${result.reason}")` : "") +
        `. The replay didn't reconstruct the same state the original run had at this point — almost ` +
        `always an unseeded/non-deterministic source (Math.random(), Date.now(), iteration order depending ` +
        `on insertion timing) somewhere in an action, rule, or phase handler.`,
    );
  }
}

export function replayCommands(commands: readonly LoggedCommand[], handlers: ReplayHandlers): void {
  for (const command of commands) {
    const result =
      command.entry.kind === "action"
        ? handlers.performAction(command.entry.actionId, command.entry.intent, command.entry.respondingTo)
        : command.entry.kind === "pass"
          ? handlers.pass(command.entry.seatId)
          : handlers.advancePhase();
    if (!result.ok) {
      throw new ReplayDivergenceError(command, result);
    }
  }
}

/**
 * Runs `attempt`, and appends the command to `log` only if it succeeded.
 * The two thin wrappers below are the intended call sites for actually
 * proposing an action or advancing a phase during live play — using them
 * (rather than calling performAction/tryAdvance directly and separately
 * checking `.ok`) is what keeps "only confirmed commands get logged" from
 * needing to be remembered at every call site.
 */
function logIfConfirmed<R extends { ok: boolean }>(log: EventLog, entryIfOk: () => LoggedCommand["entry"], attempt: () => R): R {
  const result = attempt();
  if (result.ok) {
    log.append(entryIfOk());
  }
  return result;
}

export function performActionAndLog<R extends { ok: boolean }>(
  log: EventLog,
  actionId: string,
  intent: ActionContext,
  performAction: () => R,
  respondingTo?: EntityId | null,
): R {
  return logIfConfirmed(log, () => ({ kind: "action", actionId, intent, respondingTo }), performAction);
}

export function advancePhaseAndLog<R extends { ok: boolean }>(log: EventLog, tryAdvance: () => R): R {
  return logIfConfirmed(log, () => ({ kind: "phaseAdvance" }), tryAdvance);
}

/**
 * Logs a "pass" — note this is intentionally NOT gated on the eventual
 * resolution that a pass might trigger (resolving the top of the stack
 * is a deterministic CONSEQUENCE of the pass, driven by whatever rules
 * already fire off Stack's own events — the pass itself, and whether it
 * was legal to make, is the actual command being logged here).
 */
export function passAndLog<R extends { ok: boolean }>(log: EventLog, seatId: EntityId, attempt: () => R): R {
  return logIfConfirmed(log, () => ({ kind: "pass", seatId }), attempt);
}
