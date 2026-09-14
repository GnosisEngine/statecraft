/**
 * games/cyberfixer/design-sim/policies.ts
 *
 * A ConversionPolicy is just a function of (self, opponent, turn) ->
 * fraction of `held` to convert this turn. These three are starting
 * points, not a claim that real fixer play reduces to one of them —
 * useful for bracketing behavior (how does duration change between a
 * pure hoarder and a pure spender) rather than for modeling a
 * specific strategy faithfully.
 */

import type { ConversionPolicy } from "./model.ts";

/** Converts the same fraction every turn, regardless of state. The simplest possible policy — good for isolating the effect of OTHER parameters (decay, pressure) without the policy itself adapting around them. */
export function constantPolicy(fraction: number): ConversionPolicy {
  return () => fraction;
}

/** Converts more aggressively the further behind on income this agent is — a simple "catch-up" heuristic, not genuine strategic reasoning. */
export function catchUpPolicy(baseFraction: number, urgencyGain: number): ConversionPolicy {
  return (self, opponent) => {
    const deficit = Math.max(0, opponent.income - self.income);
    const totalIncome = Math.abs(self.income) + Math.abs(opponent.income);
    const urgency = totalIncome > 0 ? deficit / totalIncome : 0;
    return baseFraction + urgency * urgencyGain;
  };
}

/** Converts more aggressively as `held` grows — a crude stand-in for "decay pressure is making holding costly, so commit more." Distinct from catchUpPolicy: this reacts to OWN state, not the opponent's. */
export function decayAwarePolicy(baseFraction: number, heldThreshold: number, panicGain: number): ConversionPolicy {
  return (self) => {
    const excess = Math.max(0, self.held - heldThreshold);
    return baseFraction + Math.min(1, excess / Math.max(1, heldThreshold)) * panicGain;
  };
}
