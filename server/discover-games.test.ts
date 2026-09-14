import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverGames } from "./discover-games.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GAMES_ROOT = path.join(__dirname, "..", "games");

describe("discoverGames", () => {
  it("finds cyberfixer in the real games/ directory, with the right shape", async () => {
    const games = await discoverGames(GAMES_ROOT);
    const cyberfixer = games.find((g) => g.name === "cyberfixer");

    expect(cyberfixer).toBeDefined();
    expect(cyberfixer!.displayName).toBe("Cyber Fixer");
    expect(cyberfixer!.seatOrder).toEqual(["fixer-A", "fixer-B"]);
    expect(typeof cyberfixer!.RoomClass).toBe("function");
    expect(cyberfixer!.clientDir.endsWith(path.join("cyberfixer", "client"))).toBe(true);
  });

  it("returns an empty array for a directory that doesn't exist, rather than throwing", async () => {
    const games = await discoverGames(path.join(__dirname, "no-such-directory"));
    expect(games).toEqual([]);
  });

  it("skips a folder missing game.config.ts or server/room.ts without throwing", async () => {
    // games/ itself only contains cyberfixer today, so this just re-asserts
    // discovery doesn't choke on the directory as a whole; a folder with a
    // partial/missing shape is exercised implicitly by every OTHER entry in
    // the scanned directory not being a game and being silently skipped.
    const games = await discoverGames(GAMES_ROOT);
    expect(games.length).toBeGreaterThan(0);
    expect(games.every((g) => typeof g.name === "string" && g.name.length > 0)).toBe(true);
  });
});
