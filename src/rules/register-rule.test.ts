import { describe, expect, it } from "vitest";
import { createCard } from "../core/entity.ts";
import { EventBus } from "../events/bus.ts";
import { EntityStore } from "../events/entity-store.ts";
import { ModifierStore } from "../properties/modifier-store.ts";
import { PropertyResolver } from "../properties/property-resolver.ts";
import { RuleTable } from "./rule-table.ts";
import { RuleHandlerRegistry } from "./rule-handler.ts";
import { RuleEngine } from "./rule-engine.ts";
import { SeededRandom } from "../persistence/seeded-random.ts";
import { registerRule } from "./register-rule.ts";

function makeRig() {
  const bus = new EventBus();
  const entities = new EntityStore(bus);
  const modifiers = new ModifierStore(bus);
  const resolver = new PropertyResolver(entities, modifiers);
  const ruleTable = new RuleTable("core-rules");
  const ruleHandlers = new RuleHandlerRegistry();
  const engine = new RuleEngine(ruleTable, ruleHandlers, entities, modifiers, resolver, new SeededRandom(1));
  engine.wire(bus);
  return { bus, entities, modifiers, resolver, ruleTable, ruleHandlers };
}

describe("registerRule — pairs a binding and its handler with zero manual casts, identical runtime behavior to the old two-call pattern", () => {
  it("the handler receives the event already narrowed to the trigger's own type — event.phaseId is directly accessible with no cast, the exact field access that used to require `as Extract<...>`", () => {
    const { bus, entities, ruleTable, ruleHandlers } = makeRig();
    entities.add(createCard("Table", { id: "table-1" }));

    let observedPhaseId: string | undefined;
    registerRule(ruleTable, ruleHandlers, { id: "observe-phase-started", trigger: "phase:started" }, (event) => {
      // no cast anywhere in this handler — event is already
      // Extract<GameEvent, {type: "phase:started"}>, so .phaseId
      // typechecks directly
      observedPhaseId = event.phaseId;
    });

    bus.emit({ type: "phase:started", phaseId: "upkeep", subjectId: "table-1" });
    expect(observedPhaseId).toBe("upkeep");
  });

  it("match still gets its own properly-narrowed type too, exactly as RuleBinding<T> already provided before this helper existed", () => {
    const { bus, entities, ruleTable, ruleHandlers } = makeRig();
    entities.add(createCard("Table", { id: "table-1" }));

    let fired = 0;
    registerRule(
      ruleTable,
      ruleHandlers,
      { id: "only-upkeep", trigger: "phase:started", match: (event) => event.phaseId === "upkeep" },
      () => {
        fired++;
      },
    );

    bus.emit({ type: "phase:started", phaseId: "main", subjectId: "table-1" });
    expect(fired).toBe(0); // match correctly filtered this one out
    bus.emit({ type: "phase:started", phaseId: "upkeep", subjectId: "table-1" });
    expect(fired).toBe(1);
  });

  it("the effect name is generated automatically and never collides across two DIFFERENT registerRule calls with different ids", () => {
    const { bus, entities, ruleTable, ruleHandlers } = makeRig();
    entities.add(createCard("Table", { id: "table-1" }));

    let firstFired = 0;
    let secondFired = 0;
    registerRule(ruleTable, ruleHandlers, { id: "rule-one", trigger: "phase:started" }, () => {
      firstFired++;
    });
    registerRule(ruleTable, ruleHandlers, { id: "rule-two", trigger: "phase:started" }, () => {
      secondFired++;
    });

    bus.emit({ type: "phase:started", phaseId: "upkeep", subjectId: "table-1" });
    expect(firstFired).toBe(1);
    expect(secondFired).toBe(1); // both fired independently — no name collision between the two auto-generated effect names
  });

  it("works identically for a DIFFERENT event type carrying entirely different fields — the narrowing isn't special-cased to phase:started", () => {
    const { bus, entities, ruleTable, ruleHandlers } = makeRig();
    entities.add(createCard("Some entity", { id: "some-entity" }));

    let observedTag: string | undefined;
    registerRule(ruleTable, ruleHandlers, { id: "observe-tag-added", trigger: "entity:tagAdded" }, (event) => {
      observedTag = event.tag; // a field that doesn't even exist on phase:started — proves this isn't hardcoded to one event shape
    });

    entities.addTag("some-entity", "contractor");
    expect(observedTag).toBe("contractor");
  });
});
