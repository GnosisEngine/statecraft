/**
 * games/cyberfixer/design-sim/model.ts
 *
 * A deliberately abstract simulation of ONE thing: the hold-vs-commit
 * tension under decay and mutual pressure, from DESIGN_FRAMEWORK.md §1.
 * This does NOT simulate cyberfixer's actual rules (no cards, no zones,
 * no BoolExpr/NumExpr) — it's a small numeric model of the underlying
 * dynamic those rules are meant to produce, for getting a loose,
 * Monte-Carlo-style read on how forcing-function/coupling/conversion
 * PARAMETERS affect game duration and outcome predictability, before
 * committing to specific numbers in real content.
 *
 * The mapping to real cyberfixer concepts, loosely:
 *   income    ~ inflow (bankruptcy condition: income <= 0)
 *   held      ~ hand + spendable potential (decays if not converted)
 *   committed ~ board investment (generates income, generates pressure)
 *   pressure  ~ shakedown (a persistent hit to the opponent's income)
 *   outflow   ~ outflow (a per-turn spend cap on conversion, itself
 *               capped by income — see AgentParams.outflowGrantRate)
 *
 * TIER 2: `outflowGrantRate` is OPTIONAL, and its absence must reproduce
 * Tier 1's exact behavior — this was the actual real-game finding that
 * motivated adding it (a fixer's outflow cap almost never binds under
 * the currently-shipped card stats, because outflowGrant is tuned well
 * under inflow on every card), and the whole point of this extension is
 * to test what changes if it DID bind. An agent that omits
 * outflowGrantRate gets an uncapped conversion, identical to every
 * existing Tier 1 result — this is proven directly in model.test.ts,
 * not just asserted here.
 *
 * See this directory's README.md for what this model does and does not
 * claim to show.
 */

import { SeededRandom } from "../../../src/persistence/seeded-random.ts";

/** A conversion policy decides what fraction of `held` an agent WANTS to commit this turn, given its own state and the opponent's. The actual amount converted may be less, if outflowGrantRate caps it (see AgentParams). Pure function — no randomness here; noise is injected separately (see SimulationParams.noiseAmplitude) so policy behavior and injected variance stay independently analyzable. */
export type ConversionPolicy = (self: Readonly<AgentState>, opponent: Readonly<AgentState>, turn: number) => number;

export interface AgentState {
  income: number;
  held: number;
  committed: number;
  /** This turn's actual conversion budget — Infinity (no cap at all) unless outflowGrantRate is set. Tracked on state (not just computed internally) so callers can see when/how often the cap actually binds. */
  outflow: number;
}

export interface AgentParams {
  baseIncome: number;
  /** How much each unit of `committed` adds to income per turn — the "engines compound" effect. */
  engineMultiplier: number;
  /**
   * How much each unit of `committed` contributes to this turn's outflow
   * budget, itself capped at current income (mirroring the real
   * property-bounds mechanism: outflow bounded by inflow). OMITTED
   * (undefined) means no cap at all — conversion is limited only by the
   * policy's own desired fraction, exactly Tier 1's behavior. This is
   * the one parameter this whole extension exists to let you set low
   * enough that the cap actually binds, unlike the shipped cyberfixer
   * numbers today.
   */
  outflowGrantRate?: number;
  /**
   * Committed resource an agent starts with, before any conversion —
   * mirroring the real game's `draft` action, which places the first 3
   * cards onto the board for FREE, never funded by outflow at all.
   * This isn't a convenience default; it's structurally required once
   * outflowGrantRate is set: outflow is generated FROM committed, so if
   * committed starts at exactly 0 and outflow is the only thing that
   * can grow it, nothing can ever convert at all — a genuine
   * bootstrapping deadlock this model hit directly while being built
   * (see model.test.ts). Defaults to 0, matching Tier 1 exactly when
   * outflowGrantRate is also omitted (an uncapped agent has no need for
   * a free starting seed).
   */
  initialCommitted?: number;
  policy: ConversionPolicy;
}

export interface SimulationParams {
  agentA: AgentParams;
  agentB: AgentParams;
  /** Fraction of `held` lost each turn if not converted — the forcing function. 0 = no forcing function at all (holding is free forever). */
  decayRate: number;
  /** How much pressure one unit of `committed` applies to the opponent's income each turn — the coupling point. 0 = no coupling; the two agents never interact (parallel solitaire, matching §1's failure mode). */
  pressureCoefficient: number;
  /** Uniform noise amplitude applied to each turn's income, in [-amplitude, +amplitude]. 0 = fully deterministic — used for the skill-vs-variance experiment (see monte-carlo.ts). */
  noiseAmplitude: number;
  /** Hard stop if neither agent has gone bankrupt by this turn — this itself is diagnostic: a parameter combination that frequently hits the cap without resolving is evidence of a forcing function that doesn't actually bind (see README.md). */
  maxTurns: number;
  seed: number;
}

export interface TurnRecord {
  turn: number;
  agentA: AgentState;
  agentB: AgentState;
  /** 1 - normalized income gap, in [0,1]. 1 = perfectly even (max tension); 0 = fully decided. Not a claim about STRATEGIC tension, just a numeric proxy — see README.md. */
  tension: number;
}

export interface SimulationResult {
  history: TurnRecord[];
  /** "A" | "B" | null — null means maxTurns was hit with neither bankrupt (see maxTurns's own doc comment). */
  winner: "A" | "B" | null;
  durationTurns: number;
}

function tension(a: AgentState, b: AgentState): number {
  const totalA = a.income;
  const totalB = b.income;
  const sum = Math.abs(totalA) + Math.abs(totalB);
  if (sum === 0) return 1; // both exactly at zero simultaneously — maximally ambiguous, not a divide-by-zero error
  return 1 - Math.abs(totalA - totalB) / sum;
}

function initialState(params: AgentParams): AgentState {
  return { income: params.baseIncome, held: 0, committed: params.initialCommitted ?? 0, outflow: params.outflowGrantRate === undefined ? Infinity : 0 };
}

/**
 * Runs one full simulation, turn by turn, alternating which agent acts
 * first each turn (matching cyberfixer's own alternating structure) —
 * though since both agents' state updates are applied every turn
 * regardless of "who's active" in this abstract model, the alternation
 * only affects which agent's bankruptcy is checked first on a turn
 * where both would qualify simultaneously.
 */
export function runSimulation(params: SimulationParams): SimulationResult {
  const random = new SeededRandom(params.seed);
  let a = initialState(params.agentA);
  let b = initialState(params.agentB);
  // Local, per-run mutable copies — pressure persistently erodes these
  // over the course of a run, but the CALLER's params.agentA/agentB
  // objects are never touched, specifically so the same params object
  // can be reused across many Monte Carlo trials without one run's
  // accumulated pressure leaking into the next.
  let baseIncomeA = params.agentA.baseIncome;
  let baseIncomeB = params.agentB.baseIncome;
  const history: TurnRecord[] = [];

  for (let turn = 1; turn <= params.maxTurns; turn++) {
    // 1. income, fresh each turn from base + engine contribution
    a = { ...a, income: baseIncomeA + a.committed * params.agentA.engineMultiplier };
    b = { ...b, income: baseIncomeB + b.committed * params.agentB.engineMultiplier };

    // noise, applied to income directly — the one place variance enters this model
    if (params.noiseAmplitude > 0) {
      a.income += (random.next() - 0.5) * 2 * params.noiseAmplitude;
      b.income += (random.next() - 0.5) * 2 * params.noiseAmplitude;
    }

    history.push({ turn, agentA: a, agentB: b, tension: tension(a, b) });

    const firstIsA = turn % 2 === 1;
    const first = firstIsA ? a : b;
    const firstLabel = firstIsA ? "A" : "B";
    const second = firstIsA ? b : a;
    const secondLabel = firstIsA ? "B" : "A";

    if (first.income <= 0) return { history, winner: secondLabel, durationTurns: turn };
    if (second.income <= 0) return { history, winner: firstLabel, durationTurns: turn };

    // 2. income flows into held
    a.held += a.income;
    b.held += b.income;

    // 3. decay — the forcing function
    a.held *= 1 - params.decayRate;
    b.held *= 1 - params.decayRate;

    // 4. outflow — this turn's actual spend cap, itself capped at
    // income (mirroring the real property-bounds mechanism). Absent
    // outflowGrantRate, this is Infinity — no cap at all, exactly
    // Tier 1's behavior.
    a.outflow = params.agentA.outflowGrantRate === undefined ? Infinity : Math.max(0, Math.min(a.income, a.committed * params.agentA.outflowGrantRate));
    b.outflow = params.agentB.outflowGrantRate === undefined ? Infinity : Math.max(0, Math.min(b.income, b.committed * params.agentB.outflowGrantRate));

    // 5. conversion, per each agent's own policy — but never more than
    // this turn's outflow allows, even if the policy wants more.
    const desiredA = Math.max(0, Math.min(1, params.agentA.policy(a, b, turn))) * a.held;
    const desiredB = Math.max(0, Math.min(1, params.agentB.policy(b, a, turn))) * b.held;
    const convertA = Math.min(desiredA, a.outflow);
    const convertB = Math.min(desiredB, b.outflow);
    a.held -= convertA;
    a.committed += convertA;
    b.held -= convertB;
    b.committed += convertB;

    // 6. pressure — the coupling point. Applied to committed AFTER this
    // turn's conversion, so pressure reflects board presence as it
    // stands at the end of the turn, and hits the OPPONENT's base
    // income persistently (mirroring a stacking shakedown modifier, not
    // a one-turn poke) via the LOCAL copies from above, never the
    // caller's params.
    baseIncomeB -= params.pressureCoefficient * a.committed;
    baseIncomeA -= params.pressureCoefficient * b.committed;
  }

  return { history, winner: null, durationTurns: params.maxTurns };
}
