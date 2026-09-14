import { describe, expect, it } from "vitest";
import { computeShapeMetrics, declineOnsetIndex, searchShapeSpace, type ShapeTarget } from "./shape-search.ts";
import { constantPolicy } from "./policies.ts";
import type { SimulationParams } from "./model.ts";

function tensions(...values: number[]) {
  return values.map((tension) => ({ tension }));
}

describe("declineOnsetIndex", () => {
  it("returns 0 when tension is already below threshold from the very first entry — an immediate decline, no fade at all", () => {
    expect(declineOnsetIndex(tensions(0.5, 0.4, 0.3, 0.1), 0.85)).toBe(0);
  });

  it("returns the LAST index where tension was still >= threshold, plus one — a real late collapse", () => {
    // stays high through index 3, drops at index 4 and never recovers
    expect(declineOnsetIndex(tensions(0.95, 0.96, 0.94, 0.93, 0.5, 0.2, 0.1), 0.85)).toBe(4);
  });

  it("a single dip that RECOVERS doesn't count as the decline onset — only the LATER, permanent drop does", () => {
    // dips at index 2 but recovers at index 3 — the real, permanent decline starts at index 5
    expect(declineOnsetIndex(tensions(0.95, 0.96, 0.5, 0.93, 0.94, 0.4, 0.2), 0.85)).toBe(5);
  });

  it("returns the last index (fraction 1.0) if tension never drops below threshold at all", () => {
    const h = tensions(0.9, 0.92, 0.95, 0.91);
    expect(declineOnsetIndex(h, 0.85)).toBe(h.length - 1);
  });
});

function paramsFor(decayRate: number, pressureCoefficient: number): Omit<SimulationParams, "seed"> {
  return {
    agentA: { baseIncome: 10, engineMultiplier: 0.5, policy: constantPolicy(0.4) },
    agentB: { baseIncome: 10, engineMultiplier: 0.5, policy: constantPolicy(0.4) },
    decayRate,
    pressureCoefficient,
    noiseAmplitude: 1,
    maxTurns: 300,
  };
}

describe("computeShapeMetrics", () => {
  it("is deterministic for the same params/seed", () => {
    const params = paramsFor(0.1, 0.2);
    expect(computeShapeMetrics(params, 20, 1)).toEqual(computeShapeMetrics(params, 20, 1));
  });

  it("with zero pressure (never resolves), unresolvedRate is 1 and tension metrics are still well-formed (in [0,1])", () => {
    const metrics = computeShapeMetrics(paramsFor(0.1, 0), 15, 1);
    expect(metrics.unresolvedRate).toBe(1);
    for (const v of [metrics.meanTensionAt25, metrics.meanTensionAt50, metrics.meanTensionAt75, metrics.meanTensionAtEnd, metrics.meanDeclineOnsetFraction]) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it("tensionAtEnd is meaningfully lower than tensionAt25 for a resolving match — by construction, the match ends when one agent is near/at bankruptcy", () => {
    const metrics = computeShapeMetrics(paramsFor(0.1, 0.3), 50, 1);
    expect(metrics.unresolvedRate).toBeLessThan(0.1); // sanity: this regime should actually resolve almost always
    expect(metrics.meanTensionAtEnd).toBeLessThan(metrics.meanTensionAt25);
  });

  it("a regime manually inspected turn-by-turn and confirmed to hold near-even tension until the final couple turns reports a HIGH meanDeclineOnsetFraction, validating the full pipeline against a case verified by eye first", () => {
    const regime: Omit<SimulationParams, "seed"> = {
      agentA: { baseIncome: 10, engineMultiplier: 0.5, policy: constantPolicy(0.2), outflowGrantRate: 0.3, initialCommitted: 3 },
      agentB: { baseIncome: 10, engineMultiplier: 0.5, policy: constantPolicy(0.2), outflowGrantRate: 0.3, initialCommitted: 3 },
      decayRate: 0.1,
      pressureCoefficient: 0.05,
      noiseAmplitude: 1,
      maxTurns: 300,
    };
    const metrics = computeShapeMetrics(regime, 60, 1);
    expect(metrics.meanDeclineOnsetFraction).toBeGreaterThan(0.7); // decline should be starting well into the back stretch of the match, not partway through
  });
});

describe("searchShapeSpace", () => {
  const target: ShapeTarget = {
    minDuration: 5,
    maxDuration: 50,
    maxUnresolvedRate: 0.05,
    minSustainedTension: 0.5,
    minDeclineOnsetFraction: 0.3,
  };

  it("the concrete regime found by search-run.ts's grid — outflowGrantRate 0.3, pressureCoefficient 0.1 — actually passes a real target for 'sustained tension, late collapse', locked in so this recommendation can't silently stop holding if the model changes", () => {
    const target2: ShapeTarget = { minDuration: 12, maxDuration: 35, maxUnresolvedRate: 0.03, minSustainedTension: 0.75, minDeclineOnsetFraction: 0.7 };
    const regime = { decayRate: 0.1, pressureCoefficient: 0.1, outflowGrantRate: 0.3, convertFraction: 0.2 };
    const buildParams = (r: typeof regime): Omit<SimulationParams, "seed"> => ({
      agentA: { baseIncome: 10, engineMultiplier: 0.5, policy: constantPolicy(r.convertFraction), outflowGrantRate: r.outflowGrantRate, initialCommitted: 3 },
      agentB: { baseIncome: 10, engineMultiplier: 0.5, policy: constantPolicy(r.convertFraction), outflowGrantRate: r.outflowGrantRate, initialCommitted: 3 },
      decayRate: r.decayRate,
      pressureCoefficient: r.pressureCoefficient,
      noiseAmplitude: 1,
      maxTurns: 300,
    });
    const [result] = searchShapeSpace([regime], target2, buildParams, 100, 1);
    expect(result!.passesTarget).toBe(true);
  });

  it("a candidate with zero coupling never passes the target — unresolvedRate alone disqualifies it, regardless of how good other metrics look", () => {
    const candidates = [{ decayRate: 0.1, pressureCoefficient: 0 }];
    const [result] = searchShapeSpace(candidates, target, (c) => paramsFor(c.decayRate, c.pressureCoefficient), 20, 1);
    expect(result!.metrics.unresolvedRate).toBe(1);
    expect(result!.passesTarget).toBe(false);
  });

  it("results are sorted best-score-first", () => {
    const candidates = [
      { decayRate: 0.1, pressureCoefficient: 0.05 },
      { decayRate: 0.1, pressureCoefficient: 0.3 },
      { decayRate: 0.1, pressureCoefficient: 0.8 },
    ];
    const results = searchShapeSpace(candidates, target, (c) => paramsFor(c.decayRate, c.pressureCoefficient), 30, 1);
    for (let i = 1; i < results.length; i++) {
      expect(results[i]!.score).toBeLessThanOrEqual(results[i - 1]!.score);
    }
  });

  it("passesTarget is independent of sort position — a top-ranked candidate among an all-bad batch still correctly reports passesTarget: false", () => {
    const candidates = [
      { decayRate: 0.1, pressureCoefficient: 0 }, // never resolves
      { decayRate: 0.1, pressureCoefficient: 0.001 }, // resolves, but astronomically slowly — should still fail the duration/unresolved bounds
    ];
    const results = searchShapeSpace(candidates, target, (c) => paramsFor(c.decayRate, c.pressureCoefficient), 20, 1);
    // even the BEST of these two bad candidates should not pass
    expect(results[0]!.passesTarget).toBe(false);
  });
});
