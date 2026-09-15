/**
 * Layer 0 — namespaced tags.
 *
 * A recurring, informal convention across games built on this engine:
 * a tag of the shape `"<namespace>:<id>"` — `ability:shakedown`,
 * `faction:corporations`, `phase:main`, `pref:coercion`. Nothing about
 * `Entity.tags` (a plain `Set<string>`) enforces or even recognizes this
 * shape; it's purely a naming discipline content authors have converged
 * on independently, which means it was previously pure string
 * concatenation, scattered across every game's own content — no
 * canonical generator, no single place a typo could be caught, and no
 * way to grep for "every place that constructs an ability tag" by
 * function name rather than by string pattern.
 *
 * `namespacedTag` is deliberately the ONLY thing this file provides —
 * a single, trivial helper, not a typed registry or a closed set of
 * namespaces. A game builds its own specific wrappers on top of this
 * (e.g. `abilityTag(id) => namespacedTag("ability", id)`) rather than
 * this file trying to know what namespaces any given game will want,
 * the same reason `bidAwarePolicy(amountProp)` takes its property name
 * as a parameter instead of assuming one.
 */

export function namespacedTag(namespace: string, id: string): string {
  return `${namespace}:${id}`;
}
