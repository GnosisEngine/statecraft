/**
 * Layer 7 — RandomRegistry.
 *
 * Holds independent, isolated randomness streams by domain name (e.g.
 * "fixer-A:deck") — same resolve-by-name-through-a-registry shape as
 * QueryFunctionRegistry/HierarchyRegistry, deliberately: it's the same
 * kind of decision (which named, game-registered thing does this
 * request mean) even though this registry backs ActionApi rather than
 * QueryContext.
 *
 * Unlike HierarchyRegistry, there's no "omit the name, assume the only
 * one registered" convenience — the entire point of a domain-isolated
 * stream is that callers are explicit about which one they mean, always.
 * An implicit default here would silently reintroduce the exact
 * cross-domain coupling this exists to prevent.
 */

import type { SeededRandom } from "./seeded-random.ts";

export class RandomRegistry {
  private streams = new Map<string, SeededRandom>();

  register(domain: string, random: SeededRandom): void {
    this.streams.set(domain, random);
  }

  get(domain: string): SeededRandom | undefined {
    return this.streams.get(domain);
  }
}

/**
 * Builds the ActionApi.randomFor implementation from a registry — shared
 * by the three places that construct an ActionApi-shaped object
 * (pipeline.ts, rule-engine.ts, phase-runner.ts) so the throw-on-missing
 * behavior can't drift between them. Returns undefined (not a function
 * that always throws) when no registry was supplied at all, so
 * ActionApi.randomFor's own optionality still means "this game never
 * registered domain-specific streams," distinguishable from "this
 * specific domain wasn't registered."
 */
export function makeRandomFor(registry: RandomRegistry | undefined): ((domain: string) => SeededRandom) | undefined {
  if (!registry) return undefined;
  return (domain: string): SeededRandom => {
    const stream = registry.get(domain);
    if (!stream) {
      throw new Error(`randomFor: no random stream registered for domain "${domain}" — register it before any handler can be called with it.`);
    }
    return stream;
  };
}
