/**
 * games/cyberfixer/design-sim/monte-carlo.ts
 *
 * Batch-runs model.ts's simulation across many seeds to get
 * distributions rather than a single (possibly unrepresentative) run,
 * and a dedicated experiment for DESIGN_FRAMEWORK.md §1's core
 * discipline: at what noise level does a fixed skill differential
 * stop predicting the outcome?
 */

import { runSimulation, type SimulationParams, type SimulationResult } from "./model.ts";

export interface DurationStats {
  trials: number;
  /** How many trials hit maxTurns without either agent going bankrupt — a HIGH unresolvedRate at some parameter combination is itself a finding: the forcing function isn't actually binding under those settings (see model.ts's maxTurns doc comment). */
  unresolvedCount: number;
  meanDuration: number;
  minDuration: number;
  maxDuration: number;
  /** Sorted list of every trial's duration (including unresolved trials, capped at maxTurns) — for callers that want percentiles/a histogram beyond mean/min/max. */
  durations: number[];
}

/** Runs `trials` independent simulations, one per seed offset from `baseSeed`, and summarizes durations. Independent params objects per trial are NOT needed — model.ts never mutates its input (see the fix in model.ts's own history), so the same `params` (minus `seed`) is safe to reuse across every trial. */
export function runBatch(paramsWithoutSeed: Omit<SimulationParams, "seed">, trials: number, baseSeed: number): DurationStats {
  const durations: number[] = [];
  let unresolvedCount = 0;

  for (let i = 0; i < trials; i++) {
    const result = runSimulation({ ...paramsWithoutSeed, seed: baseSeed + i });
    durations.push(result.durationTurns);
    if (result.winner === null) unresolvedCount++;
  }

  durations.sort((a, b) => a - b);
  return {
    trials,
    unresolvedCount,
    meanDuration: durations.reduce((sum, d) => sum + d, 0) / trials,
    minDuration: durations[0] ?? 0,
    maxDuration: durations[durations.length - 1] ?? 0,
    durations,
  };
}

export interface SkillVsNoisePoint {
  noiseAmplitude: number;
  /** Fraction of trials the (presumed better) agentA actually won, at this noise level. */
  winRateA: number;
}

/**
 * The skill-vs-variance experiment named in DESIGN_FRAMEWORK.md §1:
 * fixes a skill differential between the two agents (whatever
 * paramsWithoutSeedOrNoise's agentA/agentB already encode — a better
 * engineMultiplier, a better policy, etc.), then runs a batch at each
 * noise level in `noiseAmplitudes` and reports how often the
 * presumably-better agent (A) still wins. A skill differential that's
 * real should show winRateA well above 0.5 at low noise, decaying
 * toward 0.5 as noise rises — the noise level where it actually
 * reaches ~0.5 is the point past which this parameter combination has
 * crossed from depth-driven into variance-driven, per §1's own
 * discipline.
 */
export function skillVsNoise(
  paramsWithoutSeedOrNoise: Omit<SimulationParams, "seed" | "noiseAmplitude">,
  noiseAmplitudes: number[],
  trialsPerLevel: number,
  baseSeed: number,
): SkillVsNoisePoint[] {
  return noiseAmplitudes.map((noiseAmplitude) => {
    let winsA = 0;
    for (let i = 0; i < trialsPerLevel; i++) {
      const result: SimulationResult = runSimulation({ ...paramsWithoutSeedOrNoise, noiseAmplitude, seed: baseSeed + i });
      if (result.winner === "A") winsA++;
    }
    return { noiseAmplitude, winRateA: winsA / trialsPerLevel };
  });
}
