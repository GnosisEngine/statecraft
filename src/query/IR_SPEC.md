# Query IR Specification

This is the canonical reference for the engine's query intermediate
representation (IR) — `BoolExpr` and `NumExpr`. If a DSL ever gets built
on top of this engine, this document (not any one source file's header
comment) is the complete target language a compiler for it would need to
emit. The actual enforced shape lives in `src/query/types.ts`; this
document is a readable companion to that file, not a replacement for it
— when the two disagree, `types.ts` is right and this file is stale and
needs fixing.

## 1. Scope

This spec covers exactly two things: **gathering/selecting entities**
and **evaluating boolean or numeric expressions against them**. It does
**not** cover mutating state.

That split is deliberate, not incidental. `ActionDefinition` effect
handlers, `RuleBinding` effects, and phase handlers are — and are meant
to stay — plain TypeScript functions in a game's own server code, never
data evaluated by this IR. If a future DSL exists, it produces `BoolExpr`
values (for legal-target queries, rule conditions, phase completion
gates) and `NumExpr` values (for costs, computed thresholds, whatever a
game needs a number for) — it never produces "what happens when this
resolves." State changes stay exclusively behind game-specific code
using the raw entity/modifier/hierarchy mutation API. This is a
considered boundary, not a placeholder for a future expansion: making
mutation a DSL concern would mean a DSL program could corrupt state in
ways this IR's whole design (pure data, structurally analyzable,
side-effect-free) exists to prevent.

## 2. Design principles

**Pure data, no `eval`, no parser.** A `BoolExpr` or `NumExpr` value *is*
its own parsed form — there is no string form to parse in the first
place. This is what makes every one of these values safe to put in the
event log, a rule table, or a forked branch: logging a `BoolExpr` is
logging plain JSON, not logging code.

**One grammar, not two.** Earlier in this engine's life, boolean checks
(`Query`) and numeric folds (`Aggregate`) were separate types that could
only reference each other in the two directions someone had explicitly
wired up — a fold's `where` was always a boolean check, but nothing let
a boolean check reference a fold's result. That split was retired
outright. `BoolExpr` and `NumExpr` are mutually recursive: a `NumExpr`'s
`fold` case can appear inside a `BoolExpr`'s `compare`, and vice versa,
to arbitrary depth. Section 5 works through why this needed a genuinely
new evaluation mechanism, not just a type-level merge.

**Everything evaluates against an explicit, mutable "current subject."**
Every node is evaluated with a `subjectId` (which entity is "this one,"
right now) and a `LabelScope` (which named folds have bound which
entities so far). A bare `prop`/`hasTag`/`kindIs` with no `subject` field
reads the ambient one; `ref` reads through the label scope instead. This
single mechanism is *the* thing that makes free recursion between the
two types possible — see Section 5.

**Two escape hatches, both name-resolved through a registry.** Query
deliberately can't do arbitrary computation or graph traversal — `call`
(arbitrary code, via `QueryFunction`) and `childOf`/`descendantOf`
(hierarchy traversal, via `HierarchyRegistry`) are the two sanctioned
ways to reach outside pure data. Both resolve a name through a registry
at evaluation time, and — critically — the registry must also be
available at *dependency-extraction* time (Section 6), or extraction
throws rather than silently under-reporting.

**Loud failure over silent incorrectness, everywhere.** An unbound
`ref`, an unregistered `call` function, an ambiguous or unregistered
hierarchy name — every one of these throws immediately, with a specific
message, rather than resolving to `false`/`0`/`undefined` and producing
a wrong answer no one notices. This is stated once here as a
cross-cutting rule; it is not re-derived per op below.

## 3. Grammar

```ts
type CompareOp = "gt" | "lt" | "gte" | "lte" | "eq";
type AggregateOp = "sum" | "count" | "avg" | "min" | "max";

/** Either a literal entity id, or a reference to whatever entity a
 * labeled fold currently has bound. */
type EntityRef = EntityId | { op: "ref"; label: string };

type NumExpr =
  | { op: "lit"; value: number }
  | { op: "prop"; name: string; subject?: EntityRef }
  | { op: "add" | "sub" | "mul" | "div"; left: NumExpr; right: NumExpr }
  | { op: "fold"; fold: AggregateOp; as?: string; of?: NumExpr; where: BoolExpr };

type BoolExpr =
  | { op: "and" | "or"; exprs: BoolExpr[] }
  | { op: "not"; expr: BoolExpr }
  | { op: "hasTag"; tag: string; subject?: EntityRef }
  | { op: "kindIs"; kind: EntityKind; subject?: EntityRef }
  | { op: "inZone"; zoneId: EntityRef }
  | { op: "ownedBy"; fixerId: EntityRef }
  | { op: "withinDistance"; of: EntityRef; maxDistance: number; metric?: DistanceMetric }
  | { op: "call"; fn: string; args?: Record<string, unknown> }
  | { op: "compare"; left: NumExpr; right: NumExpr; cmp: CompareOp }
  | { op: "childOf"; parent: EntityRef; hierarchy?: string }
  | { op: "descendantOf"; ancestor: EntityRef; hierarchy?: string; maxDepth?: number };
```

### 3.1 `NumExpr` ops

| op | reads | notes |
|---|---|---|
| `lit` | nothing | a literal number |
| `prop` | `subject`'s `name` property | `subject` omitted = ambient subject |
| `add`/`sub`/`mul`/`div` | `left`, `right` | ordinary arithmetic; both operands are full `NumExpr`s, so either side can itself be a `fold`, `compare`... anything |
| `fold` | every entity matching `where` | see 3.3 |

`prop`'s value, at evaluation time, comes from `QueryContext.getProperty`
— for a raw `EntityStore`-backed context this is the stored base value;
for a `PropertyResolver`-backed context it's the fully modifier-resolved
*live* value (see the engine's Layer 3). The IR itself has no opinion
about which — it just calls `getProperty` and uses what comes back. A
missing/never-set property resolves to `0`, not an error.

### 3.2 `BoolExpr` ops

| op | reads | notes |
|---|---|---|
| `and`/`or` | `exprs` | `and` of an empty array is vacuously `true` (used for "always allowed to proceed" gates) |
| `not` | `expr` | |
| `hasTag` | `subject`'s tags | `subject` omitted = ambient subject |
| `kindIs` | `subject`'s kind | `subject` omitted = ambient subject |
| `inZone` | ambient subject's `zoneId`, compared to `zoneId` | always checks the AMBIENT subject — there is no `subject` field here, only the target zone to compare against |
| `ownedBy` | ambient subject's ownership stack top, compared to `fixerId` | same as above — no separate subject slot |
| `withinDistance` | ambient subject's position vs. `of`'s position | `of` is the *other* point; the ambient subject is always the "from" side — this is a two-point relation, not a one-entity check, so only one side needed a slot |
| `call` | whatever the named `QueryFunction` reads | see Section 7 |
| `compare` | `left`, `right` (both `NumExpr`) | this is what lets a fold's numeric result be tested as a condition |
| `childOf` | ambient subject's position in the named hierarchy | one hop only |
| `descendantOf` | ambient subject's ancestor chain in the named hierarchy | arbitrary depth, cycle-guarded (see Section 7) |

### 3.3 `fold`, precisely

```ts
{ op: "fold", fold: AggregateOp, as?: string, of?: NumExpr, where: BoolExpr }
```

Evaluating a fold:

1. Every entity in the world is tested against `where`, each one AS ITS
   OWN AMBIENT SUBJECT (not the fold's own enclosing subject). The
   matching set is the fold's domain.
2. If `fold` is `"count"`, the answer is the size of that set — `of` is
   never evaluated and may be omitted.
3. Otherwise, for each match, `of` is evaluated with that match bound as
   the ambient subject — and, if `as` is given, also bound under that
   label (merged over any labels already in scope; see Section 5 on
   shadowing).
4. The per-match `of` values are combined: `sum` adds them, `avg`
   averages them (`0` if the set is empty, not `NaN`), `min`/`max` take
   the extremum (`0` if empty, not `±Infinity`).

`of` is required for every `fold` op except `"count"`.

## 4. `DepKey` and dependency extraction

```ts
type DepKey = `tag:${string}` | `prop:${string}` | `hierarchy:${string}` | "zone" | "owner";
```

A `DepKey` names one *kind* of change that could affect an expression's
result. `extractBoolExprDependencies`/`extractNumExprDependencies` walk
an expression **structurally** — no entities involved at all — and
return the set of `DepKey`s a subscriber needs to watch. This has to be
computable before any relevant entity necessarily exists (an aggregate
over zero current matches must still report its true dependencies, not
an empty set just because nothing matches yet).

**Precision policy.** `tag:${name}` and `prop:${name}` are exact — "did
tag X change" / "did property Y change." `zone`, `owner`, and
`hierarchy:${name}` are deliberately coarse — "did ANY zone membership
change," "did ANY ownership change," "did ANY parent link in this
hierarchy change" — not narrowed to a specific entity or edge. This is a
real precision/complexity tradeoff, made deliberately: tracking per-zone
or per-entity dependency sets would be more precise but meaningfully
more complex, and nothing so far has needed that precision. `ref` never
gets its own `DepKey` variant, for a related reason: a dependency key
never named a *specific entity* to begin with (that's what the
zone/owner/hierarchy coarseness already establishes), so "which entity a
`ref` happens to resolve to at runtime" was never something the
dependency system tracked — resolving through a `ref` changes what gets
read, never what a subscriber needs to watch for.

**Extraction needs the same registries evaluation does.** A `call`
node's dependencies come from the named `QueryFunction`'s own
`dependencies()` method — extraction throws if the function isn't found
in the `QueryFunctionRegistry` passed in. A `childOf`/`descendantOf`
node's dependency (`hierarchy:${name}`) requires the named hierarchy to
resolve through the same `HierarchyRegistry` passed to extraction. Pass
the wrong (or no) registry to extraction and it throws immediately,
rather than silently reporting an incomplete dependency set that would
cause a real subscriber to miss a real change later.

## 5. The subject/label-scope evaluation model

This is the part of the IR that actually does the work of making
`BoolExpr`/`NumExpr` mutually recursive — read this section carefully
before writing an evaluator or a compiler that targets one.

Every evaluation call carries two things: a `subjectId` (the entity
"this" currently refers to) and a `LabelScope` (`ReadonlyMap<string,
EntityId>` — which named folds have bound which entity, so far). A bare
`prop`, `hasTag`, or `kindIs` with no `subject` field reads off the
ambient `subjectId`. An `EntityRef` that's `{ op: "ref", label }`
resolves by looking `label` up in the current `LabelScope` — and throws
if it isn't there.

**Where the ambient subject changes.** Outside any fold, the ambient
subject is whatever the top-level caller passed in (e.g. the entity a
rule's `condition` is being checked against). Inside a fold, there are
two different ambient subjects at two different points:

- Evaluating `where` (deciding which entities match): each *candidate*
  entity is its own ambient subject, one at a time — this is a plain
  iteration over every entity in the world, each tested independently.
  The labels in scope during this step are whatever was already bound
  by an ENCLOSING fold — the fold's own `as` label is **not** yet bound,
  because there is no single matched entity yet to bind it to.
  Referencing a fold's own label inside its own `where` is circular
  (deciding matches based on a match that hasn't been decided) and will
  throw.
- Evaluating `of` (computing the per-match value): each *matched*
  entity becomes the ambient subject, one at a time. If the fold has an
  `as` label, that label is now bound to the current match — merged
  over the labels already in scope, not replacing them. A nested fold's
  `of` therefore sees every label bound by every fold enclosing it, plus
  its own.

**Shadowing.** If a nested fold reuses an `as` label already in scope,
the inner binding shadows the outer one — but *only* within that inner
fold's own `of` subtree. The inner fold's own `where` still sees the
OUTER value for that label (its own binding doesn't exist until a match
is chosen), which is what makes the correlation in the worked example
below actually work.

### Worked example: correlated aggregation (`SUM(COUNT(...))`)

"For each fixer, count what they own, then sum those counts" —
expressible directly as data, with no special "grouped aggregate"
primitive:

```json
{
  "op": "fold", "fold": "sum", "as": "f",
  "where": { "op": "hasTag", "tag": "fixer" },
  "of": {
    "op": "fold", "fold": "count",
    "where": {
      "op": "and",
      "exprs": [
        { "op": "hasTag", "tag": "contractor" },
        { "op": "ownedBy", "fixerId": { "op": "ref", "label": "f" } }
      ]
    }
  }
}
```

Walking through it: the outer fold iterates every entity tagged
`"fixer"`. For each one, `as: "f"` binds it, and the inner fold runs with
that binding in scope — its own `where` checks `ownedBy: ref("f")`,
correctly reaching back to whichever fixer the outer fold is currently
on, because the inner fold's `where` sees labels from its ENCLOSING
scope even though it can't see its own (it has none — `count` needs no
`of`). The inner fold's result (how many contractors that one fixer
owns) becomes one term in the outer `sum`.

Before this mechanism existed, expressing "an aggregate whose condition
depends on an aggregate" required manually denormalizing the inner
count onto a plain property and having the outer fold read that
property instead — a real, felt gap that two different pieces of
`games/cyberfixer` content independently reinvented workarounds for
before this grammar existed. Neither workaround is needed anymore.

## 6. Determinism

Every `BoolExpr`/`NumExpr` evaluation is a pure function of (the
expression, the current world state, the label scope) — no randomness,
no wall-clock reads, no iteration-order dependence on insertion timing
(`Map`/`Set` iteration in this engine is insertion-ordered, which is
relied on). This means replaying a logged sequence of commands through
the same expressions reproduces identical results, which is exactly what
this engine's persistence/forking layers depend on. The IR itself never
touches `SeededRandom` — anything genuinely random (which card gets
drawn from an unordered pool, a dice roll) happens in game *effect*
code, outside this grammar entirely, specifically so query evaluation
stays a pure function with no seed to thread through it.

## 7. The two sanctioned escape hatches

**`call` — arbitrary code, via `QueryFunction`.**

```ts
interface QueryFunction {
  evaluate(subjectId: EntityId, ctx: QueryContext, args?: Record<string, unknown>): boolean;
  dependencies(args?: Record<string, unknown>): DepKey[];
}
```

Registered by name in a `QueryFunctionRegistry`, resolved via
`ctx.getQueryFunction`. Exists for the rare case that genuinely needs
real computation this grammar deliberately doesn't provide — e.g. "has
this card been in the discard pile for at least N turns," which needs a
value derived from something the grammar can't reach directly (a stored
turn number compared against the live current one), not just arithmetic
between two properties on the same entity. The discipline required of
anyone registering one: `dependencies()` must accurately report
everything `evaluate()` reads, or a subscriber built on it will silently
miss real changes — this is the same responsibility `RuleBinding`
authors already have for `subject`/`condition`, just enforced at the
function-registration boundary instead.

**`childOf`/`descendantOf` — hierarchy traversal, via
`HierarchyRegistry`.**

```ts
interface HierarchyLookup {
  readonly name: string;
  getParent(childId: EntityId): EntityId | null | undefined;
  isDescendantOf(childId: EntityId, ancestorId: EntityId, maxDepth?: number): boolean;
}
type HierarchyResolution = { ok: true; hierarchy: HierarchyLookup } | { ok: false; reason: string };
```

A `Hierarchy` (the mutable implementation lives at Layer 2,
`src/events/hierarchy.ts`) is a named, standalone parent/child/sibling-
order structure — never a field on `Entity`, so the same entity can
participate in several independent hierarchies without tracking which
ones itself. `HierarchyRegistry.resolve(name?)` is the single place the
omitted-name ambiguity rule lives: omit `hierarchy` and there's exactly
one registered, that one is used; omit it with zero or multiple
registered, resolution fails with a specific reason. Both
`evaluateBoolExpr` and dependency extraction call this same method, so
they can never disagree about what counts as ambiguous.

`isDescendantOf` walks the parent chain with a visited-set and throws
immediately if it revisits a node (a genuine cycle — A's parent is B,
B's parent is A, however indirectly) rather than silently returning
`false` only once an arbitrary depth limit happens to be exhausted.
Running past `maxDepth` on a long but genuinely acyclic chain returns
`false`, not a throw — that's an ordinary bounded-search outcome, not a
bug.

This engine deliberately keeps to **one** hierarchy graph *concept*
(applied under as many separate names as a game needs) rather than
building a more general multi-hierarchy composition system. A game
wanting flat, non-nested multi-membership (e.g. "which squad is this
unit in") should reach for tags instead of a second parent/child tree —
tags give real grouping; a second genuinely nested structure is what
`Hierarchy` itself is for. `inZone`/`zoneId` — the engine-native
placement mechanism Layer 9's visibility computation reads — is a
deliberately separate, untouched mechanism, not unified with
`Hierarchy`, specifically so nothing about generalizing hierarchies puts
the already-working visibility system at risk.

## 8. What this spec does not cover

- `ActionDefinition`, effect handlers, `RuleBinding` effects, phase
  handlers — all plain TypeScript, all outside this IR by design (see
  Section 1).
- `PropertyBoundsRegistry` (Layer 3) — a static/dynamic min/max clamp
  applied when a `PropertyResolver`-backed context resolves a property's
  *live* value. It affects what `prop` reads in practice, but it isn't
  part of the IR's own grammar or evaluation rules — from this
  document's point of view, `prop` just calls `getProperty` and uses
  whatever comes back.
- Network/sync/visibility (Layer 9) — entirely separate from query
  evaluation; a `BoolExpr`/`NumExpr` has no notion of "who can see this."
