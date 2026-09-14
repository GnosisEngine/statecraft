/**
 * games/cyberfixer/design-sim/exhaust.ts
 *
 * Run with: npx tsx games/cyberfixer/design-sim/exhaust.ts
 *
 * The systematic follow-up to run.ts's five-point spot checks: full
 * grids over (decayRate, pressureCoefficient) reporting BOTH duration
 * and shape (tensionAtMidpoint), plus a real compensation curve for
 * "can a smarter policy overcome a stat disadvantage, and by how much."
 * Point of this file is to look for monotonicity (or its absence) and
 * threshold effects that five hand-picked points can't reveal — read
 * the actual numbers below, don't assume the shape ahead of running it.
 */

import { sweep2D, findCompensationCurve, meanTensionAtFraction } from "./sweep.ts";
import { runSimulation } from "./model.ts";
import { runBatch } from "./monte-carlo.ts";
import { constantPolicy } from "./policies.ts";

const TRIALS = 150;

function printGrid(title: string, rows: readonly number[], cols: readonly number[], cellValue: (r: number, c: number) => string, rowLabel: string, colLabel: string) {
  console.log(`\n${title}`);
  const colWidth = 8;
  const header = `${rowLabel}\\${colLabel}`.padEnd(10) + cols.map((c) => String(c).padStart(colWidth)).join("");
  console.log(header);
  for (const r of rows) {
    console.log(String(r).padEnd(10) + cols.map((c) => cellValue(r, c).padStart(colWidth)).join(""));
  }
}

function main() {
  const decayRates = [0, 0.05, 0.1, 0.2, 0.4];
  const pressureCoefficients = [0, 0.05, 0.1, 0.2, 0.4, 0.8];

  const base = {
    agentA: { baseIncome: 10, engineMultiplier: 0.6, policy: constantPolicy(0.4) },
    agentB: { baseIncome: 10, engineMultiplier: 0.6, policy: constantPolicy(0.4) },
    noiseAmplitude: 2,
    maxTurns: 300,
  };

  const cells = sweep2D(base, decayRates, pressureCoefficients, TRIALS, 1);
  const cell = (decayRate: number, pressureCoefficient: number) => cells.find((c) => c.decayRate === decayRate && c.pressureCoefficient === pressureCoefficient)!;

  console.log("=== Full grid: decayRate (rows) x pressureCoefficient (cols) — symmetric agents ===");
  printGrid("Mean duration (turns)", decayRates, pressureCoefficients, (d, p) => cell(d, p).meanDuration.toFixed(1), "decay", "pressure");
  printGrid("Unresolved rate (0-1)", decayRates, pressureCoefficients, (d, p) => cell(d, p).unresolvedRate.toFixed(2), "decay", "pressure");
  printGrid("Tension at midpoint (0-1, higher = held even longer before deciding)", decayRates, pressureCoefficients, (d, p) => cell(d, p).tensionAtMidpoint.toFixed(2), "decay", "pressure");

  console.log(
    "\nRead the duration grid column-by-column (fixed pressure, varying decay) and row-by-row (fixed decay, varying\n" +
      "pressure) separately — don't assume monotonicity in either direction from the earlier 5-point spot checks.",
  );

  // Compensation curve: how much smarter-policy urgency does a stat-disadvantaged agent need?
  console.log("\n\n=== Compensation curve: weaker engine (0.4) + adaptive policy vs. stronger engine (0.9) + naive policy ===");
  const urgencyGains = [0, 0.3, 0.8, 1.2, 1.5, 2, 2.5, 3, 4, 5];
  const compensation = findCompensationCurve(0.4, 0.9, { baseIncome: 10, decayRate: 0.1, pressureCoefficient: 0.25, noiseAmplitude: 1, maxTurns: 300 }, urgencyGains, 300, 1);
  console.log("urgencyGain".padEnd(15) + "winRate(weaker agent)");
  for (const point of compensation) console.log(String(point.urgencyGain).padEnd(15) + point.winRateWeaker.toFixed(3));
  console.log(
    "\nNOTE: an earlier draft of this script sampled only up to urgencyGain=1.2 and reported a flat 0.000 across the\n" +
      "board — which LOOKED like 'no amount of policy aggression compensates for this stat gap,' but was actually just\n" +
      "sampling too narrow a range to see where the effect kicks in. See exhaust.ts's own git history / the surrounding\n" +
      "chat for how that got caught (widening the range against a known-good sanity check) rather than reported as-is.",
  );

  console.log("\n(See DESIGN_FRAMEWORK.md §1 and this directory's README.md for what these numbers do and don't claim to show.)");

  // Tier 2: does making the outflow cap actually BIND change anything,
  // compared to today's real cyberfixer tuning where it never does?
  console.log("\n\n=== Tier 2: outflow cap — undefined (uncapped, today's real tuning) vs. progressively tighter outflowGrantRate ===");
  const outflowRates: Array<number | undefined> = [undefined, 5, 1, 0.5, 0.2, 0.1, 0.05];
  const tier2Base = {
    agentA: { baseIncome: 10, engineMultiplier: 0.5, policy: constantPolicy(0.5), initialCommitted: 3 },
    agentB: { baseIncome: 10, engineMultiplier: 0.5, policy: constantPolicy(0.5), initialCommitted: 3 },
    decayRate: 0.1,
    pressureCoefficient: 0.2,
    noiseAmplitude: 1,
    maxTurns: 300,
  };
  console.log("outflowGrantRate".padEnd(18) + "meanDuration".padEnd(14) + "unresolvedRate".padEnd(16) + "tensionAtMid".padEnd(14) + "meanFinalCommitted");
  for (const rate of outflowRates) {
    const paramsNoSeed = {
      agentA: { ...tier2Base.agentA, outflowGrantRate: rate },
      agentB: { ...tier2Base.agentB, outflowGrantRate: rate },
      decayRate: tier2Base.decayRate,
      pressureCoefficient: tier2Base.pressureCoefficient,
      noiseAmplitude: tier2Base.noiseAmplitude,
      maxTurns: tier2Base.maxTurns,
    };
    const stats = runBatch(paramsNoSeed, TRIALS, 1);
    const tensionMid = meanTensionAtFraction(paramsNoSeed, 0.5, TRIALS, 1);
    let totalFinalCommitted = 0;
    for (let i = 0; i < TRIALS; i++) {
      const result = runSimulation({ ...paramsNoSeed, seed: 1 + i });
      totalFinalCommitted += result.history[result.history.length - 1]!.agentA.committed;
    }
    console.log(
      String(rate ?? "undefined").padEnd(18) +
        stats.meanDuration.toFixed(1).padEnd(14) +
        stats.unresolvedCount.toString().concat(`/${stats.trials}`).padEnd(16) +
        tensionMid.toFixed(2).padEnd(14) +
        (totalFinalCommitted / TRIALS).toFixed(1),
    );
  }
  console.log("\n(See this directory's README.md for the honest read on what this experiment does and doesn't establish.)");
}

main();
