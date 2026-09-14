# Cyberfixer Card Reference

Player-facing rules text for the card concepts developed while pressure-testing
the resolution engine — each one names a real mechanical capability the engine
has been confirmed to support, not just a paper design. Where a card leans on
something not yet wired into a real match (a mutable resolution policy, a
contract with a grace period), that's noted plainly rather than hidden.

Format per card: **Name** — *Type, cost*. Rules text as a player would read
it. A flavor line underneath, because nobody in this business writes anything
down straight.

---

## Stack manipulation — the paper trail itself is a weapon

### Forged Ledger
*Ability — Cost: 3 outflow.*

Target a pending action (yours or an opponent's). Change when it's considered
to have happened. It now resolves as if it were the most (or least) recent
thing anyone did this turn — your call.

*Nobody checks the timestamp. They check whether the timestamp looks right.*

### Insurance Policy
*Ability — Cost: 2 outflow.*

Target a pending action. Until end of turn, it *looks* more urgent than it
is — but only to anyone judging urgency by feel. If it ever comes down to
"which of these happened first, exactly," the real order still wins.

*A rumor can move a market. It can't move a court date.*

### Plausible Deniability
*Ability — Cost: 4 outflow. Reactive.*

Target one of your own pending actions currently backing up someone else's
play. Cut it loose — it becomes its own thing, answerable to no one.
Anything that would've caught it in a wider sweep has to catch it on its
own now.

*You were never part of that conversation. You have people who can confirm this.*

### The Long Con
*Ability — Cost: 5 outflow.*

Target any pending action, yours or an opponent's — buried or not. Respond
to it directly. It's not gone. It's just not up next anymore.

*Patience isn't a virtue here. It's a delivery mechanism.*

---

## Priority and reaction — everyone gets to talk before anything happens

### Reflex
*Passive.*

Whenever an opponent passes priority, this contractor automatically
proposes its bound response for free, no action required. You still pay
its normal cost.

*You don't decide to flinch. That's the whole point of a flinch.*

### Ghostwriter
*Passive.*

Whenever an action you control resolves, you may immediately counter one
other pending action of your choice, no cost.

*Someone always writes the follow-up statement before the story's even out.*

### Hedge Fund
*Ability — Cost: 3 outflow.*

Propose a second action responding directly to one you already have
pending. Yes, your own. Nobody said the paranoia stops at the edge of
your own desk.

*Cover your position against your own position. That's not redundant. That's due diligence.*

### Sleeper Agent
*Ability — Cost: 2 outflow.*

Target any pending action currently buried under something else. Respond
to it directly — you don't need it to be next in line, just pending.

*It doesn't matter what's on top of the file. It matters that the file exists.*

---

## Ownership and targeting — nothing stays yours just because it started that way

### Turncoat
*Ability — Cost: 6 outflow.*

Target a pending action. Take credit for it. For every purpose that
matters — who it's attributed to, whose interests it now serves — it's
yours, from this moment on, even though it hasn't happened yet.

*Loyalty is a rumor everyone agrees to believe until the moment it's expensive.*

### Blackmail
*Ability — Cost: 2 outflow.*

Target an opponent's contractor. They pay this ability's cost from their
own outflow, not you from yours. If they can't afford it, this doesn't
resolve.

*You're not asking them for a favor. You're informing them of an obligation they already have.*

### Guilt by Association
*Ability — Cost: 5 outflow.*

Target one pending action. Every action currently responding to it,
directly or through a chain of responses, gets hit too — along with
whoever's behind each one. You only named one name. That was enough.

*Nobody asks who ELSE was in the room. They just close the room.*

---

## Denial and protection — sometimes the paperwork just doesn't go through

### Protection
*Ability — Cost: 4 outflow. Reactive.*

Target one of your own contractors or contracts currently the target of
a pending action. It stops qualifying as a legal target for that action,
right now. When that action would resolve, it fizzles instead — whatever
it was going to do simply doesn't happen.

*The best alibi isn't proving you were somewhere else. It's making the question stop making sense.*

### The Cleaner
*Passive.*

Whenever one of your own actions fizzles for any reason, gain 2 outflow.
Something still got salvaged.

*A wasted trip isn't wasted if you bill for the mileage.*

### Standing Order
*Ability — Cost: 1 outflow. Usable only when nothing is currently pending.*

A quiet, uncontested action — no opponent gets a window to respond, because
there's nothing on the table for them to respond to. Draw a card.

*The only truly safe move is the one made in an empty room.*

---

## Resolution order itself — whoever writes the rules of the room wins the room

### Debt Collector
*Ability — Cost: 3 outflow. For the rest of this turn.*

For the rest of this turn, whenever two or more actions are equally
eligible to resolve, the one proposed by whichever fixer currently has
the *lower* inflow goes first.

*The house always lets the guy who's already losing go first. Gives everyone else time to watch.*

### Escalate the Chain
*Ability — Cost: 6 outflow. For the rest of this turn.* **(design note: needs a mutable, per-match resolution policy the engine doesn't expose yet — see the engine's own "deliberate stub" note on this.)*

For the rest of this turn, pending actions resolve oldest-first instead
of newest-first — or by whatever other order you name when you play
this. You set the rules of the room. Everyone else just has to live in it.

*Whoever's holding the gavel decides what "in order" means.*

---

## Contracts and time — the reckoning always comes, the question is when

### Audit (a.k.a. Force Reckoning)
*Ability — Cost: 7 outflow. Main phase, goes through the stack.*

Force an immediate re-evaluation of every contract in play, right now,
instead of waiting for anyone's next upkeep. Expensive for a reason —
you're the one who decided today was the day to check the books.

*Nobody wants an audit. Somebody eventually has to want one more than the alternative.*

### Statute of Limitations
*Contract modifier.* **(design note: not yet built as real content — a genuine card concept, not yet a registered contract type.)*

Attach to a contract. The first time its own condition is found violated,
it doesn't cancel immediately — it starts a clock. If the violation is
still true three turns later, it cancels as normal. Fix it before then
and the clock resets to nothing, like it never happened.

*Everyone's entitled to one honest mistake, as long as they clean it up before anyone official notices.*

### Chain Reaction
*Ability — Cost: 4 outflow.*

When this resolves, mark your acting contractor. At the start of your
next upkeep, if it's still marked, immediately propose its bound
follow-up action for free.

*One thing leads to another. That's not an accident. That's the design.*

### Cold Case
*Ability — Cost: 5 outflow.* **(design note: powered by a prototype "query the past" mechanism, not yet wired into any real match — see the engine's own `SnapshotHistory` for the mechanism this is built on.)*

Target a contract. Compare its current standing against exactly three
turns ago. If it's worse off now than it was then, cancel it — no
grace, no check of its own condition, just the plain fact that things
got worse and nobody did anything about it.

*The file doesn't need a new complaint. It just needs someone to notice the old one never closed.*

---

## A note on how to read these

Every card above names a real capability — a card author reading this
document should be able to point at the exact mechanic (a `reparent`,
a re-validation, a resolution policy score) each one is standing on.
Where a card gets ahead of what's actually wired in (Escalate the
Chain, Statute of Limitations), that's called out explicitly rather
than left for someone to discover the hard way later.
