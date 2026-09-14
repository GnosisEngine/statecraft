/**
 * client-solid/src/sdk/actions.ts — framework-agnostic.
 *
 * Typed senders and result listeners for the three message kinds any
 * TableRoom-based game speaks (src/network/table-room.ts's "chat" is
 * generic to every game; "action"/"phaseAdvance" are what CyberFixerRoom
 * specifically handles). Reuses the SERVER's own wire-shape types
 * directly (RawActionIntent, ChatMessage) rather than re-declaring
 * similar-looking ones — "share the types" means literally this, not
 * "keep two structurally-similar definitions in sync by hand."
 */

import type { Room } from "@colyseus/sdk";
import type { RawActionIntent } from "../../../../../src/network/intent.ts";
import type { ChatMessage } from "../../../../../src/network/table-room.ts";
import type { ActionResult } from "../../../../../src/actions/pipeline.ts";
import type { EntityId } from "../../../../../src/core/id.ts";

export function sendAction(room: Room, actionId: string, performerId: EntityId, targetIds: EntityId[] = [], params?: Record<string, unknown>): void {
  const message: RawActionIntent = { actionId, performerId, targetIds, params };
  room.send("action", message);
}

export function sendPhaseAdvance(room: Room): void {
  room.send("phaseAdvance", {});
}

export function sendChat(room: Room, text: string): void {
  room.send("chat", { text });
}

export function onActionResult(room: Room, listener: (result: ActionResult) => void): void {
  room.onMessage("action-result", listener);
}

export function onPhaseResult(room: Room, listener: (result: { ok: boolean; reason?: string }) => void): void {
  room.onMessage("phase-result", listener);
}

export function onChat(room: Room, listener: (message: ChatMessage) => void): void {
  room.onMessage("chat", listener);
}
