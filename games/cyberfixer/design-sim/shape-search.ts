/**
 * games/cyberfixer/design-sim/shape-search.ts
 *
 * Flips the direction of everything else in this directory: instead of
 * "given these parameters, what happens" (model.ts/monte-carlo.ts/
 * sweep.ts), this asks "which parameter combinations produce the SHAPE
 * of match DESIGN_FRAMEWORK.md describes as desirable" — sustained
 * near-even tension through most of the match, a late collapse rather
 * than a long fade, a reasonable duration, and no meaningful chance of
 * never resolving.
 *
 * "Desired shape" has to become a measurable target before it's
 * searchable — ShapeTarget is that operationalization. It is a
 * DELIBERATE, debatable translation of prose into thresholds; treat the
 * specific numbers as a first cut worth adjusting, not a settled
 * definition of "good."
 */

import { runSimulation, type SimulationParams } from "./model.ts";

export interface ShapeMetrics {
  meanDuration: number;
  unresolvedRate: number;
  /** Mean tension at 25%/50%/75% of each trial's own duration — sampled from the SAME trials as duration/unresolvedRate (one pass per trial), not a separate re-run per fraction like sweep.ts's meanTensionAtFraction, specifically to keep a wide search affordable. */
  meanTensionAt25: number;
  meanTensionAt50: number;
  meanTensionAt75: number;
  /** Tension at the final recorded turn — i.e., right at (or near) resolution. */
  meanTensionAtEnd: number;
  /**
   * Mean, across trials, of WHEN (as a fraction of that trial's own
   * duration) tension first drops below `declineThreshold` and never
   * recovers above it again. This is what actually distinguishes "held
   * near-even, then collapsed late" from "declined gradually the whole
   * way" — (sustainedTension - tensionAtEnd) alone can't, because the
   * win condition guarantees tensionAtEnd is near zero for almost any
   * resolving match regardless of how early the decline started. A
   * value near 1.0 means the decline started late; near 0 means it
   * started early (a long fade, not a collapse) even if
   * sustainedTension still looked high on average.
   */
  meanDeclineOnsetFraction: number;
}

/**
 * First index where tension drops below `threshold` and stays there (no
 * later recovery above it) — a single dip that recovers doesn't count
 * as "the decline," since that's noise, not the actual collapse. This
 * is exactly "one past the LAST index where tension was still >=
 * threshold," computed in one backward-tracking pass rather than a
 * naive scan-and-recheck-the-rest (which would be O(n²) per trial —
 * fine at small history lengths, but this runs once per Monte Carlo
 * trial across potentially thousands of candidates in a search, so it's
 * worth doing efficiently from the start). Returns history.length-1
 * (fraction 1.0) if tension never drops below threshold at all —
 * treated as "no decline observed within this trial," which includes
 * the unresolved-match case (already disqualified separately via
 * unresolvedRate).
 */
export function declineOnsetIndex(history: readonly { tension: number }[], threshold: number): number {
  let lastAboveIndex = -1;
  for (let i = 0; i < history.length; i++) {
    if (history[i]!.tension >= threshold) lastAboveIndex = i;
  }
  const onset = lastAboveIndex + 1;
  return onset >= history.length ? history.length - 1 : onset;
}

function tensionAtIndex(history: readonly { tension: number }[], fraction: number): number {
  return history[Math.min(history.length - 1, Math.floor(fraction * (history.length - 1)))]!.tension;
}

/** One pass over `trials` runs, extracting every metric needed for shape-scoring from each run's own history — avoids re-running the batch once per fraction sampled. */
export function computeShapeMetrics(paramsWithoutSeed: Omit<SimulationParams, "seed">, trials: number, baseSeed: number, declineThreshold = 0.85): ShapeMetrics {
  let totalDuration = 0;
  let unresolved = 0;
  let sum25 = 0;
  let sum50 = 0;
  let sum75 = 0;
  let sumEnd = 0;
  let sumDeclineOnsetFraction = 0;

  for (let i = 0; i < trials; i++) {
    const result = runSimulation({ ...paramsWithoutSeed, seed: baseSeed + i });
    totalDuration += result.durationTurns;
    if (result.winner === null) unresolved++;
    if (result.history.length === 0) continue; // maxTurns === 0, degenerate — nothing to sample
    sum25 += tensionAtIndex(result.history, 0.25);
    sum50 += tensionAtIndex(result.history, 0.5);
    sum75 += tensionAtIndex(result.history, 0.75);
    sumEnd += result.history[result.history.length - 1]!.tension;
    const onsetIndex = declineOnsetIndex(result.history, declineThreshold);
    sumDeclineOnsetFraction += result.history.length > 1 ? onsetIndex / (result.history.length - 1) : 1;
  }

  return {
    meanDuration: totalDuration / trials,
    unresolvedRate: unresolved / trials,
    meanTensionAt25: sum25 / trials,
    meanTensionAt50: sum50 / trials,
    meanTensionAt75: sum75 / trials,
    meanTensionAtEnd: sumEnd / trials,
    meanDeclineOnsetFraction: sumDeclineOnsetFraction / trials,
  };
}

export interface ShapeTarget {
  minDuration: number;
  maxDuration: number;
  /** A regime with an unresolvedRate above this is disqualified outright, regardless of how good everything else looks — an unresolved match isn't a "long, tense" one, it's a failure to produce an ending at all. */
  maxUnresolvedRate: number;
  /** Threshold for the mean of tensionAt25/50/75 — "how undecided did this look through the middle of the match." */
  minSustainedTension: number;
  /** Threshold for meanDeclineOnsetFraction — "how late, as a fraction of the match's own length, did the decline actually start." This is the real gate against a long fade; (sustainedTension - tensionAtEnd) alone can't provide it, since tensionAtEnd is near zero for almost any resolving match regardless of when the decline began. */
  minDeclineOnsetFraction: number;
}

export interface ScoredRegime<R> {
  regime: R;
  metrics: ShapeMetrics;
  sustainedTension: number;
  /** Kept for reference/reporting, but NOT used as a target gate — see ShapeMetrics.meanDeclineOnsetFraction's own doc comment for why this alone can't distinguish a late collapse from a long fade. */
  lateCollapse: number;
  /** True only if EVERY threshold in the target is met — the disqualifying gate. Regimes that fail this can still be ranked by score (useful for seeing "how close"), but should not be read as actually hitting the target. */
  passesTarget: boolean;
  /** A single combined number for RANKING candidates against each other — not a claim that this number means anything on its own, or that its specific weights are correct. See this file's own honest caveats in README.md before trusting a close call between two nearby scores. */
  score: number;
}

function scoreAgainstTarget(metrics: ShapeMetrics, target: ShapeTarget): { sustainedTension: number; lateCollapse: number; passesTarget: boolean; score: number } {
  const sustainedTension = (metrics.meanTensionAt25 + metrics.meanTensionAt50 + metrics.meanTensionAt75) / 3;
  const lateCollapse = sustainedTension - metrics.meanTensionAtEnd;

  const durationOk = metrics.meanDuration >= target.minDuration && metrics.meanDuration <= target.maxDuration;
  const unresolvedOk = metrics.unresolvedRate <= target.maxUnresolvedRate;
  const tensionOk = sustainedTension >= target.minSustainedTension;
  const onsetOk = metrics.meanDeclineOnsetFraction >= target.minDeclineOnsetFraction;
  const passesTarget = durationOk && unresolvedOk && tensionOk && onsetOk;

  const durationPenalty = metrics.meanDuration < target.minDuration ? target.minDuration - metrics.meanDuration : metrics.meanDuration > target.maxDuration ? metrics.meanDuration - target.maxDuration : 0;
  // Weights here are a first cut, not a derived or validated tradeoff —
  // unresolvedRate is weighted heavily on purpose (an unresolved match
  // is disqualifying, not just "somewhat bad"), duration penalty lightly
  // (missing the duration window by a couple turns shouldn't swamp a
  // regime that otherwise has the right shape). declineOnsetFraction is
  // weighted comparably to sustainedTension since BOTH are needed for
  // "sustained tension, late collapse" — either one alone describes a
  // different, less interesting shape (see ShapeMetrics's doc comments).
  const score = sustainedTension + metrics.meanDeclineOnsetFraction - durationPenalty * 0.1 - metrics.unresolvedRate * 10;

  return { sustainedTension, lateCollapse, passesTarget, score };
}

/**
 * Scores every candidate regime (whatever shape `R` is — the caller's
 * own parameterization) against `target`, via `buildParams` translating
 * each candidate into full simulation params. Returns candidates sorted
 * best-score-first; `passesTarget` is what actually answers "does this
 * hit the target," not position in the sorted list — a regime can rank
 * highly among a bad batch of candidates without passing at all.
 */
export function searchShapeSpace<R>(candidates: readonly R[], target: ShapeTarget, buildParams: (regime: R) => Omit<SimulationParams, "seed">, trials: number, baseSeed: number): ScoredRegime<R>[] {
  const results = candidates.map((regime) => {
    const metrics = computeShapeMetrics(buildParams(regime), trials, baseSeed);
    const { sustainedTension, lateCollapse, passesTarget, score } = scoreAgainstTarget(metrics, target);
    return { regime, metrics, sustainedTension, lateCollapse, passesTarget, score };
  });
  return results.sort((a, b) => b.score - a.score);
}
