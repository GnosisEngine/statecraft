# Card Engine

A server-authoritative, event-sourced, forkable multiplayer game engine — built for card games, but general enough for tabletop/board games too (see [Building a game](#building-a-game-a-walkthrough)). One real example game (`games/cyberfixer`) ships with it, fully playable, as proof the engine works rather than a promise that it will.

**Core philosophy, in one paragraph:** clients are dumb viewports — the server owns all state and all logic. Nearly everything an entity can be asked ("is this legal", "what does this add up to", "can this seat see that") is expressed as a **query expression** (`BoolExpr`/`NumExpr`) — a plain data tree, never a string or a function — so it can be logged, replayed, forked, and inspected without ever calling `eval`. Randomness goes through one seeded generator, never `Math.random()`, so a game session can be replayed bit-for-bit or forked into a genuinely independent branch. Every layer was built with real tests against real scenarios, not aspirational descriptions — where a gap in that turned out to be real (and a few did), the fix and the reasoning are left in the code as comments, not silently patched over.

## Quick start

```bash
npm install
npm run server        # boots the multi-game host on :2567
```

Open `http://localhost:2567/games/cyberfixer/` in two browser tabs (different name in each — that's what seats you into different players).

```bash
npm test              # full test suite
npm run typecheck      # TypeScript check only, no test execution
```

## Architecture at a glance

The engine is organized into layers, each built directly on the ones below it and independently tested. If you're extending the engine itself (not just building a game on top of it), this is the dependency order:

| Layer | What it is | Where |
|---|---|---|
| 0 | Entities, ids, tags, properties, ownership stack | `src/core/` |
| 1 | Query IR — the unified `BoolExpr`/`NumExpr` predicate/fold grammar (spec: [`src/query/IR_SPEC.md`](src/query/IR_SPEC.md)) | `src/query/` |
| 2 | Event bus — pub/sub everything else hangs off of | `src/events/` |
| 3 | Layered/computed properties (modifiers: add/multiply/set) | `src/properties/` |
| 4 | Action pipeline: propose → validate → resolve → emit, plus `PendingActionRegistry` for interactive (propose-now-resolve-later) play | `src/actions/` |
| 5 | Rules-as-data: trigger + condition + effect bindings | `src/rules/` |
| 6 | Phases & turn cycle | `src/phases/` |
| 7 | Persistence: event log, snapshots, deterministic replay | `src/persistence/` |
| 8 | Forking: copy-on-write branching of a game's history | `src/forking/` |
| 9 | Networking: Colyseus schema mirroring, seats, visibility, intent validation, live sync | `src/network/` |
| — | A real game built on all of the above | `games/cyberfixer/` |
| — | The multi-game HTTP/WS host | `server/` |

Every layer's tests live alongside it as `*.test.ts`. Read a layer's own file-header comments before its tests — the comments explain *why* a design choice was made; the tests prove it holds.

## Core concepts

### Entities

Everything on the table is an `Entity`: a `Card`, `Token`, `Hand` (a hand *is* a player), `Zone`, or the `Table` itself. Every entity has:

- `tags: Set<string>` — the one boolean-fact system. A "status" like tapped/flipped is just a tag.
- `properties: Record<string, number>` — plain numeric facts (`inflow`, `x`, `power`, whatever a game needs).
- `zoneId` — which zone currently contains it (or `null`).
- `ownership?: EntityId[]` — a **stack**, not a flat field, so "return to previous owner" and ownership history are free.

```ts
import { createCard, createZone } from "./src/core/entity.ts";

const board = createZone({ visibility: "public" });
const ace = createCard("Ace", { zoneId: board.id, ownership: ["fixer-A"], properties: { inflow: 3 } });
ace.tags.add("contractor");
```

All mutation goes through `EntityStore` (`src/events/entity-store.ts`) — never edit an entity object directly. Every mutation method emits an event; that's what makes everything downstream (queries, rules, sync) actually reactive.

There used to be a built-in `Deck` kind (an ordered `cardOrder` array). It was retired: "deck" is a game concept, not every game has one, and the ones that do want genuinely different things from it (a fully-revealed pile needs no hiding; a hidden draw pool needs an order that's never computed until the moment of drawing). Containment beyond `zoneId` is now `Hierarchy` (`src/events/hierarchy.ts`, Layer 2) — a named, standalone parent/child/sibling-order structure a game builds its own vocabulary on top of. See `games/cyberfixer/server/deck.ts` for the worked example: a small class wrapping a `Hierarchy`, giving that game's own "deck" concept a real home.

### Query expressions: `BoolExpr` / `NumExpr`

A `BoolExpr` (returns true/false) or `NumExpr` (returns a number) is data — an object tree, not a string, not a function — so it's safe to store in the event log, a rule table, or a fork. They're mutually recursive: a `NumExpr`'s `fold` (a `sum`/`count`/`avg`/`min`/`max` over every entity matching a condition) can appear inside a `BoolExpr`'s `compare`, and either can nest inside the other to arbitrary depth — including correlated aggregation ("for each fixer, count what they own, then sum those counts") via labeled folds (`as`/`ref`). Full grammar, evaluation model, and worked examples: **[`src/query/IR_SPEC.md`](src/query/IR_SPEC.md)**.

```ts
const legalTargets: BoolExpr = {
  op: "and",
  exprs: [{ op: "hasTag", tag: "contractor" }, { op: "not", expr: { op: "ownedBy", fixerId: "fixer-A" } }],
};
```

This grammar replaced an earlier `Query`/`Aggregate` split that could only reference each other in the one direction someone had explicitly wired up (a fold's condition could be a boolean check, but nothing let a boolean check reference a fold's result) — "a rule condition can't read an aggregate directly" used to be a real, documented limitation of this engine; it isn't anymore, and two different pieces of `games/cyberfixer` content had independently reinvented workarounds for it before the grammar was unified. See the spec for how.

### Modifiers (layered properties)

A property's *live* value is base + every active `Modifier` (add/multiply/set), applied in priority order — same-priority modifiers resolve in insertion order. `PropertyResolver` (`src/properties/property-resolver.ts`) is what actually resolves this; pass it anywhere a `BoolExpr`/`NumExpr` needs to see live, not raw, values.

`ModifierStore` cleans up after itself: it listens for `entity:removed` on its own bus and removes every modifier still targeting the removed entity, rather than leaving an orphaned modifier referencing a now-gone entity to accumulate forever (and get serialized into every future `Snapshot`). This is deliberately self-contained — `ModifierStore` wires its own cleanup by listening to the bus, rather than `EntityStore` reaching forward into a higher layer to do it for it.

### Actions: propose → validate → resolve → emit

An `ActionDefinition` (`src/actions/action-definition.ts`) declares: a category (for performer capability matching — `pref:`/`weak:` tags adjust cost), legal targets as a `BoolExpr` builder, an optional cost, optional `minTargets`/`maxTargets`, and a `timingCondition`. Every one of these — `category`, `performerCondition`, `cost`, `minTargets`, `maxTargets`, `timingCondition` — is a **function of the proposal** (`(ctx: ActionContext) => ...`), same shape as `targetQuery`, not a static value: legality (and cost, and arity) is almost always relative to the specific proposal being made, not a fixed fact about the action itself. `timingCondition` in particular replaces an earlier `requiresActiveTurn: boolean` — the engine has no built-in notion of "whose turn it is" (that's a tag a *game* defines, e.g. cyberfixer's own `active-turn` tag); omitting `timingCondition` means no timing restriction at all, and a reactive/instant-speed action is simply one whose `timingCondition` doesn't require active-turn — not a special engine concept, just a different `BoolExpr`.

```ts
const shakedown: ActionDefinition = {
  id: "shakedown",
  category: () => "coercion",
  targetsOwn: false,
  targetsOthers: true,
  minTargets: () => 1,
  maxTargets: () => 1,
  targetQuery: (ctx) => ({ op: "and", exprs: [
    { op: "hasTag", tag: "contractor" },
    { op: "not", expr: { op: "ownedBy", fixerId: ctx.actingFixerId } },
  ]}),
  performerCondition: () => ({ op: "hasTag", tag: "contractor" }),
  timingCondition: (ctx) => ({ op: "hasTag", tag: "active-turn", subject: ctx.actingFixerId }),
  cost: () => ({ prop: "outflow", amount: 4 }),
  effect: "shakedownEffect",
};
```

The effect itself is a registered function (`EffectHandlerRegistry`), never data — an action needs real code to actually do something, but *whether it's legal* is entirely data. Effect/rule/phase handlers all receive the same `ActionApi`: `{ entities, modifiers, resolver, random, randomFor? }` — `resolver` for reading live values, `random` (a `SeededRandom`) for any dice/randomness a game needs deterministically, and `randomFor(domain)` (optional — only present if the game registered a `RandomRegistry`) for a NAMED, isolated randomness stream, e.g. one player's own deck draws, kept structurally incapable of being perturbed by unrelated randomness elsewhere in the match.

**`activate` (`src/actions/activate.ts`): one generic action, many card-granted abilities.** Rather than registering a new bespoke `ActionDefinition` per ability, `buildActivateAction(abilities: AbilityRegistry)` builds ONE `ActionDefinition` — `id: "activate"` — that dispatches to whichever ability a proposal names via `ctx.params.abilityId`, looked up in an `AbilityRegistry` (which is literally just an `ActionRegistry` reused — an ability has the identical shape as a top-level action, just reached differently). A card *grants* an ability by carrying an `ability:<id>` tag, checked in `performerCondition` — a proposal claiming an ability the performer doesn't actually have is rejected the same way an illegal target already is, never trusted from the client. In cyberfixer, `shakedown` above is registered as an *ability*, not a top-level action; `content.actions.get("activate")` is what a client actually submits, with `params: { abilityId: "shakedown" }`. This is what lets a game add a new ability (a restore effect, a denial effect, whatever) as pure content — an `AbilityRegistry` entry plus a tag on the right cards — instead of a new engine concept each time one is designed.

**Interactive play: propose now, resolve later.** `proposeAction` and `resolveEffect` (`src/actions/pipeline.ts`) are deliberately separate calls, not always run back to back — a game with a shared response window (see `Stack`, below) proposes an action, pushes it onto the stack, and only calls `resolveEffect` once it's actually its turn to resolve. `PendingActionRegistry` (`src/actions/pending-action-registry.ts`) is the out-of-band bookkeeping this needs: `ActionContext`/`ActionDefinition` can't be stored as ordinary entity tags or properties, so this registry holds them, keyed by the same id `Stack` uses for the pending item. It's deliberately not queryable via `BoolExpr`/`NumExpr` — a card's own effects are content the query engine needs to see (as ordinary tags/properties on real entities), but this registry is pipeline plumbing only the room's own resolution step ever reads.

**`resolveEffect` re-validates immediately before running the handler, and can fizzle.** Legality isn't just checked once at proposal time and then trusted — `timingCondition`, `performerCondition`, and `targetQuery`/ownership for every target are re-evaluated fresh against *current* state right before the effect actually runs. If any of them no longer hold (a target lost the tag that made it legal, the performer itself stopped qualifying, the timing window closed), the action **fizzles**: the handler never runs, cost stays paid (it was already deducted at proposal time, and is never refunded), and an `action:fizzled` event fires — deliberately just an event, not a counter or any other stack-specific mechanism, so a game's own content decides what a fizzle means for it (log it, refund something extra, trigger a follow-up rule), not the engine. `resolveEffect` returns `{ fizzled, reason? }`; `performAction` (immediate propose-then-resolve, used by anything that doesn't need a response window) keeps its own return type unchanged, since a fizzle there is structurally rare and, when it happens, still observable via the event.

**No transaction guarantee, ever.** `resolveEffect` never wraps a handler in a try/catch, and nothing rolls back partial state — if a handler makes several mutations and then throws, every mutation before the throw is permanent, and cost is never refunded. An effect author who needs several mutations to succeed or fail together has to arrange that themselves; the engine provides no atomicity here at all.

### Rules: trigger + condition + effect

A `RuleBinding` (`src/rules/rule-binding.ts`) fires an effect when an event type occurs (`trigger`), optionally filtered by the event's own fields (`match`, plain code — for things a `BoolExpr` can't express, like `event.actionId === "activate"`) and/or by a `BoolExpr` against one entity the trigger names (`condition` + `subject`).

```ts
ruleTable.add({
  id: "check-defeat",
  trigger: "entity:propertyChanged",
  match: (event) => event.prop === "inflow",
  subject: (event) => event.entityId,
  condition: { op: "compare", left: { op: "prop", name: "inflow" }, cmp: "lte", right: { op: "lit", value: 0 } },
  effect: "markDefeated",
});
```

Rules chain naturally — one rule's effect can trigger another. `EventBus` guards against runaway cascades (`maxEmitDepth`, default 64) so a buggy rule fails with a clear error instead of a stack overflow.

### Phases & turn cycle

A `PhaseDefinition`'s `completionGate` is a `BoolExpr` — the *same* mechanism handles both a forced phase ("retire until outflow ≤ inflow") and a voluntary one (`ALWAYS_TRUE_QUERY`, exported from `src/phases/phase-definition.ts`). `TurnCycle` repeats a phase list once per seat in seating order; `Match` composes pregame → `TurnCycle` → postgame as three stages.

**Reactive priority.** `Stack` (`src/events/stack.ts`) is a tree, not a fixed-order chain: any pending item can be responded to by any other, and *which* leaf resolves next is a pluggable `NumExpr` scoring policy (`LIFO_POLICY`/`FIFO_POLICY` are just two instances of the same rule, not special cases) — with an unconditional `pushedAtSequence` tie-break for determinism no matter how a custom policy scores. `push`/`reparent`/`counter` can all be called on any currently-pending item, leaf or not — responding to something already buried under another response, seizing an opponent's own pending item as your own, and countering a non-leaf item (splicing every one of its own children up to its former parent) are all ordinary, supported operations, not edge cases the engine merely tolerates.

**`PriorityTracker` (`src/phases/priority-tracker.ts`) is a built, tested, generic APNAP pass-tracker — and `games/cyberfixer` does NOT actually use it.** It's available for a game whose priority needs real seating-order rotation (whose turn is it to act-or-pass, resetting to the active player whenever something new happens). `games/cyberfixer`'s own interactive main phase turned out to need something simpler: with exactly two fixers and no rotation requirement at all ("either fixer may pass or respond at any moment, in any order"), it's real content instead — a `passed-priority` tag per fixer, reset by a rule bound to *all four* of `Stack`'s primary mutation events (`stack:pushed`/`stack:resolved`/`stack:countered`/`stack:reparented`). Binding only to the "exposed" variants of those events was tried first and found to be a real bug: a standalone root resolving exposes nothing downstream, so those events never fire, and priority silently never resets. This is deliberately not baked into `Stack` or `PhaseDefinition` as a "resolution mode" — a room picks `PriorityTracker`, a simpler tag scheme, or something else entirely, based on what its own phases actually need.

**The propose-now-resolve-later flow, concretely, as `games/cyberfixer/server/room.ts` actually builds it:** an "action" message during main phase calls `proposeAction`, and if legal, pushes the new pending item onto the shared stack and records it in `PendingActionRegistry` — `respondingTo` (an optional field on the client's own intent) is validated against what's *actually* currently pending, never trusted from a stale client render. A "pass" message tags that fixer; once every fixer's tag is set, `Stack.resolveNext` picks the next item, `resolveEffect` runs it (fizzle included), and both the registry entry and the placeholder pending-item entity are cleaned up regardless of whether it resolved or fizzled. A maintained `has-active-response` tag (kept in sync by a rule bound to `hierarchy:parentChanged`, not `stack:pushed`/`stack:reparented` directly — the latter two miss a non-leaf `counter()`'s own splice step entirely) lets a card's own `targetQuery` ask "is anything currently responding to this" as an ordinary `hasTag` check, the same way `active-turn`/`phase:main` already work.

### Persistence, determinism, and forking

`EventLog` records **commands** (proposed actions, phase advances), not every low-level mutation — replay re-runs the same pipeline against the same starting state, which reconstructs everything else (rule cascades included) for free. `SeededRandom` (`src/persistence/seeded-random.ts`) is the *only* legal source of randomness in game logic; `rollDice(random, sides, count)` is built on it.

A single shared `SeededRandom` is fine for most randomness, but not for anything that needs to be structurally incapable of being perturbed by unrelated activity elsewhere in the match (e.g. one player's own hidden deck draws) — `deriveSeed(masterSeed, domain)` deterministically derives an independent, isolated stream per named domain from the one match seed, and `RandomRegistry` resolves them by name (never an implicit fallback — every caller must be explicit about which domain it means). Both trace back to the same master seed, so forking still needs only one new seed; every derived stream re-derives automatically.

`Snapshot` (`src/persistence/snapshot.ts`) captures entities, modifiers, every named `Hierarchy` a game registers, every named `Stack` (its own `sequenceCounter`/pending-set bookkeeping — the tree shape itself is already covered by its underlying `Hierarchy`), and every currently-pending proposal a game's `PendingActionRegistry` is tracking — five things, not two; a snapshot that captured entities/modifiers but silently dropped `Hierarchy` state (e.g. a deck's undrawn pool) shipped briefly during this engine's own development and was caught and fixed, and so did one that restored `Stack`/`Hierarchy` state correctly but left a proposed-but-unresolved action with no record of which action it even was (`PendingAction.definition` is a live object with function fields — it can't be serialized directly, so `loadRaw` re-derives it via a caller-supplied `actionId` lookup instead). `hierarchies`/`stacks` are required parameters on `createSnapshot`/`restoreSnapshot`, not optional-with-an-empty-default, specifically so omitting one is a visible, conscious choice rather than an easy accident; `pendingActionRegistry` is `PendingActionRegistry | null` instead, since — unlike `Hierarchy`/`Stack` — a game may have no such registry at all, and `null` states that explicitly rather than standing in for "forgot to pass it." Restoring runs a real integrity check too: every restored pending action is cross-checked against every restored `Stack`, and a mismatch (the two having drifted out of sync somehow) throws immediately rather than surfacing confusingly the first time that item tries to resolve.

`SnapshotHistory` (`src/persistence/snapshot-history.ts`) is a prototype, not yet wired into any real game's live match: it retains an explicit, bounded (or, on purpose, unbounded) history of snapshots over time, and `evaluatePastBoolExpr`/`evaluatePastNumExpr` let the *exact same* query grammar be evaluated against a frozen prior moment instead of the present — reconstructed into completely fresh, throwaway stores that never touch live state and fire no events. This doesn't violate the engine's own "query pure, current state" discipline — the interpreter itself never becomes temporally aware, it's simply handed a different, still perfectly ordinary `QueryContext`. It's also deliberately the *second* choice for "what changed": the cheaper, already-established pattern (a rule stamps a moment into state once, the query layer reads it forever after as an ordinary present-tense fact) should be preferred whenever a card's author can anticipate in advance which moment will matter; this is for the rarer case where they can't.

`games/cyberfixer/server/room.ts` wires all of this into a real, running room: every confirmed action/phaseAdvance is logged (`performActionAndLog`/`advancePhaseAndLog`), and a `Snapshot` is taken every few confirmed commands. **What this doesn't yet do:** the log/snapshots live in memory only — if the server process itself crashes, they're gone too. This makes a match's history genuinely replayable/forkable *within* the running process, but surviving a process restart needs the log/snapshots written somewhere durable (disk, a database) — a real, separate decision this project hasn't made yet, deliberately not picked unilaterally.

Forking (`src/forking/`) is copy-on-write: a fork references its parent's log rather than copying it, and gets its **own fresh seed** (`randomSeed()`, generated once at fork-propose time) — never the parent's, or every post-fork "random" outcome would be predictable from having watched the parent's timeline.

### Networking (Layer 9)

- **Schema mirroring** (`network/schema.ts`) — Colyseus `@colyseus/schema` classes mirroring `core/entity.ts`'s shapes.
- **Visibility filtering** (`network/visibility.ts`) — a zone's `public`/`owner-only`/`hidden` setting decides who can see what's inside it, enforced via Colyseus's `StateView` (a field tagged `.view()` is invisible per-client by default until explicitly added). **Known limitation:** this doesn't cascade through nested zones — a public zone inside a hidden one is currently still visible; see the comment in `visibility.ts`.
- **Intent validation** (`network/intent.ts`) — the write-side counterpart to visibility: a submitted action's acting fixer is *never* taken from the client, and `validateActiveTurn` gates both phase-advance and (if you wire it in, as `games/cyberfixer` does) action submission by whose turn it actually is.
- **The sync loop** (`network/sync-manager.ts`) — subscribes once to the event bus and keeps Colyseus room state (and per-client visibility) live, automatically.

## Building a game: a walkthrough

Every game lives in its own folder under `games/`, self-contained. `games/cyberfixer/` is the reference example — copy its shape for a new game.

```
games/<your-game>/
  game.config.ts          # { name, displayName, seatOrder }
  server/
    content.ts             # ActionDefinitions, effect handlers, RuleBindings
    setup.ts                # builds starting entities for a new match
    room.ts                 # composes it all onto TableRoom (default export)
  client/
    index.html
    main.js                 # loads /vendor/colyseus.js, connects, plays
```

**1. `game.config.ts`** — the one file the root server's discovery reads. `name` becomes *both* the Colyseus room name clients join under and the URL path your client assets are served at (`/games/<name>`) — one name, two addressing schemes, never configured twice.

**2. `server/content.ts`** — your game's actual rules: `ActionDefinition`s, their effect handlers, and `RuleBinding`s for anything reactive (defeat conditions, chain effects, whatever your game needs). This is pure Layer 4/5 content — no networking code here.

**3. `server/setup.ts`** — one function, `setupMatch(entities, seatOrder)`, that populates a fresh `EntityStore` with your starting board.

**4. `server/room.ts`** — a class extending `TableRoom` (`src/network/table-room.ts`), default-exported. Its `onCreate` wires an `EntityStore`/`ModifierStore`/`PropertyResolver`, your content's `RuleEngine`, a `SyncManager` (**wire this before calling `setupMatch`** — see the comment in `games/cyberfixer/server/room.ts`; getting this order wrong means initial entities never reach any client, a real bug this project hit and fixed), a `TurnCycle` wrapped in a `Match` (pregame → playing → postgame — drive stage transitions through `Match.tryAdvance()`, not `TurnCycle` directly, or a pregame lobby has nothing to gate on), and `onMessage` handlers for whatever your client sends (validate via `network/intent.ts`, then call `performAction`/`match.tryAdvance`). `TableRoom` itself already gives every game a `"chat"` message handled for free (broadcast-only, not persisted) — nothing to wire up for that one.

**5. `client/`** — plain HTML/JS, no build step. Load `/vendor/colyseus.js` (the shared `@colyseus/sdk` browser bundle, served by the root server for every game) then connect:

```js
const client = new Colyseus.Client(`ws://${location.host}`);
const room = await client.joinOrCreate("your-game-name", { identity });
room.onStateChange((state) => { /* render whatever this client is allowed to see */ });
room.send("action", { actionId: "...", performerId: "...", targetIds: [...] });
```

Whose turn it is, what's clickable, etc. should come from **already-synced entity data** (e.g. a tag on the active player's own entity), never guessed or inferred client-side — see how `games/cyberfixer/client/main.js` reads the `active-turn` tag rather than reconstructing turn order itself.

**6. Register it** — nothing to do. `server/discover-games.ts` scans `games/*/` for a `game.config.ts` + `server/room.ts` pair at boot; drop a new folder in and restart the server.

### A framework SDK for the client, not just plain JS

`games/cyberfixer/client-solid/` is a real, separate package (own `package.json`/`node_modules`/build) proving a specific claim: the client doesn't have to be hand-rolled DOM manipulation, and it doesn't have to be locked to one framework either. It's built in two deliberate layers —

- **`src/sdk/`** — framework-agnostic. `ClientWorld` (`entity-view.ts`) implements the SERVER's own `QueryContext` over the live synced state, which means the shared, pure query evaluator (`evaluateBoolExpr`/`selectEntities`) can run **client-side**, unmodified — e.g. computing legal targets instantly, with zero round-trip, while the server stays the only authority that actually matters. `toEntityView` converts a synced schema instance into a genuine `Entity` value (not just something structurally similar), proven directly by a unit test that runs the real shared evaluator against a converted entity. `connection.ts`/`actions.ts` are typed connect/join/action/chat helpers reusing the server's own wire-shape types (`RawActionIntent`, `ChatMessage`, `ActionResult`) directly — "share the types" means literally importing them, not re-declaring similar-looking ones.
- **`src/solid/`** — the *only* Solid-specific code in the whole chain. `use-world.ts` turns `ClientWorld`'s entity-level change notifications into Solid's own fine-grained store reactivity with one targeted per-entity update; a React (or any other) adapter would do the analogous thing against the exact same `ClientWorld`, untouched.

`App.tsx` is a real, working slice of the actual game (draft → ready through the lobby → reactive board → shakedown → end turn) — deliberately not full feature parity with `main.js` yet (no deploy/hand/chat UI), a straightforward next increment since the SDK primitives it'd need already exist.

**What's actually been verified, stated precisely:** a clean typecheck, a clean `vite build`, and unit tests for `toEntityView`'s conversion logic (framework-agnostic, run under the package's own `vitest`, deliberately excluded from the root project's own test/typecheck scope — see `tsconfig.json`/`vitest.config.ts`'s `client-solid` excludes, since it's a genuinely separate package with its own dependency tree). It has **not** been exercised against a live server in a real browser in this environment — that's a real, different, higher bar than "it builds and the pure logic is tested," and it's worth being honest that it hasn't been cleared yet.

## Testing your game

Reuse the patterns already in this repo:

- **Pure content tests** (`games/cyberfixer/server/content.test.ts`) — build entities/actions/rules directly, no Colyseus at all, and assert on the resulting state. Fastest, and where most of your logic should be provable.
- **Real room tests** (`server/server-bootstrap.test.ts`) — `@colyseus/testing`'s `boot()` gives you an in-process server (no real sockets) where you can `createRoom`/`connectTo` real clients and drive a full game end-to-end, including asserting on what each client's *synced* state actually contains (the only way to prove visibility filtering really works, not just that the logic looks right).

## Known limitations (stated plainly, not hidden)

- Zone visibility doesn't cascade through nesting.
- Visibility is entity-level and all-or-nothing — "5 cards in hand, contents hidden" (visible count, hidden identity) isn't supported.
- `EventBus`'s cascade guard (`maxEmitDepth`) is a fixed default (64) unless a game explicitly overrides it in its own bus construction.
- One `Hierarchy` graph per name, applied under as many names as a game needs — there's no built-in composition for an entity needing several genuinely nested structures beyond that; flat multi-membership (not nesting) should use tags instead. See `src/query/IR_SPEC.md` §7.
- `Stack`'s resolution policy (which pending item resolves next) is a fixed constant per game (`games/cyberfixer` hardcodes `LIFO_POLICY`) — there's no mutable, per-match slot a card's own effect can overwrite for the rest of a turn. A deliberate, confirmed stub, not an oversight; the shape of the eventual fix (a small registry, similar to `PendingActionRegistry`, holding "the currently active policy") is sketched but not built.
- `childOf`/`descendantOf` only ever check whether the *candidate being evaluated* descends from a known reference point — never the reverse ("does anything currently descend from me"). Expressing the reverse needs a fold whose `where` clause can reference the outer candidate as a label, and nothing automatically binds the ambient subject to one; attempting it throws the interpreter's own "unbound label" error, confirmed directly rather than assumed. Anything that needs the reverse direction today has to externalize it as a maintained tag instead (see `has-active-response`, above) — a real, working pattern, just not something the grammar itself expresses natively yet.

## Project layout

```
src/            the engine (Layers 0-9) — reusable across any game
games/          one folder per game, self-contained
server/         the multi-game HTTP/WS host (discovery + static + matchmaking)
```
