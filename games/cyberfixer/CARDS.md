# Cyberfixer Card Reference

Player-facing rules text for the card concepts developed while pressure-testing
the resolution engine — each one names a real mechanical capability the engine
has been confirmed to support, not just a paper design. Where a card leans on
something not yet wired into a real match (a mutable resolution policy, a
contract with a grace period, the "query the past" mechanism), that's noted
plainly rather than hidden.

## Keywords

Every card below uses these words the same way, every time:

- **Pending** — proposed, but not yet resolved. Sitting in the shared queue,
  waiting.
- **Propose** — put a new action into the pending queue.
- **Respond to X** — propose a new pending action that specifically answers
  an already-pending action X. X can't resolve until whatever's responding
  to it is dealt with first.
- **Buried** — a pending action that currently has something responding to
  it. A buried action can't resolve yet, but it isn't gone — it resolves
  normally once whatever's burying it is cleared.
- **Resolve** — a pending action's effect actually happens.
- **Fizzle** — a pending action is discarded WITHOUT its effect happening,
  because it stopped being a legal play by the time its turn came up.
  Different from being countered: nobody spent anything to stop it, it just
  stopped qualifying.
- **Counter** — a deliberate act that removes a pending action from the
  queue before it resolves, whether or not it was still legal.
- **Priority number** — the value that decides resolution order by default:
  whichever pending action has the highest priority number resolves next.
  Every pending action gets one automatically, the moment it's proposed.
- **Pass** — decline to act. Once every fixer has passed in a row with
  nothing new proposed since, the pending queue starts resolving.

Format per card: **Name** — *Type, cost*. Mechanically exact rules text.
A flavor line underneath, because nobody in this business writes anything
down straight.

---

## Stack manipulation — the paper trail itself is a weapon

### Forged Ledger
*Ability — Cost: 3 outflow.*

Target a pending action. Set its priority number higher (your choice: higher
or lower) than every other pending action's right now. This changes its
actual position in the queue — including for resolution-order comparisons
that read priority numbers directly, not just ones judging by how urgent
something looks.

*Nobody checks the timestamp. They check whether the timestamp looks right.*

### Insurance Policy
*Ability — Cost: 2 outflow.*

Target a pending action. Until end of turn, add 1000 to its priority number
for the purpose of any resolution-order comparison that scores by "urgency"
or similar judged criteria. This does NOT change its actual, stored priority
number — anything that resolves ties by "who was really proposed most
recently" still sees the truth.

*A rumor can move a market. It can't move a court date.*

### Plausible Deniability
*Ability — Cost: 4 outflow. Only targets your own pending actions.*

Target one of your own pending actions that's currently responding to
something else. It stops responding to that thing — it becomes an
independent, unrelated pending action instead. Anything that would have
caught it by tracing what responds to what has to catch it on its own now.

*You were never part of that conversation. You have people who can confirm this.*

### The Long Con
*Ability — Cost: 5 outflow.*

Propose a new action that responds to any pending action — buried or not,
yours or an opponent's. This doesn't remove or counter what you're
responding to. It just means that pending action can't resolve until yours
does first.

*Patience isn't a virtue here. It's a delivery mechanism.*

---

## Priority and reaction — everyone gets to talk before anything happens

### Reflex
*Passive.*

Whenever an opponent passes without proposing anything, immediately propose
this contractor's bound response for free — no action required from you.
You still pay its normal cost.

*You don't decide to flinch. That's the whole point of a flinch.*

### Ghostwriter
*Passive.*

Whenever an action you control resolves, you may immediately counter one
other pending action of your choice, at no cost.

*Someone always writes the follow-up statement before the story's even out.*

### Hedge Fund
*Ability — Cost: 3 outflow.*

Propose a second action that responds directly to one you already have
pending. Yes, one of your own. Nobody said the paranoia stops at the edge
of your own desk.

*Cover your position against your own position. That's not redundant. That's due diligence.*

### Sleeper Agent
*Ability — Cost: 2 outflow.*

Propose an action responding directly to any pending action that's
currently buried under something else — you don't need it to be next in
line, only pending.

*It doesn't matter what's on top of the file. It matters that the file exists.*

---

## Ownership and targeting — nothing stays yours just because it started that way

### Turncoat
*Ability — Cost: 6 outflow.*

Target a pending action. Reassign whose it is. For every purpose that
depends on ownership — who it's attributed to, who it's scored as
belonging to for resolution order, whose interests it now serves — it's
yours from this moment forward, even though it hasn't resolved yet.

*Loyalty is a rumor everyone agrees to believe until the moment it's expensive.*

### Blackmail
*Ability — Cost: 2 outflow.*

Target an opponent's contractor. This ability's own cost is paid from that
opponent's outflow instead of yours. If they can't afford it, this doesn't
resolve.

*You're not asking them for a favor. You're informing them of an obligation they already have.*

### Guilt by Association
*Ability — Cost: 5 outflow.*

Target one pending action. When this resolves, also affect every pending
action currently responding to it, directly or through a chain of
responses — and whoever each one belongs to. You only named one target.
That was enough.

*Nobody asks who ELSE was in the room. They just close the room.*

---

## Denial and protection — sometimes the paperwork just doesn't go through

### Protection
*Ability — Cost: 4 outflow. Only targets your own contractors or contracts.*

Target one of your own entities that's currently the target of a pending
action. It immediately stops qualifying as a legal target for that
specific action. When that action's turn to resolve comes up, it fizzles
instead — its effect never happens, and whoever proposed it doesn't get a
refund.

*The best alibi isn't proving you were somewhere else. It's making the question stop making sense.*

### The Cleaner
*Passive.*

Whenever one of your own actions fizzles, for any reason, gain 2 outflow.

*A wasted trip isn't wasted if you bill for the mileage.*

### Standing Order
*Ability — Cost: 1 outflow. Usable only when the pending queue is completely empty.*

An action nobody gets a window to respond to, because there's nothing
currently pending for them to respond against. Draw a card.

*The only truly safe move is the one made in an empty room.*

---

## Resolution order itself — whoever writes the rules of the room wins the room

### Debt Collector
*Ability — Cost: 3 outflow. Effect lasts until end of turn.* **(design note: requires a mutable, per-match resolution rule the engine currently keeps fixed — see the engine's own "deliberate stub" note.)**

Until end of turn, change the default resolution order: whichever
currently-eligible pending action was proposed by the fixer with the
LOWER inflow resolves next, instead of the one with the highest priority
number.

*The house always lets the guy who's already losing go first. Gives everyone else time to watch.*

### Escalate the Chain
*Ability — Cost: 6 outflow. Effect lasts until end of turn.* **(design note: same requirement as Debt Collector above — a mutable resolution rule not yet wired into any real match.)**

Until end of turn, replace the default resolution order entirely with a
rule you name when you play this — oldest-proposed-first instead of
newest, or any other rule the game supports. You set the rule of the
room. Everyone else just has to live in it.

*Whoever's holding the gavel decides what "in order" means.*

---

## Contracts and time — the reckoning always comes, the question is when

### Audit (a.k.a. Force Reckoning)
*Ability — Cost: 7 outflow. Main phase only.*

Immediately re-check every contract currently in play against its own
condition, right now, instead of waiting for anyone's next upkeep — cancel
any that are currently in violation, exactly as upkeep normally would.

*Nobody wants an audit. Somebody eventually has to want one more than the alternative.*

### Statute of Limitations
*Contract modifier.* **(design note: not yet built as real content — a genuine card concept, not yet a registered contract type.)**

Attach to a contract. The first time its own condition is found violated,
it does not cancel immediately. Instead, start a 3-turn counter. If the
condition is STILL violated the third time it's checked, the contract
cancels then, exactly as it normally would have immediately. If the
condition is no longer violated at any check before then, the counter
clears completely, with no memory of the earlier violation at all.

*Everyone's entitled to one honest mistake, as long as they clean it up before anyone official notices.*

### Chain Reaction
*Ability — Cost: 4 outflow.*

When this resolves, mark your acting contractor. At the start of your
next upkeep, if it's still marked, immediately propose its bound
follow-up action for free, and clear the mark.

*One thing leads to another. That's not an accident. That's the design.*

### Cold Case
*Ability — Cost: 5 outflow.* **(design note: powered by a prototype "query the past" mechanism, not yet wired into any real match — see the engine's own `SnapshotHistory`.)**

Target a contract. Compare its current standing to exactly what it was
three turns ago. If it's worse off now than it was then, cancel it —
no grace period, no re-check of its own condition. Just the fact that
things got worse and nobody fixed it in time.

*The file doesn't need a new complaint. It just needs someone to notice the old one never closed.*

---

## A note on how to read these

Every card above names a real capability — a card author reading this
document should be able to point at the exact mechanic (a `reparent`,
a re-validation, a resolution-policy score, a maintained tag) each one is
standing on. Where a card gets ahead of what's actually wired in (Debt
Collector, Escalate the Chain, Statute of Limitations, Cold Case), that's
called out explicitly rather than left for someone to discover the hard
way later.
