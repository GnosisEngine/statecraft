/**
 * Layer 5 — rule effect handlers.
 *
 * Deliberately reuses Layer 4's ActionApi ({entities, modifiers}) rather
 * than inventing a parallel shape — a rule effect and an action effect
 * both just need to mutate state through the same two stores, so there's
 * nothing rule-specific about the mutation surface, only about what
 * triggers it.
 */

import type { ActionApi } from "../actions/effect-handler.ts";
import type { GameEvent } from "../events/types.ts";

export type RuleHandler = (event: GameEvent, api: ActionApi) => void;

export class RuleHandlerRegistry {
  private handlers = new Map<string, RuleHandler>();

  register(name: string, handler: RuleHandler): void {
    this.handlers.set(name, handler);
  }

  get(name: string): RuleHandler | undefined {
    return this.handlers.get(name);
  }
}
