/**
 * server/index.ts — the one process that hosts every game in games/.
 *
 * "www.games.io/games/cyberfixer" resolves in two parts, deliberately:
 * this file serves games/cyberfixer/client/* as static assets at that
 * URL path (what a browser loads), and that client's JS then makes a
 * normal Colyseus matchmaking call — joinOrCreate("cyberfixer", ...) —
 * against this SAME server's WebSocket endpoint. There is no separate
 * "server instance per game": one Colyseus Server process hosts every
 * registered room type; "cyberfixer" is a room NAME, not a distinct
 * process or port. That's the standard, correct way to host multiple
 * game types behind one Colyseus deployment — a literal server-per-game
 * would mean a separate process/port per game, which is unnecessary
 * complexity this doesn't need.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { defineRoom, type RegisteredHandler } from "@colyseus/core";
import { listen } from "@colyseus/tools";
import { discoverGames } from "./discover-games.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GAMES_ROOT = path.join(__dirname, "..", "games");
const COLYSEUS_SDK_BROWSER_BUNDLE = path.join(__dirname, "..", "node_modules", "@colyseus", "sdk", "dist", "colyseus.js");

const PORT = Number(process.env.PORT ?? 2567);

async function main(): Promise<void> {
  const games = await discoverGames(GAMES_ROOT);
  if (games.length === 0) {
    console.warn(`No games found under ${GAMES_ROOT} — check that each game folder has game.config.ts and server/room.ts`);
  }

  const rooms: Record<string, RegisteredHandler> = {};
  for (const game of games) {
    // seatOrder from game.config.ts becomes this room's DEFAULT creation
    // option — a joining client never has to know or send it.
    rooms[game.name] = defineRoom(game.RoomClass, { seatOrder: game.seatOrder });
  }

  await listen(
    {
      rooms,
      initializeExpress: (app: express.Express) => {
        app.get("/vendor/colyseus.js", (_req, res) => res.sendFile(COLYSEUS_SDK_BROWSER_BUNDLE));

        app.get("/games", (_req, res) => {
          res.json(games.map((g) => ({ name: g.name, displayName: g.displayName, url: `/games/${g.name}/` })));
        });

        for (const game of games) {
          app.use(`/games/${game.name}`, express.static(game.clientDir));
        }
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    PORT,
  );

  console.log(`Listening on :${PORT} — games: ${games.map((g) => g.name).join(", ") || "(none)"}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
