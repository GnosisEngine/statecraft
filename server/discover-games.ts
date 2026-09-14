/**
 * server/discover-games.ts
 *
 * Scans a games/ directory for subfolders that look like a game: each
 * must have a game.config.ts (see games/cyberfixer/game.config.ts for
 * the shape) and a server/room.ts default-exporting a Colyseus Room
 * class. That folder name becomes BOTH the Colyseus room name clients
 * join under AND the URL path segment its client assets are served at
 * (/games/<name>) — one name, two addressing schemes, kept in sync by
 * construction rather than configured twice.
 */

import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Room } from "@colyseus/core";
import type { EntityId } from "../src/core/id.ts";

export interface DiscoveredGame {
  name: string;
  displayName: string;
  /** Absolute path to games/<name>. */
  dir: string;
  /** Absolute path to games/<name>/client — mounted at /games/<name>. */
  clientDir: string;
  seatOrder: EntityId[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  RoomClass: new (...args: any[]) => Room;
}

/** Scans `gamesRootDir` for valid game folders. Skips (does not throw on) anything that doesn't match the expected shape — a stray non-game folder shouldn't take the whole server down. */
export async function discoverGames(gamesRootDir: string): Promise<DiscoveredGame[]> {
  if (!existsSync(gamesRootDir)) return [];

  const entries = readdirSync(gamesRootDir, { withFileTypes: true }).filter((e) => e.isDirectory());
  const games: DiscoveredGame[] = [];

  for (const entry of entries) {
    const dir = path.join(gamesRootDir, entry.name);
    const configPath = path.join(dir, "game.config.ts");
    const roomPath = path.join(dir, "server", "room.ts");
    if (!existsSync(configPath) || !existsSync(roomPath)) continue;

    const configModule = await import(pathToFileURL(configPath).href);
    const roomModule = await import(pathToFileURL(roomPath).href);

    const config = configModule.gameConfig;
    const RoomClass = roomModule.default;
    if (!config || !RoomClass) continue;

    games.push({
      name: config.name,
      displayName: config.displayName,
      dir,
      clientDir: path.join(dir, "client"),
      seatOrder: config.seatOrder,
      RoomClass,
    });
  }

  return games;
}
