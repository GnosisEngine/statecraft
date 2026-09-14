/**
 * Layer 7 — SeededRandom.
 *
 * Any randomness in game logic (shuffling a deck, a random target, a coin
 * flip) MUST go through this, never Math.random() — that's what makes
 * replay and forking (Layer 8) reproducible. The seed itself belongs in
 * the EventLog (see event-log.ts) as the one piece of match setup that
 * has to be recorded for a replay to reconstruct the same sequence.
 *
 * mulberry32: small, fast, good-enough statistical quality for game
 * logic, and deterministic across JS engines given the same seed —
 * that last property is the actual requirement here, not raw quality.
 */

export class SeededRandom {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Next float in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Next integer in [0, maxExclusive). */
  nextInt(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }

  /** Fisher-Yates shuffle. Returns a new array — does not mutate the input. */
  shuffle<T>(items: readonly T[]): T[] {
    const result = [...items];
    for (let i = result.length - 1; i > 0; i--) {
      const j = this.nextInt(i + 1);
      [result[i], result[j]] = [result[j]!, result[i]!];
    }
    return result;
  }
}

/**
 * Derives an independent, deterministic seed for one named domain from a
 * single master seed (e.g. `deriveSeed(matchSeed, "fixer-A:deck")`). Two
 * domains' streams never interact — not "hard to correlate," genuinely
 * independent — because each SeededRandom is constructed once, upfront,
 * purely as a function of (masterSeed, domain). How many random calls
 * happen in one domain can never shift where another domain's stream
 * starts or what it produces next, which matters specifically for
 * per-fixer hidden state (a deck's draw pool): a single shared stream
 * would let the TIMING/ORDER of unrelated random-consuming actions
 * anywhere in the match perturb what a fixer's own deck draws next.
 * FNV-1a mix of the domain string, folded with an extra avalanche pass
 * so the output has no visible structure relative to the inputs — same
 * "deterministic across JS engines" requirement as mulberry32 itself,
 * not cryptographic-strength mixing.
 */
export function deriveSeed(masterSeed: number, domain: string): number {
  let h = (masterSeed ^ 0x9e3779b9) >>> 0;
  for (let i = 0; i < domain.length; i++) {
    h ^= domain.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0; // FNV prime
  }
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * A fresh 32-bit seed, generated via crypto — deliberately NOT via
 * SeededRandom itself. This is a one-time, non-game-logic action, same
 * category as EntityId/Modifier id generation (see core/id.ts): it
 * happens once at creation time, gets logged/stored as data (a
 * ForkRecord's `seed` field — see forking/fork-record.ts), and is never
 * re-derived during replay. Determinism only requires that GAME LOGIC
 * never call Math.random() directly; minting a new seed for a new
 * branch is administrative, like minting a new entity id.
 */
export function randomSeed(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0]!;
}

export interface DiceRoll {
  sides: number;
  count: number;
  /** Individual results, each in [1, sides]. */
  rolls: number[];
  total: number;
}

/** Rolls `count` dice with `sides` faces each, via the given generator. Results are 1-indexed (a d6 rolls 1..6), matching how dice are actually read at the table. */
export function rollDice(random: SeededRandom, sides: number, count = 1): DiceRoll {
  const rolls: number[] = [];
  for (let i = 0; i < count; i++) {
    rolls.push(random.nextInt(sides) + 1);
  }
  return { sides, count, rolls, total: rolls.reduce((a, b) => a + b, 0) };
}
