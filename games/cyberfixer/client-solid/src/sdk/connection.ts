/**
 * client-solid/src/sdk/connection.ts — framework-agnostic.
 *
 * Thin, typed wrapper around @colyseus/sdk's connect/join — no game
 * logic here, just the transport handshake. Endpoint/protocol detection
 * matches the plain-JS client (games/cyberfixer/client/main.js) this SDK
 * is meant to eventually replace for anyone who wants Solid instead of
 * hand-rolled DOM manipulation.
 */

import { Client, Room } from "@colyseus/sdk";
import type { EntitySchemaInstance } from "../../../../../src/network/schema.ts";

export interface CyberFixerRoomState {
  entities: Map<string, EntitySchemaInstance>;
  seatIdentities: Map<string, string>;
}

export async function connectToCyberFixer(identity: string, endpoint?: string): Promise<Room<CyberFixerRoomState>> {
  const url = endpoint ?? `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}`;
  const client = new Client(url);
  return client.joinOrCreate<CyberFixerRoomState>("cyberfixer", { identity });
}

/** The seat id this client is playing as — resolved once seatIdentities syncs, since seat assignment happens server-side. */
export function findMySeatId(room: Room<CyberFixerRoomState>, identity: string): string | undefined {
  for (const [seatId, seatIdentity] of room.state.seatIdentities) {
    if (seatIdentity === identity) return seatId;
  }
  return undefined;
}
