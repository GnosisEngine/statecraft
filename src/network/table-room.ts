/**
 * Layer 9.1 — Room lifecycle & seat assignment: TableRoom.
 *
 * Thin Colyseus glue: everything that's actually decision logic
 * (which seat does this identity get, is the table full) lives in
 * SeatAssigner/ConnectionTracker, which know nothing about Colyseus and
 * are tested without booting a room at all. This file's only job is
 * translating Colyseus's onJoin/onLeave lifecycle into calls against
 * that logic, plus exposing the result as room state.
 *
 * Reconnection has two layers, deliberately: (1) identity-keyed seat
 * persistence (SeatAssigner.claimSeat is idempotent per identity — a
 * brand new connection with the same identity gets the same seat back,
 * no special reconnection flow needed) is the primary, robust mechanism;
 * (2) Colyseus's own allowReconnection, called from onDrop (fired on an
 * UNCONSENTED disconnect — Colyseus 0.18 splits this from onLeave, which
 * now fires only once a client is finally, definitively gone) is layered
 * on top as a latency optimization for the SAME session resuming quickly.
 * If (2)'s grace window expires, (1) still holds — the seat was never
 * released, so a later fresh join finds it again.
 */

import { Client, Room } from "colyseus";
import { schema, t } from "@colyseus/schema";
import type { EntityId } from "../core/id.ts";
import { SeatMap } from "../forking/seat-map.ts";
import { ConnectionTracker } from "./connection-tracker.ts";
import { EntitySchema } from "./schema.ts";
import { NoFreeSeatsError, SeatAssigner } from "./seat-assigner.ts";

/**
 * `entities` is declared here, in the SAME schema() call as the seat
 * fields — not added later via `.extend()`. A `.view()`-tagged field
 * grafted on through `.extend()` was confirmed (by direct testing, not
 * assumption) to NOT isolate correctly per-client in @colyseus/schema
 * 5.0.27: a second client ended up seeing entries only ever added to the
 * first client's view. Fields declared together in one schema() call
 * don't have this problem — so the fix is structural, not a workaround.
 */
export const TableRoomState = schema(
  {
    /** seatId -> identity, mirroring SeatMap for clients to render "who's seated". */
    seatIdentities: t.map("string"),
    /** seatId -> live connection status, independent of ownership. */
    seatConnected: t.map("boolean"),
    /** Entity mirror (Layer 9.4's SyncManager writes here) — invisible per-client until explicitly added to that client's StateView. */
    entities: t.map(EntitySchema).view(),
  },
  "TableRoomState",
);

export interface TableRoomCreateOptions {
  seatOrder: EntityId[];
  /** Seconds to wait for the same session to reconnect after an unexpected drop before falling back to identity-keyed rejoin. */
  reconnectionGraceSeconds?: number;
}

export interface TableRoomJoinOptions {
  identity: string;
}

/** Default grace window for the reconnection layer that sits on top of identity-keyed seat persistence. */
const DEFAULT_RECONNECTION_GRACE_SECONDS = 20;

/** Broadcast chat shape — not part of synced schema state (see onCreate's chat handler for why). */
export interface ChatMessage {
  seatId: EntityId;
  identity: string;
  text: string;
  at: number;
}

const MAX_CHAT_MESSAGE_LENGTH = 500;

export class TableRoom extends Room<{ state: InstanceType<typeof TableRoomState> }> {
  private seatAssigner!: SeatAssigner;
  private connectionTracker!: ConnectionTracker;
  private sessionToSeat = new Map<string, EntityId>();
  private reconnectionGraceSeconds = DEFAULT_RECONNECTION_GRACE_SECONDS;

  /**
   * Overridable so a subclass with a richer state shape can supply its
   * own instance without ever calling setState twice. CAUTION: only
   * extend with fields that don't need per-client filtering — adding a
   * NEW `.view()`-tagged field via `.extend()` was confirmed not to
   * isolate correctly per-client in this schema library version (see the
   * comment on TableRoomState above). Any view-tagged field has to be
   * declared in TableRoomState's own schema() call, not grafted on later.
   */
  protected createState(): InstanceType<typeof TableRoomState> {
    return new TableRoomState();
  }

  onCreate(options: TableRoomCreateOptions): void {
    this.setState(this.createState());
    this.seatAssigner = new SeatAssigner(new SeatMap(), options.seatOrder);
    this.connectionTracker = new ConnectionTracker();
    if (options.reconnectionGraceSeconds !== undefined) {
      this.reconnectionGraceSeconds = options.reconnectionGraceSeconds;
    }
    // A match in progress shouldn't vanish just because the connected
    // client count briefly hits zero (every player disconnected at once,
    // or one player deliberately left to reconnect from another device) —
    // that's a lobby-room default, not appropriate for a persistent match.
    // Disposal here is an explicit decision (e.g. Match reaching
    // "complete", or an admin/idle-timeout action), not automatic.
    this.autoDispose = false;

    // Ephemeral chat: broadcast-only, not stored in synced schema state
    // (that's for game state, not conversation) and not persisted for a
    // reconnecting client — a real limitation, not silently glossed over.
    // Generic here in TableRoom rather than per-game content because
    // nothing about it needs to know what game is being played.
    this.onMessage("chat", (client: Client, message: { text?: unknown }) => {
      const seatId = this.seatOf(client.sessionId);
      if (!seatId) return;
      const text = typeof message?.text === "string" ? message.text.slice(0, MAX_CHAT_MESSAGE_LENGTH).trim() : "";
      if (!text) return; // silently ignore empty/invalid — not worth an error round-trip
      const identity = this.state.seatIdentities.get(seatId) ?? seatId;
      const chatMessage: ChatMessage = { seatId, identity, text, at: Date.now() };
      this.broadcast("chat", chatMessage);
    });
  }

  onJoin(client: Client, options: TableRoomJoinOptions): void {
    let seatId: EntityId;
    try {
      seatId = this.seatAssigner.claimSeat(options.identity);
    } catch (err) {
      if (err instanceof NoFreeSeatsError) {
        throw new Error(`Table is full (${this.seatAssigner.seats.length} seats)`);
      }
      throw err;
    }

    this.sessionToSeat.set(client.sessionId, seatId);
    this.connectionTracker.setConnected(seatId, true);
    this.state.seatIdentities.set(seatId, options.identity);
    this.state.seatConnected.set(seatId, true);
  }

  /**
   * Fires on an UNCONSENTED disconnect (0.18.5 splits this from onLeave —
   * see file header). This is the hook for attempting reconnection; if it
   * resolves, the same seat is re-mapped onto whatever session comes back.
   * If it rejects (grace window expired), seat ownership is still
   * untouched — SeatAssigner never released it.
   */
  async onDrop(client: Client): Promise<void> {
    const seatId = this.sessionToSeat.get(client.sessionId);
    if (seatId === undefined) return;

    this.connectionTracker.setConnected(seatId, false);
    this.state.seatConnected.set(seatId, false);

    try {
      const reconnectedClient = await this.allowReconnection(client, this.reconnectionGraceSeconds);
      this.sessionToSeat.set(reconnectedClient.sessionId, seatId);
      this.connectionTracker.setConnected(seatId, true);
      this.state.seatConnected.set(seatId, true);
    } catch {
      // Grace window expired — nothing further to do here; see onLeave.
    }
  }

  /** Fires when a client is finally, definitively gone (consented leave, or a dropped session whose reconnection window expired). */
  onLeave(client: Client): void {
    const seatId = this.sessionToSeat.get(client.sessionId);
    if (seatId !== undefined) {
      this.connectionTracker.setConnected(seatId, false);
      this.state.seatConnected.set(seatId, false);
    }
    this.sessionToSeat.delete(client.sessionId);
  }

  /** Which seat a currently-connected session occupies, if any. */
  seatOf(sessionId: string): EntityId | undefined {
    return this.sessionToSeat.get(sessionId);
  }
}
