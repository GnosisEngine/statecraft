# Nothing Is Settled Until It's Settled

A synthesis of the exotic-card pressure-testing exercise — not a list of
findings, but the single theme they all turned out to be instances of, named
precisely, plus what's still missing to fully realize it. Companion to
`DESIGN_FRAMEWORK.md`, which covers the macro-economic layer (optionality,
variance, the conversion graph); this one covers the moment-to-moment texture
of what a fixer actually experiences turn to turn.

## The theme, stated plainly

**Every fact this game tracks about a pending action — when it happened, who
proposed it, who it targets, whether it's still legal, who pays for it, in
what order it resolves relative to everything else, even whether the reckoning
that would judge it happens on schedule at all — stays genuinely mutable and
contestable right up until the instant it's actually used.** Nothing is
locked in early as a convenience. Nothing is protected from being rewritten
by someone else's move just because it would be simpler if it were. The
engine's only job is to stay honest about what's true *right now*; it never
pretends something is settled before it is.

That's not a metaphor bolted onto the mechanics after the fact. It's what
every single card this exercise produced turned out to be reaching for, from
a completely different angle each time.

## The evidence, traced

**Timing itself is mutable, not a fact.** Forged Ledger overwrites when
something is considered to have happened, permanently. Insurance Policy does
the same thing, but as a *layered, reversible* adjustment — and critically,
it fools a policy's *judgment* of urgency without ever touching the *true*
record a tie-break falls back on. Two different cards reaching for the same
theme through two different mechanisms, and the engine keeps both honest
about which is which.

**Legality itself is mutable, not a one-time check.** Protection proved that
something legal at proposal time can become illegal before it resolves, and
the engine now genuinely re-checks rather than trusting a stale answer — a
fizzle, not a silent success. Dead Drop is the same principle taken further:
the performer itself can stop existing, and every consumer of that fact
(reading it, mutating it, ignoring it) gets an honest, distinct answer
instead of one convenient lie.

**Ownership and responsibility are mutable.** Turncoat reassigns who a
pending action is attributed to after the fact. Blackmail redirects who
actually pays for it. Neither is a special engine concept — both are
ordinary reaches into state that was never protected from being rewritten in
the first place.

**Structure and position are mutable.** Plausible Deniability and The Long
Con are the same race from opposite directions — sever a link before a
cascade check reaches it, or bury something so it's merely delayed, never
denied. Sleeper Agent and Hedge Fund both prove the tree never assumed only
the "current" leaf mattered — anything pending, buried or not, yours or not,
is fair game to respond to.

**Order of resolution is mutable.** Debt Collector and Escalate the Chain
both reach for the same target: whoever currently controls the *policy*
controls the *room*, not just their own next move. This is the theme's
purest expression — not "I can change one fact," but "I can change the rule
that decides which facts get to matter first."

**Even the automatic physics has a price to renegotiate.** Audit forces the
reckoning early, at a cost, rather than waiting for it. Statute of
Limitations gives a violated contract a grace window instead of an instant
cancellation. Upkeep itself — the one phase explicitly designed to be
uncounterable, physics rather than choice — turns out to still have a
back door, provided someone's willing to pay for it.

**And underneath all of it: nothing rolls back, and nothing is hidden.**
Malfunction confirmed there's no transaction boundary — a mutation that
happens, happened, even if the effect crashes a moment later. Ghost in the
Machine confirmed that even *pending, unresolved* state has to be treated as
first-class and durable, not an implementation detail that's fine to lose.
The modifier-cleanup fix confirmed that nothing ephemeral gets to quietly
linger past its own relevance. None of this is about making state harder to
change — it's the opposite: the engine refuses to protect any fact with a
false sense of permanence, in either direction.

## The discipline that makes this possible, not an accident

This entire theme only works because of two rules established long before
any of these cards existed, and every one of them turned out to be a direct
consequence, not a coincidence:

1. **The query engine reads a pure, current snapshot of state — never a
   history, never a cached judgment.** ("Position, not velocity" — a rule
   stamps a moment into state once, and the query layer reads it forever
   after as an ordinary present-tense fact.) This is *why* re-validation at
   resolution time is even coherent: there's no stale copy anywhere to
   accidentally trust.
2. **There is no protected, "real" value hiding behind what state currently
   says.** `pushedAtSequence` isn't a reference to some deeper truth — it
   *is* the truth, as far as the system is concerned, which is exactly what
   makes Forged Ledger legal instead of a bug. An effect that fizzles isn't
   fighting a hidden validation layer; it's reading the same state a card's
   own `targetQuery` would read, honestly, right now.

Everything else — the tree over a chain, the reactive event for every
mutation, `resolveEffect`'s total lack of atomicity — is what happens when
those two rules are followed all the way through, consistently, without
carving out exceptions for convenience.

**A prototype tool worth naming here specifically, because it looks like it
should violate rule 1 and actually doesn't:** `SnapshotHistory` (built as a
prototype, not yet wired into any real game) retains real, frozen copies of
past state and lets the exact same `BoolExpr`/`NumExpr` grammar be evaluated
against one of them instead of the present. This still obeys rule 1
completely — the interpreter itself never becomes temporally aware; it's
simply handed a different, but still perfectly ordinary, `QueryContext` to
be a pure function of. The real cost isn't philosophical, it's practical:
genuine storage (a full snapshot per retained point) and a genuine
retention-policy decision, which is exactly why this stays the *second*
tool, reached for only when a card's author couldn't have anticipated in
advance which moment mattered — the ordinary "stamp it once" law from rule 1
above is cheaper and should be preferred whenever the moment that matters
was knowable ahead of time.

## What's still missing to fully realize this

Two real gaps remain, each a direct, named consequence of the theme itself
— not a random backlog, but specifically the places where "everything stays
contestable" isn't actually true yet. A third (whether legality itself, not
just resolution, can reach pending state) was identified and then actually
closed while writing this document, rather than left as an open question —
see below for what that turned up.

**A mutable, per-match resolution policy.** `content.resolutionPolicy` is
still the fixed `LIFO_POLICY` constant, confirmed and left as a deliberate
stub. This is the single largest hole in the theme as it stands: "who
controls the room" is supposed to be the purest expression of everything
above, and right now nobody can actually contest it. The fix (discussed,
not yet built): a small, mutable slot — similar in shape to
`PendingActionRegistry` — holding the currently active policy, which
`room.ts` reads instead of the fixed constant, and which an effect can
overwrite for the rest of a turn. Escalate the Chain and Debt Collector are
both, right now, aspirational rather than real.

**Contracts with their own temporal contestability.** Statute of
Limitations is a genuine design, never built as actual content — no
registered contract type currently supports a grace window before
cancellation. Given contracts are the one place upkeep's "no exceptions,
ever" physics already lives, this is the natural next place the theme
should reach, and it's currently just a card-text placeholder.

**Whether a card's own legality condition can reach pending state, not just
an effect — confirmed directly, in both directions, and the reverse
direction is now actually closed, not just diagnosed.** `targetQuery` and an
effect handler are evaluated against the exact same resolver reference, so a
proposal genuinely can be rejected outright for targeting something whose
relationship to a *known* pending item disqualifies it — checked at
validation time, before anything is even accepted. "Surveillance State"
proved this concretely: a targeting restriction gated on live
`descendantOf` structure, not tags or properties.

The natural next question — "may only target something *nothing else is
currently responding to*" — turned out to be genuinely inexpressible the
same way: `childOf`/`descendantOf` only ever check whether the *candidate*
descends from a known reference point, never whether something else
descends from the candidate, and nothing automatically binds the top-level
`targetQuery` subject to a label a nested fold could reference back to.
Confirmed by actually attempting it, which throws the interpreter's own
"unbound label" error.

Rather than extend the grammar (Option 3 from that discussion — auto-binding
the ambient subject to a reserved label everywhere, a real interpreter
change with its own footgun: a card author's own `as:"self"` would collide
with it) or reach for a registered `QueryFunction` (Option 2 — a live
computation on every evaluation, with its own `dependencies()` correctness
burden), the actual fix took Option 1: a maintained tag
(`has-active-response`), kept in sync by a rule — exactly the same shape as
`active-turn`/`phase:main`/`passed-priority` before it. `{op:"not",
expr:{op:"hasTag", tag:"has-active-response"}}` is now a completely ordinary
`targetQuery`.

Building the rule surfaced a real, previously-invisible case worth stating
plainly: `Stack.counter()` on a non-leaf item with multiple children splices
every one of them up to the grandparent by calling `Hierarchy.setParent`
directly — which fires `hierarchy:parentChanged`, but neither
`stack:pushed` nor `stack:reparented` at all for that step. A rule bound
only to those two events would have silently missed every splice-caused
"this entity just gained a response" case — the exact shape of gap
"Filibuster" already taught this game to watch for once, found again in a
different corner before it ever shipped. Binding to `hierarchy:parentChanged`
directly instead catches every case uniformly, since every one of `push`/
`reparent`/the internal splice all go through the same underlying
`setParent` call.
