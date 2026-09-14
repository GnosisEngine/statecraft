/**
 * games/cyberfixer — game manifest.
 *
 * The root server (server/discover-games.ts) scans games/*​/game.config.ts
 * for exactly this shape. `name` is what everything else derives from:
 * the Colyseus room name clients join under, and the URL path segment
 * this game's client assets are served at (/games/<name>/...).
 */

import type { EntityId } from "../../src/core/id.ts";

export interface GameConfig {
  name: string;
  displayName: string;
  /** Seating order for a match — fixed at 2 for this simple example. */
  seatOrder: EntityId[];
}

export const gameConfig: GameConfig = {
  name: "cyberfixer",
  displayName: "Cyber Fixer",
  seatOrder: ["fixer-A", "fixer-B"],
};
