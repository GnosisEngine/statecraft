/**
 * games/cyberfixer/design-sim/run.ts
 *
 * Run with: npx tsx games/cyberfixer/design-sim/run.ts
 *
 * Prints three explorations against the abstract model in model.ts:
 * how duration responds to the forcing function (decay), how duration
 * responds to coupling (pressure), and the skill-vs-noise curve. This
 * is the "loose understanding" tool — read the shape of the numbers,
 * don't treat any single value as a real prediction about cyberfixer's
 * actual tuning (see README.md).
 */

import { runBatch, skillVsNoise } from "./monte-carlo.ts";
import { constantPolicy, catchUpPolicy } from "./policies.ts";

const TRIALS = 200;

function printTable(title: string, rows: Array<Record<string, string | number>>) {
  console.log(`\n${title}`);
  if (rows.length === 0) return;
  const columns = Object.keys(rows[0]!);
  const widths = columns.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c]).length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i]!)).join("  ");
  console.log(line(columns));
  console.log(line(widths.map((w) => "-".repeat(w))));
  for (const row of rows) console.log(line(columns.map((c) => String(row[c]))));
}

function main() {
  console.log("=== design-sim: a loose, exploratory read on the framework's core dynamic (NOT cyberfixer's real rules) ===");

  // 1. How does the forcing function (decay) affect duration, holding coupling fixed?
  const decayRows = [0, 0.05, 0.1, 0.2, 0.4].map((decayRate) => {
    const stats = runBatch(
      {
        agentA: { baseIncome: 10, engineMultiplier: 0.6, policy: constantPolicy(0.4) },
        agentB: { baseIncome: 10, engineMultiplier: 0.6, policy: constantPolicy(0.4) },
        decayRate,
        pressureCoefficient: 0.2,
        noiseAmplitude: 2,
        maxTurns: 300,
      },
      TRIALS,
      1,
    );
    return {
      decayRate,
      meanDuration: stats.meanDuration.toFixed(1),
      minDuration: stats.minDuration,
      maxDuration: stats.maxDuration,
      unresolvedOf: `${stats.unresolvedCount}/${stats.trials}`,
    };
  });
  printTable("1. Duration vs. forcing-function strength (decayRate) — coupling and policy held fixed", decayRows);

  // 2. How does coupling (pressure) affect duration, holding decay fixed?
  const pressureRows = [0, 0.05, 0.15, 0.3, 0.6].map((pressureCoefficient) => {
    const stats = runBatch(
      {
        agentA: { baseIncome: 10, engineMultiplier: 0.6, policy: constantPolicy(0.4) },
        agentB: { baseIncome: 10, engineMultiplier: 0.6, policy: constantPolicy(0.4) },
        decayRate: 0.1,
        pressureCoefficient,
        noiseAmplitude: 2,
        maxTurns: 300,
      },
      TRIALS,
      1,
    );
    return {
      pressureCoefficient,
      meanDuration: stats.meanDuration.toFixed(1),
      minDuration: stats.minDuration,
      maxDuration: stats.maxDuration,
      unresolvedOf: `${stats.unresolvedCount}/${stats.trials}`,
    };
  });
  printTable("2. Duration vs. coupling strength (pressureCoefficient) — decay and policy held fixed", pressureRows);

  // 3. Skill-vs-noise: a REAL, fixed skill gap (better engine + better policy) — at what noise level does it stop predicting the winner?
  const points = skillVsNoise(
    {
      agentA: { baseIncome: 10, engineMultiplier: 1.1, policy: catchUpPolicy(0.35, 0.3) },
      agentB: { baseIncome: 10, engineMultiplier: 0.7, policy: catchUpPolicy(0.35, 0.3) },
      decayRate: 0.1,
      pressureCoefficient: 0.25,
      maxTurns: 300,
    },
    [0, 1, 2, 4, 8, 16, 32],
    TRIALS,
    1,
  );
  printTable(
    "3. Skill-vs-noise: fixed skill gap (A has the better engine+policy) — winRateA should fall toward 0.5 as noise rises",
    points.map((p) => ({ noiseAmplitude: p.noiseAmplitude, winRateA: p.winRateA.toFixed(2) })),
  );

  // 4. Does decision-making ALONE (identical stats, only the policy differs) produce a real edge, and how fragile is it to noise?
  const policyOnlyPoints = skillVsNoise(
    {
      agentA: { baseIncome: 10, engineMultiplier: 0.8, policy: catchUpPolicy(0.3, 0.4) }, // reacts to falling behind
      agentB: { baseIncome: 10, engineMultiplier: 0.8, policy: constantPolicy(0.3) }, // naive, fixed-fraction — IDENTICAL stats otherwise
      decayRate: 0.1,
      pressureCoefficient: 0.25,
      maxTurns: 300,
    },
    [0, 1, 2, 4, 8, 16],
    TRIALS,
    1,
  );
  printTable(
    "4. Skill-vs-noise, POLICY ONLY (identical stats — a smarter catch-up policy vs. a naive constant one)",
    policyOnlyPoints.map((p) => ({ noiseAmplitude: p.noiseAmplitude, winRateA: p.winRateA.toFixed(2) })),
  );
  console.log(
    "   Note: compare row noiseAmplitude=0 here to table 3's row 0 — a pure DECISION edge can be just as decisive as a stat edge\n" +
      "   at zero noise, but decays toward 0.5 much FASTER as noise rises (already ~0.68 at noise=1, vs. table 3 staying near 1.0\n" +
      "   until noise=8+). If decision-making is meant to be as robust a source of edge as raw stats, that asymmetry is worth\n" +
      "   knowing about now, not discovering after real numbers are tuned.",
  );

  console.log("\n(See DESIGN_FRAMEWORK.md §1 and this directory's README.md for what these numbers do and don't claim to show.)");
}

main();
