/**
 * games/cyberfixer/design-sim/search-run.ts
 *
 * Run with: npx tsx games/cyberfixer/design-sim/search-run.ts
 *
 * Searches a grid over (decayRate, pressureCoefficient, outflowGrantRate,
 * convertFraction) for regimes matching TARGET below — sustained,
 * near-even tension through most of the match, a real late collapse
 * rather than a long fade, a reasonable duration, and reliable
 * resolution. Prints the top candidates AND, separately, whether any
 * candidate actually passes every threshold — those are different
 * questions, and conflating "best of what we tried" with "actually hit
 * the target" is exactly the mistake this script is written to avoid.
 */

import { searchShapeSpace, type ShapeTarget } from "./shape-search.ts";
import { constantPolicy } from "./policies.ts";
import type { SimulationParams } from "./model.ts";

// A first-cut operationalization of "the desired shape" from
// DESIGN_FRAMEWORK.md — adjust these thresholds directly if they don't
// match what "good" should mean; they are a starting position, not a
// derived or validated definition.
const TARGET: ShapeTarget = {
  minDuration: 12,
  maxDuration: 35,
  maxUnresolvedRate: 0.03,
  minSustainedTension: 0.75,
  minDeclineOnsetFraction: 0.7,
};

interface Regime {
  decayRate: number;
  pressureCoefficient: number;
  outflowGrantRate?: number;
  convertFraction: number;
}

function buildParams(regime: Regime): Omit<SimulationParams, "seed"> {
  return {
    agentA: { baseIncome: 10, engineMultiplier: 0.5, policy: constantPolicy(regime.convertFraction), outflowGrantRate: regime.outflowGrantRate, initialCommitted: regime.outflowGrantRate !== undefined ? 3 : undefined },
    agentB: { baseIncome: 10, engineMultiplier: 0.5, policy: constantPolicy(regime.convertFraction), outflowGrantRate: regime.outflowGrantRate, initialCommitted: regime.outflowGrantRate !== undefined ? 3 : undefined },
    decayRate: regime.decayRate,
    pressureCoefficient: regime.pressureCoefficient,
    noiseAmplitude: 1,
    maxTurns: 300,
  };
}

function buildGrid(): Regime[] {
  const decayRates = [0, 0.05, 0.1, 0.2];
  const pressureCoefficients = [0.02, 0.05, 0.1, 0.2, 0.3, 0.5];
  const outflowGrantRates: Array<number | undefined> = [undefined, 1, 0.3, 0.1];
  const convertFractions = [0.2, 0.4, 0.6, 0.8];

  const regimes: Regime[] = [];
  for (const decayRate of decayRates) {
    for (const pressureCoefficient of pressureCoefficients) {
      for (const outflowGrantRate of outflowGrantRates) {
        for (const convertFraction of convertFractions) {
          regimes.push({ decayRate, pressureCoefficient, outflowGrantRate, convertFraction });
        }
      }
    }
  }
  return regimes;
}

function main() {
  const grid = buildGrid();
  console.log(`Searching ${grid.length} candidate regimes (${grid.length * 60} total simulation runs at 60 trials/candidate)...`);
  const started = Date.now();
  const results = searchShapeSpace(grid, TARGET, buildParams, 60, 1);
  console.log(`Done in ${((Date.now() - started) / 1000).toFixed(1)}s.\n`);

  const passing = results.filter((r) => r.passesTarget);
  console.log(`${passing.length} of ${results.length} candidates PASS every threshold in TARGET.\n`);

  const header = "decay  pressure  outflowRate  convert  | duration  unresolved  sustainedTension  declineOnset  score  passes";
  console.log(header);
  console.log("-".repeat(header.length));
  const row = (r: (typeof results)[number]) =>
    [
      String(r.regime.decayRate).padEnd(7),
      String(r.regime.pressureCoefficient).padEnd(10),
      String(r.regime.outflowGrantRate ?? "none").padEnd(13),
      String(r.regime.convertFraction).padEnd(9),
      "|",
      r.metrics.meanDuration.toFixed(1).padEnd(11),
      r.metrics.unresolvedRate.toFixed(2).padEnd(13),
      r.sustainedTension.toFixed(2).padEnd(19),
      r.metrics.meanDeclineOnsetFraction.toFixed(2).padEnd(14),
      r.score.toFixed(2).padEnd(7),
      r.passesTarget ? "YES" : "no",
    ].join(" ");

  console.log("\nTop 15 by score (regardless of whether they pass):");
  for (const r of results.slice(0, 15)) console.log(row(r));

  if (passing.length > 0) {
    console.log("\nAll regimes that actually PASS every threshold:");
    for (const r of passing) console.log(row(r));
  } else {
    console.log("\nNo regime in this grid passes every threshold. See which constraint is closest to being met in the top-15 list above, and widen the grid or relax TARGET accordingly — don't treat 'best of a failing batch' as a recommendation.");
  }
}

main();
