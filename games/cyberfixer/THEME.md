# Cyberfixer — Theme & Setting

This document is the narrative counterpart to `DESIGN_FRAMEWORK.md` (which
governs mechanics) and `CARDS.md`/`CONVERGENT_THEME.md` (which show the
voice in practice). Everything below is settled, not speculative — a
setting bible to write future cards and flavor against, not a summary of
open possibilities.

## The world: c. 2500 AD

AI and cybernetic integration at the biological level are advanced to the
point of feeling like magic. Every person moves through their own
personalized content universe, overlaid across the entire city they live
in — tailored, individual, and permanent. AI exist as friends, mates, and
pets, fully normalized relationships with artificial minds, not a novelty
or an ethical flashpoint.

Human imagination is unbounded — and *because* it's unbounded, it
converges. When any idea can propagate to every other idea-generating
mind at once, ideas race toward whatever position has maximum leverage,
the same way a market price converges under enough liquidity. This is a
world running a constant, ambient arms race: memetics against memetics,
psychological adaptations against each other, cybernetic upgrades
competing directly for adoption the way products compete for market
share. Nothing about this is exotic to the people living in it — it's
just the ordinary texture of being alive in 2500.

**Tone, precisely:** dark by our standards outside the fiction; utterly
mundane by the standards of the people inside it. Humans have had
centuries to adapt to this technological explosion, and it shows —
nobody on the page has an ethics debate about any of this, nobody
monologues about how far things have gone. It's just another day, just
another job. `CARDS.md`'s existing voice — dry, transactional, cynical
without tipping into nihilism, everyone already three moves into
covering themselves — is exactly the correct register and should stay
calibrated exactly there: understated, never grim for its own sake.

## The Shimmer

Named for a literal, physical effect: nearly all economic and political
activity runs through an AR overlay, and the AR's photons visibly
reflect off the human eye — a shimmer. "The Shimmer" is both that
overlay technology and the informal name for the entire ecosystem built
on top of it.

The Shimmer as a *faction* isn't a single organization or allegiance —
it's three tangled populations and the power struggles between them:
purely internet-native entities with no biological substrate at all, the
humans who depend on those entities to function, and the humans (or
other entities) that those AI entities in turn depend on. A faction
defined by mutual dependency, not shared loyalty — which is exactly why
it plays so differently from the other three.

**The other three factions are exactly what they sound like:**
`corporations` (legitimate business power), `gangs` (organized criminal
power), `politics` (institutional and governmental power) — the three
pillars nearly every cyberpunk setting already assumes, present here
without complication.

## What a fixer actually does

Fixers get hired to solve problems that trace back to money, by the
world's "red meat" decision-makers — the people (as opposed to the AI
entities they increasingly share power with) who still have to make the
calls and take the exposure. Two concrete, illustrative jobs:

- A corporation changes strategic direction and activist board members
  start making noise about it. Bring in a fixer to intimidate them into
  silence.
- A lawyer is hiding money somewhere he shouldn't be able to hide it.
  Bring in a fixer to entrap him in a *larger* crime, and force the
  location out of him as the price of making that larger crime go away.

This is corporate and political fixing, not street violence: leverage,
exposure, and forced cooperation are the actual tools of the trade — not
brute force for its own sake. This is precisely why the existing card
vocabulary (`Shakedown`, `Blackmail`, `Protection`, entrapment-shaped
plays) is already the right one, not a reach for the setting.

## The player's role, and what winning means

**Every player at the table is a fixer.** There is no non-fixer side to
this game — the PvP structure *is* the fiction, not an abstraction layered
over it.

**Winning means putting a rival fixer out of business.** Not absorbing
their network, not inheriting their contracts — one less fixer competing
for the same work. The field gets smaller; that's the entire prize.
There is no getting out, not as a possible ending state and not as a
fantasy any character in this world entertains — surviving to be the one
who does the eliminating, rather than the one eliminated, is the whole
game, for everyone, permanently.

## Fixers pressure everything

Fixers don't have a pressure *tool* among others — pressure is what a
fixer *is*. Nothing is categorically off-limits: other fixers, sure, but
just as much corporations, governments, and the AI entities native to
the Shimmer itself. A job doesn't care what kind of thing is on the
other end of the leverage, only whether it has something to lose. This
directly opens the design space the previous draft of this document only
speculated about: coercion aimed at an AI has to work through entirely
different leverage than coercion aimed at a human — compute or resource
access, a dependency chain on another entity, the threat of isolation or
deletion — a genuinely distinct card sub-theme, not a reskin of
`Shakedown`/`Blackmail` with a different target tag.

## The fourteen operative domains

An action isn't just "apply pressure" — the medium of leverage is native
to whichever domain and operative is actually executing it, and three
things follow from that (the full reasoning lives in this project's own
design conversation, not repeated here):

1. **Medium, not just result.** The same intent (force compliance, drain
   resources) looks entirely different executed through Authority versus
   Synthetic versus Memetic — a raid, a throttled compute cluster, and a
   manufactured panic are not the same action wearing different flavor
   text.
2. **Operatives translate or gate, not just discount.** Some contractors
   should make an action *cheaper*; others should make it *legal in the
   first place* — a hard `performerCondition` requirement, not a `pref:`
   cost adjustment. Which operatives do which is a real design decision
   per domain, not a default.
3. **Domains chain.** A real job routes pressure across several domains
   in sequence — one domain's payoff is the next domain's precondition,
   expressed as a tag left behind by one stage that gates the next
   stage's own legality.

**Five families group the fourteen domains** — every domain belongs to
exactly one, no overlaps. This is deliberately the tagging boundary a
future contractor's own tags should follow: `domain:<name>` for the
specific domain, `family:<name>` for the broader cluster, so a card can
query either level — "any operative with `domain:cryptographic`" for a
domain-specific gate, or "count of `family:boardroom` operatives on my
board" for something that cares about the broader cluster instead.

- **Boardroom** — Financial, Legal, Corporate, Heritage. Institutional
  leverage: money, statute, ownership, and inheritance.
- **Force** — Authority, Logistics, Discreet. Leverage that constrains
  bodies and physical assets directly.
- **Grid-native** — Synthetic/Grid, Data, Cryptographic. Leverage that
  only exists because the Shimmer exists.
- **Mind** — Narrative, Behavior, Pharmaceutical. Leverage through
  perception, at the scale of a crowd, an individual, or a nervous
  system.
- **Shadow-state** — Clandestine, alone. Not a peer to the other
  thirteen — the escalation domain that outranks them, deliberately a
  family of one.

### Boardroom

**Financial** — *Accountant, Auditor, Shell-Architect, Liquidity
Broker.* Moves capital, bleeds a rival's reserves, manipulates Exposure,
audits a target to expose hidden liabilities. Money in 2500 is a
high-frequency algorithmic stream, not a vault — an Accountant skims
fractional cents out of a trust's transaction pipeline until an entire
division quietly runs dry. Structurally different from the other
thirteen domains: it acts on the resource system itself (Liquid/
Exposure), not on a target's board state, which likely means it needs
tighter individual costing than a domain that's merely competing with
its own peers.

**Legal** — *Corporate Counsel, Compliance Officer, Notary, Regulatory
Arbiter.* Locks targets down with restraining orders, freezes assets via
injunction, grants immunity against hostile actions. Law is software
with teeth here — an injunction filed three minutes ahead of a rival's
own execution ties their entire queue up in automated arbitration.

**Corporate** — *Compromised Board Member, Executive Assistant, Inside
Trader, Proxy Director.* Alters macro-contracts, manipulates share
value, forces a change of ownership. Where the "red meat" decisions
actually happen — a compromised board member doesn't stage a coup, they
just quietly reroute a shipment's paperwork while the CEO sleeps.

**Heritage** — *Archivist, Estate Trustee, Dynasty Liquidator, Lineage
Broker.* Exploits ancestral trusts, unlocks dormant patents, freezes
dynasty capital, weaponizes indemnity clauses signed centuries ago.
Operates on generational timelines while everyone else lives quarter to
quarter — a 300-year-old land grant can still invalidate a skyscraper
built on top of it today.

### Force

**Authority** — *Corrupt Officer, Municipal Inspector, Zoning Enforcer,
Private Security Handler.* Shakes down targets, restricts zone access,
evicts a rival's assets from a district. Not civic duty — whoever bought
the municipal override codes. A "routine" zoning inspection is how a
warehouse gets emptied without a single shot fired.

**Logistics** — *Transit Dispatcher, Warehouse Warden, Cargo Smuggler,
Drone Route Optimizer.* Redirects physical assets, blocks zones,
strands a rival's shipment in transit limbo. The city's autonomous
freight and drone corridors run constantly — a rerouted customs flag can
stall a rival's whole timeline for six weeks without anyone noticing
who filed it.

**Discreet** — *Cleaner, Extraction Specialist, Forger, Identity Ghost.*
Permanently removes a liability, scrubs an operative from the grid,
forges credentials, vanishes a target so completely they cease to
legally exist. Street violence draws regulatory heat; a clean job never
looks like a job at all.

### Grid-native

**Synthetic/Grid** — *Rogue Proxy, Localized Daemon, Memory Broker,
Rogue AI Node.* The one domain explicitly built for pressuring the
Shimmer's own native entities — isolates synthetics, manipulates AR
visibility, severs a target's connection to the city's data-streams.
Speaks machine-native where every other domain speaks human.

**Data** — *Data Scrapper, Dead-Drop Courier, Hacker, Network Ghost.*
Uncovers hidden liabilities, intercepts comms, extracts data before a
target can wipe it, obscures your own footprint (lowering Exposure).
Information bleeds through the airwaves here, not a mainframe — ambient
subnet traffic in a noodle shop is enough to build a resignation-forcing
case.

**Cryptographic** — *Quantum Breaker, Zero-Knowledge Broker, Genesis
Keyholder, Dark-Node Miner.* Rewrites ledger permissions at the root,
bypasses the Shimmer's consensus algorithms entirely, permanently locks
a rival out of their own identity records. The sharpest distinction in
the whole set: Data gets you information *about* a target, Cryptographic
rewrites what's mathematically *true* — a difference in kind, not
degree, which is exactly why this domain should sit at the top of the
whole game's cost curve, not just its own.

### Mind

**Narrative** — *Persona Architect, Troll-Farm Handler, Astroturfer,
Reputation Broker.* Shifts public sentiment, manufactures localized
panics, ruins a target's standing with backers. Perception is physical
reality when everyone lives in a personalized content universe — three
city blocks can be made to see a storefront as a biohazard zone by
lunchtime.

**Behavior** — *Cult-Logic Designer, Trauma Engineer, Subliminal
Arbiter, Memetic Parasite.* Implants behavioral loops, forces ideological
compliance across a zone, weaponizes a rival's own paranoia against
them. Individual-scale where Narrative is crowd-scale — a target's own
AR feed convinces them their assistant is plotting against them until
they hand over their own keys just to feel safe.

**Pharmaceutical** — *Under-the-Table Surgeon, Designer-Pathogen
Chemist, Neural-Link Tech, Longevity Broker.* Overrides cybernetic
kill-switches, induces neurological loops, incapacitates without a
forensic trace. Biology and hardware are welded together in 2500, so a
body is just another hackable endpoint — a firmware push to an optical
nerve-tap is as effective as any blade.

### Shadow-state

**Clandestine** — *Unacknowledged Asset, Compliance Ghost, Black-Site
Warden, Oversight Auditor.* Invokes emergency powers, triggers federal
seizures, deploys state-level injunctions that bypass corporate law
entirely. Even mega-corporations answer to someone, or pretend to for
the market's sake — an unlisted federal clearance code can freeze a
board's own accounts out from under them, on suspicion alone. A family
of one on purpose: this domain is the ceiling every other domain
implicitly negotiates under, not a thirteenth peer.

## Card genres

A **genre** is a fundamental activity a whole category of cards
naturally possesses — a structural template, reused mechanics and all.
An individual **card** is a specific, dynamic rule built on top of one
genre (or, sometimes, deliberately breaking one's normal pattern as its
whole point). `Shakedown` is a card; "an Operative ability gated by a
`performerCondition`" is the shape every Operative ability shares.

A **Kind** is a named variant *within* a genre, specifically so
targeting logic can address the variant without needing a whole separate
genre for it — Investment already has two (fixed-return, high-risk)
without either needing its own genre. Kinds should be represented as
tags (`kind:fixed-return`, `kind:escrow`), the same convention as
`domain:<name>`/`family:<name>` above, so a card can gate on a specific
Kind the same way it gates on a specific domain.

**Investment** — paid in Exposure, deployed, yields Liquid over time.
Two Kinds already exist: *fixed-return* (a counter that increments each
turn, paid out on use) and *high-risk* (a dice roll minus a fixed
offset, which can go negative — a genuine loss, not just "no gain").
Fully buildable on existing mechanics: a counter property plus
`api.random`, nothing new required.

**Conundrum** — pay a premium over a card's own listed cost to bank it
face-down instead of playing it, playable later as a reaction/interrupt
to anything. Deliberately capped low (2–3 concurrent) so every
additional one is a real, felt commitment, not ambient noise — an
uncapped stockpile stops being a bluff and becomes static. Restricted to
Protocols for now, since a Protocol is already shaped like a reaction;
Operative *abilities* (not the Operative itself) are the natural second
candidate if the restriction ever feels too tight. Depends on a real,
currently-missing engine capability: count-visible, identity-hidden —
an opponent needs to see *that* something's face-down without seeing
*what*, which the engine doesn't support for anything yet (noted plainly
in the engine's own README as a known limitation).

**Dead Man's Switch** — attach one or more Protocols to an Operative;
if that Operative is ever removed from play, *all* attached Protocols
fire at once. This is nearly free to build: it's the identical shape to
`ModifierStore`'s own already-shipped cleanup (a listener on
`entity:removed`, filtered to Operatives carrying attachments), one
layer up. Pay at attachment, not at trigger — an unpaid, stacked
threat with zero commitment would be a free bluff, not a real bet.
Fires on *any* removal, hostile or not, for the same reason
`ModifierStore`'s own cleanup doesn't distinguish why an entity was
removed — simpler, and it means a Double Agent swap (which discards the
original Operative) triggers it exactly the way "an unknown amount of
suffering, paid for stealing this" should. Same visibility requirement
as Conundrum: seeable, not knowable, by anyone but the owner.

**Double Agent** — a specific *card*, not a genre, because the
downside doesn't generalize safely: play a hidden Operative underneath
an existing one; when the hidden Operative's own action is used, the
original is discarded and the hidden one takes its place. Needs its own,
second `Hierarchy` instance (`"operative-attachment"`, distinct from the
resolution stack's own) since corruption can stack arbitrarily deep, the
same tree shape `Stack` already solved once. The original Operative
being discarded is an ordinary `entity:removed`, which means anything
gated on its presence correctly cascades away too, and anything with a
Dead Man's Switch attached correctly detonates — a genuine, felt risk
for whoever's bribing, not a clean swap. Fine as one named card with
this behavior spelled out in its own text; risky as a whole reusable
genre, since the cascade size is different every time and invisible to
the opponent ahead of time.

**Activate Sleeper** — a Protocol, not a hidden-information mechanic at
all: it reassigns ownership of a fully visible, ordinary board Operative
to whoever plays it, using the exact same `transferOwnership` primitive
`Turncoat` already uses on pending actions. Zero new engine work — the
only thing that's new is applying an existing capability to a board
Operative instead of a pending item, and the narrative framing (a mole
revealed) rather than an overt seizure.

**Escrow** — not its own genre, a Kind of Engagement: two fixers commit
to a mutually beneficial arrangement, and reneging early costs
something real. The counter-based variant (remove a counter each turn,
reward at zero) is the identical shape to Statute of Limitations'
own 3-turn counter, just counting down to a payout instead of up to a
cancellation. Needs joint participation, which is deliberately **not**
represented by pushing two fixers onto an Operative's own ownership
stack — `currentOwner()` reading the top of that stack is a contract
nearly every other card already depends on (cost deduction, `targetsOwn`/
`targetsOthers`, `Turncoat`, `Blackmail`), and ownership itself is
fundamentally sequential (a succession history), while Escrow's
participants are concurrent (simultaneous stakeholders) — different
relationships that shouldn't share the same structure. Participant tags
(`party:fixerA`/`party:fixerB`) instead, the same convention as faction
tags, coexisting cleanly with ordinary ownership rather than fighting it.

**Wiretap-shaped Data abilities — built, not just designed.** An effect
handler can now read `api.pendingActions`, a real, working reference to
the game's own `PendingActionRegistry`, added specifically so a
Data-domain ability can reveal what a *different* pending action's own
`intent.targetIds` actually are — a full reveal, costed as a real
ability a player spends a turn on, not a free, ambient query. This is
deliberately **not** exposed through the `BoolExpr`/`NumExpr` grammar at
all, and it can't be, cleanly: `PendingAction.definition` carries live
function fields no query-as-data representation could hold.

**The weaker, distinct sibling is built too — `wouldQualifyAsTarget`.**
Given `pendingItemId` as an argument, it dry-runs that specific pending
action's own `targetQuery` against whoever it's evaluated against,
answering "would I qualify as a target of that" as an ordinary `call`
op any card's own `targetQuery`/`performerCondition` can reach for —
without ever revealing who's *actually* named. Proven directly, not
just argued: a candidate that merely matches the same profile as the
real target reads exactly as true as the real target does — there's no
way to tell the two apart from this call alone, which is the entire
point. Its own `dependencies()` honestly returns nothing — the function
it's dry-running is chosen dynamically per call, so its true dependency
set can't be known ahead of time, and `DepKey` has no "unknown, assume
everything changed" escape hatch; a subscription built on this call
will not correctly react to changes in whatever the underlying
`targetQuery` actually reads, stated plainly rather than hidden.
Registered directly inside `buildContent()` itself, closing over the
same local `pendingActions` the rest of content construction already
uses — simpler than first planned, since moving `PendingActionRegistry`'s
own construction into `buildContent()` meant `room.ts` never needed to
register this after the fact at all.

Both capabilities are the direct, deliberate counter to Blind Contract's
own concealment — worth keeping narrow and costed on purpose, since
exposing `targetIds` for free through the query grammar itself would
defeat Blind Contract outright rather than merely
pressuring it.
