/**
 * games/cyberfixer/design-sim/sweep.ts
 *
 * Tools for exhausting what the existing four knobs (decayRate,
 * pressureCoefficient, policy, noiseAmplitude) can tell us, before
 * trusting any single-point finding from monte-carlo.ts's simpler
 * helpers. Two things those didn't cover:
 *
 *  - meanTensionAtFraction: mean duration alone can't distinguish "held
 *    near-even, then collapsed fast" from "declined steadily the whole
 *    way" — two very different FEELS that can produce the identical
 *    mean duration. This samples the tension curve at a fixed relative
 *    position (e.g. 50% of each trial's own length) across many trials,
 *    which is scale-invariant — it characterizes SHAPE, not duration.
 *
 *  - sweep2D / findCompensationThreshold: single-point comparisons (as
 *    in monte-carlo.ts's own examples) can't reveal whether a
 *    relationship is monotonic, or whether it's linear vs. threshold-
 *    shaped — that requires a real grid, not five hand-picked values.
 */

import { runSimulation, type SimulationParams } from "./model.ts";
import { catchUpPolicy, constantPolicy } from "./policies.ts";

/** Mean tension at a fixed FRACTION of each trial's own duration (0 = start, 1 = the turn resolution happened) — scale-invariant, so it characterizes shape independent of how long any individual trial ran. */
export function meanTensionAtFraction(paramsWithoutSeed: Omit<SimulationParams, "seed">, fraction: number, trials: number, baseSeed: number): number {
  let sum = 0;
  let count = 0;
  for (let i = 0; i < trials; i++) {
    const result = runSimulation({ ...paramsWithoutSeed, seed: baseSeed + i });
    if (result.history.length === 0) continue;
    const index = Math.min(result.history.length - 1, Math.floor(fraction * (result.history.length - 1)));
    sum += result.history[index]!.tension;
    count++;
  }
  if (count === 0) throw new Error("meanTensionAtFraction: every trial had empty history — trials must be > 0 and maxTurns must be >= 1");
  return sum / count;
}

export interface SweepCell {
  decayRate: number;
  pressureCoefficient: number;
  meanDuration: number;
  unresolvedRate: number;
  /** Mean tension at the halfway point of each trial's own duration — high = "held even until late," low = "decided early, dragged out." */
  tensionAtMidpoint: number;
}

/** A full grid over (decayRate, pressureCoefficient) — deliberately a real grid, not a handful of points, specifically so monotonicity (or its absence) is visible rather than assumed. */
export function sweep2D(
  base: Omit<SimulationParams, "seed" | "decayRate" | "pressureCoefficient">,
  decayRates: readonly number[],
  pressureCoefficients: readonly number[],
  trials: number,
  baseSeed: number,
): SweepCell[] {
  const cells: SweepCell[] = [];
  for (const decayRate of decayRates) {
    for (const pressureCoefficient of pressureCoefficients) {
      const paramsNoSeed = { ...base, decayRate, pressureCoefficient };
      let totalDuration = 0;
      let unresolved = 0;
      for (let i = 0; i < trials; i++) {
        const result = runSimulation({ ...paramsNoSeed, seed: baseSeed + i });
        totalDuration += result.durationTurns;
        if (result.winner === null) unresolved++;
      }
      cells.push({
        decayRate,
        pressureCoefficient,
        meanDuration: totalDuration / trials,
        unresolvedRate: unresolved / trials,
        tensionAtMidpoint: meanTensionAtFraction(paramsNoSeed, 0.5, trials, baseSeed),
      });
    }
  }
  return cells;
}

export interface CompensationPoint {
  /** The weaker-stat agent's catch-up urgencyGain — higher = plays more aggressively in response to falling behind. */
  urgencyGain: number;
  /** Win rate for the WEAKER-stat agent (worse engineMultiplier), which uses catchUpPolicy(baseFraction, urgencyGain) against a naive constant-policy opponent with a real stat advantage. */
  winRateWeaker: number;
}

/**
 * Does a smarter policy compensate for a real, fixed stat disadvantage?
 * Sweeps the weaker agent's catch-up aggression and reports win rate
 * against a stronger, naively-played opponent — a genuine "can skill
 * beat power, and how much skill" question, not answerable from a
 * single comparison.
 */
export function findCompensationCurve(
  weakerEngineMultiplier: number,
  strongerEngineMultiplier: number,
  shared: { baseIncome: number; decayRate: number; pressureCoefficient: number; noiseAmplitude: number; maxTurns: number },
  urgencyGains: readonly number[],
  trialsPerPoint: number,
  baseSeed: number,
): CompensationPoint[] {
  return urgencyGains.map((urgencyGain) => {
    let winsWeaker = 0;
    for (let i = 0; i < trialsPerPoint; i++) {
      const result = runSimulation({
        agentA: { baseIncome: shared.baseIncome, engineMultiplier: weakerEngineMultiplier, policy: catchUpPolicy(0.3, urgencyGain) },
        agentB: { baseIncome: shared.baseIncome, engineMultiplier: strongerEngineMultiplier, policy: constantPolicy(0.3) },
        decayRate: shared.decayRate,
        pressureCoefficient: shared.pressureCoefficient,
        noiseAmplitude: shared.noiseAmplitude,
        maxTurns: shared.maxTurns,
        seed: baseSeed + i,
      });
      if (result.winner === "A") winsWeaker++;
    }
    return { urgencyGain, winRateWeaker: winsWeaker / trialsPerPoint };
  });
}
