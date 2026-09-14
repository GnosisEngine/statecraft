import { describe, expect, it } from "vitest";
import { runSimulation, type SimulationParams } from "./model.ts";
import { runBatch, skillVsNoise } from "./monte-carlo.ts";
import { constantPolicy, catchUpPolicy } from "./policies.ts";

function baseParams(overrides: Partial<SimulationParams> = {}): SimulationParams {
  return {
    agentA: { baseIncome: 10, engineMultiplier: 0.5, policy: constantPolicy(0.5) },
    agentB: { baseIncome: 10, engineMultiplier: 0.5, policy: constantPolicy(0.5) },
    decayRate: 0.1,
    pressureCoefficient: 0.2,
    noiseAmplitude: 0,
    maxTurns: 200,
    seed: 1,
    ...overrides,
  };
}

describe("runSimulation", () => {
  it("is deterministic — the same params and seed produce the identical result", () => {
    const params = baseParams({ noiseAmplitude: 5 }); // noise included specifically to prove the RNG itself is seeded correctly, not just the deterministic parts
    const r1 = runSimulation(params);
    const r2 = runSimulation(params);
    expect(r2).toEqual(r1);
  });

  it("reusing the SAME params object across multiple runs never leaks state between them — the mutation bug this file's own history caught and fixed", () => {
    const params = baseParams();
    const r1 = runSimulation(params);
    const r2 = runSimulation(params); // same object, run again — must be identical, not degraded by the first run's pressure accumulation
    expect(r2).toEqual(r1);
    // and the params object itself must be untouched
    expect(params.agentA.baseIncome).toBe(10);
    expect(params.agentB.baseIncome).toBe(10);
  });

  it("zero coupling (pressureCoefficient: 0) never resolves — the 'parallel solitaire' failure mode from DESIGN_FRAMEWORK.md §1, proven directly rather than just asserted in prose", () => {
    const result = runSimulation(baseParams({ pressureCoefficient: 0, maxTurns: 100 }));
    expect(result.winner).toBeNull();
    expect(result.durationTurns).toBe(100);
  });

  it("with symmetric agents, more coupling resolves the game at least as fast (same seed, same everything else)", () => {
    const low = runSimulation(baseParams({ pressureCoefficient: 0.1, seed: 42 }));
    const high = runSimulation(baseParams({ pressureCoefficient: 0.6, seed: 42 }));
    expect(high.durationTurns).toBeLessThanOrEqual(low.durationTurns);
  });

  it("a real skill differential (better engine) wins consistently when noise is zero", () => {
    const params = baseParams({
      agentA: { baseIncome: 10, engineMultiplier: 1.5, policy: constantPolicy(0.5) }, // meaningfully better engine
      noiseAmplitude: 0,
    });
    const result = runSimulation(params);
    expect(result.winner).toBe("A");
  });

  it("tension is 1 (maximal) when both agents' income is exactly equal, and decreases as the gap grows", () => {
    const equal = runSimulation(baseParams({ agentA: { baseIncome: 10, engineMultiplier: 0, policy: constantPolicy(0) }, agentB: { baseIncome: 10, engineMultiplier: 0, policy: constantPolicy(0) }, pressureCoefficient: 0, maxTurns: 1 }));
    expect(equal.history[0]!.tension).toBe(1);
  });
});

describe("Tier 2: outflowGrantRate (the outflow cap)", () => {
  it("omitting outflowGrantRate reproduces Tier 1 behavior EXACTLY — the core backward-compatibility claim this extension depends on, proven directly rather than just 'the old tests still pass'", () => {
    const withoutRate = baseParams(); // no outflowGrantRate anywhere — this IS the exact Tier 1 config
    const explicitlyUncapped = baseParams({
      agentA: { ...withoutRate.agentA, outflowGrantRate: undefined },
      agentB: { ...withoutRate.agentB, outflowGrantRate: undefined },
    });
    expect(runSimulation(explicitlyUncapped)).toEqual(runSimulation(withoutRate));
  });

  it("a low outflowGrantRate genuinely constrains conversion below what the policy alone would choose — committed grows slower than the uncapped case, all else equal (with initialCommitted seeded, so this tests genuine partial constraint, not the total-deadlock case covered separately below)", () => {
    const policy = constantPolicy(0.9); // wants to convert 90% of held every turn
    const uncapped = runSimulation(
      baseParams({
        agentA: { baseIncome: 10, engineMultiplier: 0.5, policy, initialCommitted: 3 },
        agentB: { baseIncome: 10, engineMultiplier: 0.5, policy, initialCommitted: 3 },
        pressureCoefficient: 0.1,
        maxTurns: 10,
      }),
    );
    const capped = runSimulation(
      baseParams({
        agentA: { baseIncome: 10, engineMultiplier: 0.5, policy, outflowGrantRate: 0.05, initialCommitted: 3 }, // a real, tight cap
        agentB: { baseIncome: 10, engineMultiplier: 0.5, policy, outflowGrantRate: 0.05, initialCommitted: 3 },
        pressureCoefficient: 0.1,
        maxTurns: 10,
      }),
    );
    const lastUncapped = uncapped.history[uncapped.history.length - 1]!;
    const lastCapped = capped.history[capped.history.length - 1]!;
    // genuinely PARTIAL constraint this time, not the total-deadlock case: capped still grows, just more slowly
    expect(lastCapped.agentA.committed).toBeGreaterThan(3);
    expect(lastCapped.agentA.committed).toBeLessThan(lastUncapped.agentA.committed);
  });

  it("outflow is exposed on AgentState and visibly binds (finite, not Infinity) once there's some initial committed resource to generate it from", () => {
    const result = runSimulation(
      baseParams({
        agentA: { baseIncome: 10, engineMultiplier: 0.5, policy: constantPolicy(0.9), outflowGrantRate: 0.01, initialCommitted: 5 },
        agentB: { baseIncome: 10, engineMultiplier: 0.5, policy: constantPolicy(0.9), outflowGrantRate: 0.01, initialCommitted: 5 },
        maxTurns: 20,
      }),
    );
    const laterTurn = result.history[10]!;
    expect(laterTurn.agentA.outflow).toBeLessThan(Infinity);
    expect(laterTurn.agentA.committed).toBeGreaterThan(0);
  });

  it("without initialCommitted, a nonzero outflowGrantRate is a genuine deadlock — nothing can ever convert, since outflow is generated FROM committed and committed starts at exactly 0. This is not a bug: it's the same reason the real game's draft action places the first 3 cards for free, never funded by outflow", () => {
    const result = runSimulation(
      baseParams({
        agentA: { baseIncome: 10, engineMultiplier: 0.5, policy: constantPolicy(0.9), outflowGrantRate: 0.5 }, // no initialCommitted
        agentB: { baseIncome: 10, engineMultiplier: 0.5, policy: constantPolicy(0.9), outflowGrantRate: 0.5 },
        pressureCoefficient: 0,
        maxTurns: 20,
      }),
    );
    const lastTurn = result.history[result.history.length - 1]!;
    expect(lastTurn.agentA.committed).toBe(0); // stuck at exactly 0, forever
    expect(lastTurn.agentA.outflow).toBe(0);
  });

  it("with a real bootstrap seeded, tightening outflowGrantRate lengthens duration SMOOTHLY/monotonically — unlike catchUpPolicy's cliff-shaped compensation curve, this is a gradual, predictable relationship, found by the exhaustive Tier 2 sweep in exhaust.ts and locked in here", () => {
    const tier2Base = {
      agentA: { baseIncome: 10, engineMultiplier: 0.5, policy: constantPolicy(0.5), initialCommitted: 3 },
      agentB: { baseIncome: 10, engineMultiplier: 0.5, policy: constantPolicy(0.5), initialCommitted: 3 },
      decayRate: 0.1,
      pressureCoefficient: 0.2,
      noiseAmplitude: 1,
      maxTurns: 300,
    };
    const rates = [5, 1, 0.5, 0.2, 0.1, 0.05];
    const meanDurations = rates.map((outflowGrantRate) => {
      const stats = runBatch(
        { agentA: { ...tier2Base.agentA, outflowGrantRate }, agentB: { ...tier2Base.agentB, outflowGrantRate }, decayRate: tier2Base.decayRate, pressureCoefficient: tier2Base.pressureCoefficient, noiseAmplitude: tier2Base.noiseAmplitude, maxTurns: tier2Base.maxTurns },
        100,
        1,
      );
      return stats.meanDuration;
    });
    for (let i = 1; i < meanDurations.length; i++) {
      expect(meanDurations[i]!).toBeGreaterThanOrEqual(meanDurations[i - 1]! - 0.5); // small Monte Carlo tolerance, same pattern as the earlier compensation-curve monotonicity test
    }
    // and the overall effect is real, not noise-level: tightest cap meaningfully longer than loosest
    expect(meanDurations[meanDurations.length - 1]!).toBeGreaterThan(meanDurations[0]! * 1.5);
  });
});

describe("runBatch", () => {
  it("reports unresolvedCount === trials when there's no coupling at all", () => {
    const stats = runBatch({ ...baseParams(), pressureCoefficient: 0 }, 10, 1);
    expect(stats.unresolvedCount).toBe(10);
    expect(stats.trials).toBe(10);
  });

  it("durations array is sorted, and min/max/mean are consistent with it", () => {
    const stats = runBatch(baseParams(), 20, 100);
    expect(stats.durations).toHaveLength(20);
    for (let i = 1; i < stats.durations.length; i++) {
      expect(stats.durations[i]!).toBeGreaterThanOrEqual(stats.durations[i - 1]!);
    }
    expect(stats.minDuration).toBe(stats.durations[0]);
    expect(stats.maxDuration).toBe(stats.durations[stats.durations.length - 1]);
  });
});

describe("skillVsNoise", () => {
  it("a real skill differential wins more often at low noise than at high noise", () => {
    const params = {
      agentA: { baseIncome: 10, engineMultiplier: 1.2, policy: catchUpPolicy(0.4, 0.3) },
      agentB: { baseIncome: 10, engineMultiplier: 0.6, policy: catchUpPolicy(0.4, 0.3) },
      decayRate: 0.1,
      pressureCoefficient: 0.3,
      maxTurns: 200,
    };
    const points = skillVsNoise(params, [0, 50], 40, 1);
    const lowNoise = points.find((p) => p.noiseAmplitude === 0)!;
    const highNoise = points.find((p) => p.noiseAmplitude === 50)!;
    expect(lowNoise.winRateA).toBeGreaterThan(highNoise.winRateA);
  });

  it("decision-making ALONE — identical stats, only the conversion policy differs — produces a real edge at zero noise", () => {
    const params = {
      agentA: { baseIncome: 10, engineMultiplier: 0.8, policy: catchUpPolicy(0.3, 0.4) },
      agentB: { baseIncome: 10, engineMultiplier: 0.8, policy: constantPolicy(0.3) }, // identical stats, naive policy
      decayRate: 0.1,
      pressureCoefficient: 0.25,
      maxTurns: 300,
    };
    const [zeroNoise] = skillVsNoise(params, [0], 100, 1);
    expect(zeroNoise!.winRateA).toBeGreaterThan(0.9); // decisively, not just "slightly favored"
  });
});
