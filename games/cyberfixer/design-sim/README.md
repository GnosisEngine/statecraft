# design-sim

A small, deliberately abstract simulation of ONE thing:
[`DESIGN_FRAMEWORK.md`](../DESIGN_FRAMEWORK.md) §1's core dynamic —
hold vs. commit, under decay (the forcing function) and mutual pressure
(the coupling point) — for getting a loose, Monte-Carlo-style read on
how those parameters affect game duration and outcome predictability,
before committing to specific numbers in real cyberfixer content.

Run it: `npx tsx games/cyberfixer/design-sim/run.ts`

## What this is not

This does **not** simulate cyberfixer's actual rules. No cards, no
zones, no draft, no `BoolExpr`/`NumExpr`, no hierarchy, no deck. Two
numeric agents each track three numbers (`income`, `held`, `committed`)
and update them by a fixed arithmetic rule each turn. It cannot tell you
what a real match of cyberfixer will feel like, how long a real match
will take, or whether a specific card is balanced. It can only tell you
how the *abstract shape* of the framework's own dynamic responds to the
knobs that shape maps onto:

- `decayRate` — the forcing function
- `pressureCoefficient` — the coupling point
- a `ConversionPolicy` — how aggressively an agent commits held resource
- `noiseAmplitude` — injected variance, for the skill-vs-noise experiment

The loose mapping to real concepts (`income` ~ inflow, `held` ~ hand/
spendable potential, `committed` ~ board investment, pressure ~
shakedown) is there to make the numbers legible, not because this model
claims to derive real card costs or turn counts from it.

## What it's actually good for

- Sanity-checking framework claims before trusting them in prose. "Zero
  coupling means the game never resolves" is asserted in
  `DESIGN_FRAMEWORK.md` §1 — `model.test.ts` proves it directly, and
  `run.ts`'s own output shows it numerically (0 pressure →
  unresolved 200/200 trials).
- Seeing the *shape* of a relationship (does duration respond gradually
  or does it cliff-edge as a parameter crosses some value) before
  guessing at real numbers.
- Running the skill-vs-noise experiment: fix a real skill differential
  between two agents, then find the noise level where win rate decays
  toward 50/50 — the point past which a mechanism has crossed from
  depth-driven into variance-driven, per §1's own discipline.

## What it can't do, and shouldn't be asked to

- Predict a real cyberfixer match's duration in turns. The model has no
  cards, no draft variance in the real sense, no discrete action
  economy — "turns" here are just loop iterations of one arithmetic
  rule.
- Substitute for actually building and testing a card or rule. Passing
  DESIGN_FRAMEWORK.md §6's four-question checklist is still a judgment
  call about the real mechanic, not something this model can answer for
  you.
- Model more than one forcing function or one coupling point at a time.
  Real cyberfixer likely has several forces acting together (contract
  cancellation, shakedown, a future clock, on top of the outflow cap
  Tier 2 now covers) — this model still isolates ONE decay mechanism
  and ONE coupling mechanism at a time, even with the outflow cap
  added. A richer model that composes several forcing functions at once
  is a real, separate next step if the current one stops being useful.
- Say anything about the OTHER framework axes (intensive/latent/reactive
  optionality, deception, adversarial surface). Those aren't numeric in
  any honest sense yet — this tool only covers the part of the
  framework that reduces cleanly to a time-series of two numbers.

## A finding worth knowing before trusting a compensation-curve result

`catchUpPolicy`'s compensation effect is **threshold-shaped, not gradual**
— this was found empirically, not designed in, and it surprised the
first pass at testing it. Sweeping `urgencyGain` from 0 up to 1.2 for a
real stat gap (engine 0.4 vs. 0.9) showed a flat 0.000 win rate the
entire way — which reads exactly like "no amount of policy aggression
compensates for this gap." Widening the range revealed that was simply
too narrow a sample: the win rate stays near zero until `urgencyGain`
crosses roughly 3, then jumps sharply (0.31 → 0.94 within one more
step). `model.test.ts`/`sweep.test.ts` lock this shape in as a
regression specifically so it can't silently disappear if the policy
formula changes later.

Two honest takeaways, not one: first, **`findCompensationCurve` needs a
wide sampling range** — five nearby points can look perfectly flat and
still be sitting entirely on one side of a real cliff. Second, and more
important: **this threshold is very likely an artifact of this specific,
simple policy formula's clamping behavior** (`baseFraction + urgency *
urgencyGain`, clamped to [0,1] — past some point the urgency term
saturates the clamp and the agent starts converting nearly everything it
holds), not a deep truth about skill-vs-power tradeoffs in general. A
different, more sophisticated adaptive policy might compensate
gradually instead of cliff-like. Don't generalize "compensation is
threshold-shaped" beyond "this is what THIS policy formula happens to
do" without checking another policy shape first.

## Tier 2: the outflow cap

`outflowGrantRate` (optional on `AgentParams`) extends the model to test
the real, already-identified cyberfixer question from
[the earlier design conversation](../DESIGN_FRAMEWORK.md): today's
shipped cards are tuned so the outflow cap (spend capped at income)
essentially never binds. This parameter lets you set a cap that
genuinely does bind, without touching anything about Tier 1 — omitting
it reproduces Tier 1's exact behavior, proven directly in
`model.test.ts`, not just "the old tests still pass."

**A real deadlock, found while building this, not designed in on
purpose.** Outflow is generated FROM `committed`, which starts at
exactly 0. Set a nonzero `outflowGrantRate` without also seeding
`initialCommitted`, and nothing can ever convert, ever — a genuine
chicken-and-egg lock, not a numerical edge case. This isn't just a
quirk of the abstract model: it's the same reason the real game's
`draft` action places the first 3 cards onto the board for free, never
funded by outflow at all. `initialCommitted` exists specifically to
mirror that free initial placement; without it, any nonzero
`outflowGrantRate` deadlocks the model outright (locked in as a
regression in `model.test.ts`).

**The actual experiment (`exhaust.ts`), and what it found:** holding
everything else fixed and sweeping `outflowGrantRate` from `undefined`
(today's real tuning) down through 5, 1, 0.5, 0.2, 0.1, 0.05:

| outflowGrantRate | mean duration (turns) | mean final `committed` |
|---|---|---|
| undefined (uncapped) | 7.0 | 52.1 |
| 5 (very loose) | 7.0 | 51.3 |
| 1 | 7.8 | 53.4 |
| 0.5 | 9.0 | 43.9 |
| 0.2 | 11.5 | 18.5 |
| 0.1 | 13.6 | 9.8 |
| 0.05 (tight) | 15.8 | 6.1 |

Two things worth separating here. First: `undefined` and `5` (a very
loose cap) are essentially identical — direct confirmation that a cap
which never binds really is decorative, exactly the concern that
motivated this extension. Second, and more interesting: unlike
`catchUpPolicy`'s compensation curve (a sharp cliff), tightening the
outflow cap produces a **smooth, gradual, roughly monotonic** increase
in duration — more than doubling from loosest to tightest tried. The
match's *shape* (tension at the halfway point) barely moves across the
whole range — tightening this cap changes how LONG the game takes, not
how undecided it feels partway through. If duration is a dial you want
predictable control over, this looks like a much more trustworthy one
than policy-based compensation turned out to be.

## Tier 3: searching FOR a desired shape, not probing one

`shape-search.ts` / `search-run.ts` flip the direction of everything
above: instead of "given these parameters, what happens," they ask
"which parameter combinations produce the SHAPE
[`DESIGN_FRAMEWORK.md`](../DESIGN_FRAMEWORK.md) describes as
desirable" — sustained, near-even tension through most of the match, a
real late collapse rather than a long fade, reliable resolution, and a
reasonable duration. `ShapeTarget` is a deliberate, debatable
operationalization of that prose into numeric thresholds — treat the
specific numbers in `search-run.ts`'s `TARGET` as a first cut, not a
settled definition of "good," and adjust them directly if they don't
match what you actually want.

**A real metric flaw, caught before trusting the first result.** The
first version scored "late collapse" as `sustainedTension -
tensionAtEnd`. The very first search result looked great by that
metric — until inspecting its actual turn-by-turn trajectory (worth
doing before trusting a summary number) showed why: `tensionAtEnd` is
*structurally* near zero for almost any match that resolves at all,
since the win condition is exactly "one agent's income crossed zero
while the other's didn't." That means the metric was mostly just
re-measuring `sustainedTension` a second time, not independently
confirming the drop happened *late* rather than gradually the whole
way — a genuine long fade could have scored just as well. Replaced with
`meanDeclineOnsetFraction`: the fraction of a trial's own duration at
which tension first drops below a threshold and never recovers above
it again — this is what actually distinguishes "held even, then
collapsed in the last stretch" from "declined steadily from turn one,"
and it's tested directly (not just through full simulations) against
constructed cases including a dip-that-recovers, which should *not*
count as the decline starting.

**What the search found, concretely.** Sweeping `decayRate` ×
`pressureCoefficient` × `outflowGrantRate` × `convertFraction` (384
combinations, 60 trials each, well under a second): 104 candidates pass
every threshold in the target. The striking part is *which* parameter
actually controls the shape — the top-ranked candidates all converge on
`outflowGrantRate ≈ 0.3` and `pressureCoefficient ≈ 0.1`, essentially
independent of `decayRate` or `convertFraction`, which vary freely
across the top results with almost no effect on the outcome. In this
model, the Tier 2 outflow cap — not the Tier 1 decay/pressure knobs —
is the dominant lever for "sustained tension, late collapse." One
specific instance of this regime (`decayRate: 0.1, pressureCoefficient:
0.1, outflowGrantRate: 0.3, convertFraction: 0.2`) is locked in as a
regression in `shape-search.test.ts`, so this recommendation can't
silently stop holding if the underlying model changes later.

**What this does and doesn't establish.** It's a real, reproducible
finding about *this specific abstract model* — not a claim that setting
cyberfixer's actual `outflowGrant`/inflow ratio near this value will
produce this shape in the real game, which has cards, a draft, and
mechanics this model doesn't represent at all (see "What this is not"
above). Treat it as a strong hypothesis worth testing against real
content, not a settled tuning target.

## Files

- `model.ts` — the core simulation (`runSimulation`) and its types,
  including the optional Tier 2 outflow cap (`outflowGrantRate`,
  `initialCommitted`).
- `policies.ts` — a few named conversion policies (constant, catch-up,
  decay-aware) — starting points for bracketing behavior, not a claim
  that real play reduces to one of them.
- `monte-carlo.ts` — batch running (`runBatch`) and the skill-vs-noise
  experiment (`skillVsNoise`).
- `sweep.ts` — shape characterization (`meanTensionAtFraction`, since
  mean duration alone can't distinguish "held even, then collapsed
  fast" from "declined steadily") and real parameter grids
  (`sweep2D`, `findCompensationCurve`) — for finding monotonicity,
  non-monotonicity, and thresholds that five hand-picked points can't
  reveal.
- `run.ts` — a runnable script printing four spot-check explorations.
- `exhaust.ts` — the systematic follow-up: full 2D grids plus a real
  compensation curve, run wide enough to catch threshold effects (see
  the finding documented above, which the FIRST version of this script
  initially missed by sampling too narrow a range).
- `shape-search.ts` — inverse design: scores candidate parameter
  regimes against a target gameplay shape (`ShapeTarget`,
  `searchShapeSpace`), including `meanDeclineOnsetFraction` — the
  metric that actually distinguishes a late collapse from a long fade,
  replacing an earlier, flawed attempt at the same idea (see the Tier 3
  section above).
- `search-run.ts` — the actual grid search over the parameter space,
  reporting both the top-ranked candidates and, separately, which ones
  actually pass every threshold.
- `model.test.ts` / `sweep.test.ts` / `shape-search.test.ts` —
  invariants only, no asserted directional claim that wasn't actually
  verified first. Includes regressions for two real bugs caught while
  building this (the params-mutation leak, and the flawed late-collapse
  metric) and for the concrete regime search-run.ts's grid actually
  found.
