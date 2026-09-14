# Cyberfixer Design Framework

This is the reference to point at when generating cards, writing rules,
or tuning balance — not a summary of a conversation, a working tool.
When a card or mechanic is under consideration, run it through the
checklist in §5 before building it.

## 1. The terminal goal, and the one discipline that protects it

**Terminal goal:** outcome uncertainty that resolves *in proportion to
who managed optionality better* — not who got lucky. Every section below
exists to serve this one sentence. Nothing here is self-justifying.

**The permanent hazard:** variance produces the identical *symptom* as
depth (nobody can call the winner) through an illegitimate mechanism. A
coin flip satisfies "hard to predict" just as well as a deep, mutually-
legible strategic standoff does — the two are indistinguishable from the
outside, which is exactly why this has to be checked deliberately, every
time, rather than assumed. **Hard-to-predict is only worth having if
it's hard *because of skill*, not despite it.**

**The one thing that doesn't need designing in:** optionality-seeking is
an automatic, decision-theoretic response to adversarial uncertainty —
holding a flexible position has real value independent of what you'd do
with it, the same logic as a financial option. You don't build the
instinct into players. What you design is whether the resource system
gives that instinct somewhere real to go.

**The one thing that does need designing in: a coupling point.**
Two players independently optionality-seeking, with no point of shared
contact, produces two parallel solitaire games at one table — not
tension. Genuine coupling (shared scarcity, a contested claim, direct
interference in each other's pipeline) is what turns separate hoarding
into a real arms race — and once that coupling exists, each player's own
self-interested play *becomes* the forcing function on its own. No
separate clock is required once coupling is real. Where the coupling
point sits, and how tight it is, is the actual design lever — not
"do we need a forcing function."

## 2. The optionality axes

Four independent axes. Adding "more optionality" without naming which
axis is being fed is how a design ends up saturating one axis while
believing it enriched the whole resource.

| Axis | What it measures | Saturates into | Failure mode if it's the only axis fed |
|---|---|---|---|
| **Extensive** | How many actions are available right now | Hand size, spendable resource, open board slots | "More stuff," no new decisions — quantity without texture |
| **Intensive** | How *different* the available actions are from each other | Card diversity, distinct effect types | A big hand of near-identical cards is extensively rich, intensively poor |
| **Latent** | What you *could* eventually reach but haven't | Deck contents, recursion targets, anything the opponent must respect without proof it exists | Costs nothing to hold, still constrains the opponent — the one axis that's free to keep |
| **Reactive** | Whether you can act on *new* information, not just on your own turn | Instant-speed/flash-style plays, held-up responses | A game can be rich on every other axis and still have zero of this one |

## 3. The epistemic lens

Every domain in the game reduces to the same two base questions, plus
one domain-specific third axis that the base pair doesn't cover on its
own.

**Base questions, always:**
1. Who can see this, and when does that change?
2. Is the transition reversible, or does it commit?

| Domain | Domain-specific third axis | Design note |
|---|---|---|
| **Zones** (deck/hand/board/discard) | Reveal + commit, fused — every zone transition does both at once | The transitions that matter do BOTH; one without the other is either a free look or pure bookkeeping |
| **Time constraints** | Fixed vs. manipulable deadline (crossed with known vs. hidden = 4 real states) | Hidden + manipulable is the richest and most dangerous cell — indistinguishable from randomness with zero tell |
| **Opportunity shape** | Exclusive vs. shared; telegraphed vs. untelegraphed | Exclusive opportunities are a direct, clean coupling point — a claim/race dynamic, distinct from direct pressure |
| **Adversarial surface** | Direct vs. indirect; attributable vs. deniable | Fixers want **indirect + deniable** — routing pressure through shared structure, not trading blows. This is the thematically correct quadrant, not the simplest one |
| **Deception** | Passive concealment vs. active misrepresentation; verifiable vs. unverifiable | Unverifiable deception is the dangerous cell — it *looks* like depth from outside while functioning like a coin flip underneath |
| **Resources (aggregate totals)** | Aggregate-visible, component-hidden — a genuine third epistemic state, neither "known" nor "hidden" | Both players see a fixer's total spend; neither knows which specific cards will supply it |

## 4. Mechanism types, and what each is actually for

| Mechanism | Native strength | Design constraint |
|---|---|---|
| **Dice / randomness** | — | Only earns its place if the *distribution* was shaped by an earlier skillful choice (how many dice, which modifier, what floor). A roll with no antecedent decision is a direct terminal-goal violation, not a style choice |
| **Tokens** | Pure extensive quantity, zero intensive optionality by construction | Right tool specifically for anything meant to feel fungible — the natural representation of *freed, liquid* value, as distinct from the non-fungible chain-links that produced it |
| **Individual cards** | Primary carrier of intensive optionality | — |
| **Resource totals** (inflow/outflow-style) | Aggregate-visible/component-hidden (§3) | Value is contextual — (fixed properties) × (current shared state), never intrinsic |

## 5. The three-act arc — residue, not a goal

Ramp → engine → payoff is not designed in directly. It's the predictable
result of the sections above interacting, which means it can be broken
by removing any one precondition — useful as a lever, not just an
observation.

| Act | Why it happens | Precondition that produces it | What breaks it if removed |
|---|---|---|---|
| **Early** | Pure holding is correct — nothing punishes it yet | The forcing function hasn't tightened enough to bite | Remove this precondition (an immediately-biting forcing function) and there is no early game at all |
| **Mid** | Some resources convert into *more future optionality* rather than spending it down | Genuine engine-shaped cards exist in the pool | Remove pure-conversion pieces and mid-game collapses into a direct early/late split, nothing between |
| **Late** | The forcing function has bitten hard enough that further holding is net-negative | A real, tightening forcing function, and accumulated potential worth cashing in | A forcing function that snaps instead of tightens either forecloses tension early or never bites at all |

## 6. The four-question checklist

Run every candidate card, rule, or mechanic through these, in order,
before building it.

| # | Question | What a bad answer looks like |
|---|---|---|
| 1 | Which optionality axis does this feed — extensive, intensive, latent, or reactive? | "It adds more stuff" with no axis named, or feeding an axis that's already saturated |
| 2 | Is it a forcing-function component? Does it tighten gradually, or snap? | A snap either forecloses tension early or doesn't bind until it's meaningless |
| 3 | Does it open a new edge in the resource-conversion graph, or is it a dead end? | Dead ends are fine and necessary (that's what a payoff *is*) — a design with only dead ends has no mid-game |
| 4 | Is its natural arc placement (ramp/engine/payoff) consistent with when a player can actually afford it? | A payoff-shaped effect cheap enough to deploy early collapses late-game timing into early-game availability |

**Meta-question, underneath all four:** does this satisfy its stated
purpose through depth, or is it quietly borrowing from variance to
produce the same symptom? (§1)

## 7. Companion tool

`games/cyberfixer/design-sim/` is a small, deliberately abstract
simulation of §1's core dynamic — hold vs. commit, under decay and
mutual pressure — for getting a *loose*, Monte-Carlo-style read on how
rule parameters (forcing-function strength, coupling tightness,
conversion policy, injected noise) affect game duration and the
skill-vs-variance balance from §1. It does not simulate cyberfixer's
actual rules; see that directory's own README for what it does and does
not claim to show.
