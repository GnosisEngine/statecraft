/**
 * Layer 5 — RuleTable.
 *
 * Holds bindings and answers "what fires for this trigger, in what order."
 * `id`/`version` exist now specifically for Layer 8 (forking): a fork
 * inherits its parent's rule table by referencing the same bindings, and
 * clone() is the copy-on-write step — the fork gets its own RuleTable
 * identity it can diverge (add/remove bindings) without ever mutating the
 * parent's.
 */

import type { GameEventType } from "../events/types.ts";
import type { RuleBinding } from "./rule-binding.ts";

export class RuleTable {
  readonly id: string;
  version: number;
  private bindings: RuleBinding[] = [];

  constructor(id: string, version = 1) {
    this.id = id;
    this.version = version;
  }

  add<T extends GameEventType>(binding: RuleBinding<T>): void {
    // Type-erasure boundary: safe because RuleEngine only ever invokes
    // match/subject for events whose type already equals binding.trigger.
    this.bindings.push(binding as unknown as RuleBinding<GameEventType>);
  }

  remove(bindingId: string): void {
    this.bindings = this.bindings.filter((b) => b.id !== bindingId);
  }

  getForTrigger(trigger: GameEventType): RuleBinding<GameEventType>[] {
    return this.bindings
      .filter((b) => b.trigger === trigger)
      .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
  }

  get size(): number {
    return this.bindings.length;
  }

  /** Copy-on-write for fork divergence: same bindings, new table identity. */
  clone(newId: string): RuleTable {
    const copy = new RuleTable(newId, this.version);
    copy.bindings = [...this.bindings];
    return copy;
  }
}
