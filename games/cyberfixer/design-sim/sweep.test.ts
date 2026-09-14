import { describe, expect, it } from "vitest";
import { meanTensionAtFraction, sweep2D, findCompensationCurve } from "./sweep.ts";
import { constantPolicy } from "./policies.ts";

function baseParams() {
  return {
    agentA: { baseIncome: 10, engineMultiplier: 0.6, policy: constantPolicy(0.4) },
    agentB: { baseIncome: 10, engineMultiplier: 0.6, policy: constantPolicy(0.4) },
    decayRate: 0.1,
    pressureCoefficient: 0.2,
    noiseAmplitude: 1,
    maxTurns: 200,
  };
}

describe("meanTensionAtFraction", () => {
  it("is deterministic for the same params/seed", () => {
    const params = baseParams();
    expect(meanTensionAtFraction(params, 0.5, 20, 1)).toBe(meanTensionAtFraction(params, 0.5, 20, 1));
  });

  it("returns a value in [0,1] — tension is a normalized measure by construction", () => {
    const value = meanTensionAtFraction(baseParams(), 0.5, 30, 1);
    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThanOrEqual(1);
  });

  it("throws rather than silently returning NaN/0 when there's nothing to sample from", () => {
    expect(() => meanTensionAtFraction(baseParams(), 0.5, 0, 1)).toThrow(/every trial had empty history/);
  });

  it("symmetric agents show high (near-1) tension at the midpoint — an even match should still look even partway through", () => {
    const value = meanTensionAtFraction(baseParams(), 0.5, 50, 1);
    expect(value).toBeGreaterThan(0.8);
  });
});

describe("sweep2D", () => {
  it("produces exactly one cell per (decayRate, pressureCoefficient) combination", () => {
    const cells = sweep2D(baseParams(), [0, 0.2], [0.1, 0.3, 0.5], 10, 1);
    expect(cells).toHaveLength(2 * 3);
  });

  it("every cell's fields are internally consistent (unresolvedRate in [0,1], duration positive)", () => {
    const cells = sweep2D(baseParams(), [0, 0.3], [0, 0.3], 20, 1);
    for (const cell of cells) {
      expect(cell.unresolvedRate).toBeGreaterThanOrEqual(0);
      expect(cell.unresolvedRate).toBeLessThanOrEqual(1);
      expect(cell.meanDuration).toBeGreaterThan(0);
      expect(cell.tensionAtMidpoint).toBeGreaterThanOrEqual(0);
      expect(cell.tensionAtMidpoint).toBeLessThanOrEqual(1);
    }
  });

  it("zero pressure always means unresolvedRate of 1, regardless of decay — confirms the sweep doesn't lose the earlier single-point finding when generalized to a grid", () => {
    const cells = sweep2D(baseParams(), [0, 0.1, 0.3], [0], 15, 1);
    for (const cell of cells) {
      expect(cell.unresolvedRate).toBe(1);
    }
  });
});

describe("findCompensationCurve", () => {
  it("higher urgencyGain never makes the weaker agent's win rate worse, for a real stat disadvantage", () => {
    // NOTE: this asserts monotonic non-decrease, which is a weaker (safer) claim than
    // "strictly increases" — the actual shape (linear vs. threshold) is left to be
    // read from the printed table, not asserted here.
    const points = findCompensationCurve(
      0.4,
      0.9,
      { baseIncome: 10, decayRate: 0.1, pressureCoefficient: 0.25, noiseAmplitude: 0, maxTurns: 300 },
      [0.1, 0.3, 0.6, 1.0],
      150,
      1,
    );
    for (let i = 1; i < points.length; i++) {
      expect(points[i]!.winRateWeaker).toBeGreaterThanOrEqual(points[i - 1]!.winRateWeaker - 0.05); // small tolerance for Monte Carlo noise at finite trial counts
    }
  });

  it("a smarter policy has LIMITS as compensation — a large enough stat gap still wins for the stronger agent even at maximum urgencyGain", () => {
    // This is the corrected version of an earlier draft of this test, which
    // wrongly assumed "equal engineMultiplier" meant "no advantage of any
    // kind" — it doesn't, since agentA always gets catchUpPolicy and agentB
    // always gets constantPolicy regardless of the multiplier arguments, so
    // equal multipliers just isolates the pure policy edge (already covered,
    // and correctly found to be large, in model.test.ts). What's actually
    // worth checking here is the boundary case that test COULDN'T show:
    // does the adaptive policy compensate for absolutely any stat gap, or
    // does compensation top out? A large enough gap should still favor the
    // stronger agent even at the highest urgencyGain tried.
    const points = findCompensationCurve(
      0.15,
      1.5,
      { baseIncome: 10, decayRate: 0.1, pressureCoefficient: 0.25, noiseAmplitude: 0, maxTurns: 300 },
      [1.0],
      150,
      1,
    );
    expect(points[0]!.winRateWeaker).toBeLessThan(0.5);
  });

  it("catchUpPolicy's compensation is threshold-shaped, not gradual — near-zero until urgencyGain crosses a real cliff, then jumps sharply. Caught by widening a sampling range that originally missed this entirely; kept as a regression so it can't silently disappear if the policy formula changes", () => {
    const shared = { baseIncome: 10, decayRate: 0.1, pressureCoefficient: 0.25, noiseAmplitude: 1, maxTurns: 300 };
    const points = findCompensationCurve(0.4, 0.9, shared, [0, 1.5, 2.5, 3, 4], 200, 1);
    const [zero, low, justBelow, atCliff, aboveCliff] = points;
    expect(zero!.winRateWeaker).toBeLessThan(0.05);
    expect(low!.winRateWeaker).toBeLessThan(0.05); // still flat, well past where a gradual curve would show real movement
    expect(justBelow!.winRateWeaker).toBeLessThan(0.1); // still near-zero right up to the cliff
    expect(atCliff!.winRateWeaker).toBeGreaterThan(0.15); // the jump has visibly started
    expect(aboveCliff!.winRateWeaker).toBeGreaterThan(0.7); // and has mostly resolved by one step further
  });
});
