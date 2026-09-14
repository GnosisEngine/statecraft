import { describe, expect, it } from "vitest";
import { createHand, createZone } from "../core/entity.ts";
import { EventBus } from "../events/bus.ts";
import { EntityStore } from "../events/entity-store.ts";
import { wireQuerySubscriptions } from "../events/subscriptions-wiring.ts";
import { ModifierStore } from "../properties/modifier-store.ts";
import { PropertyResolver } from "../properties/property-resolver.ts";
import { SubscriptionRegistry } from "../query/subscriptions.ts";
import { turnOrderPriorityWindow } from "../actions/priority-window.ts";
import { ALWAYS_TRUE_QUERY, PhaseHandlerRegistry, type PhaseDefinition } from "../phases/phase-definition.ts";
import { PhaseRunner, type PhaseRunnerDeps } from "../phases/phase-runner.ts";
import { SeededRandom } from "../persistence/seeded-random.ts";
import { TurnCycle } from "../phases/turn-cycle.ts";
import { Match } from "../phases/match.ts";

function makeRig(): PhaseRunnerDeps {
  const bus = new EventBus();
  const entities = new EntityStore(bus);
  const modifiers = new ModifierStore(bus);
  const resolver = new PropertyResolver(entities, modifiers);
  const registry = new SubscriptionRegistry();
  wireQuerySubscriptions(bus, registry);
  const handlers = new PhaseHandlerRegistry();
  return { entities, modifiers, resolver, registry, handlers, bus, random: new SeededRandom(1) };
}

describe("PhaseRunner", () => {
  it("a voluntary phase (ALWAYS_TRUE_QUERY) can always end immediately", () => {
    const rig = makeRig();
    const fixer = createHand([], { id: "fixer-A" });
    rig.entities.add(fixer);

    const phase: PhaseDefinition = { id: "main", gateSubject: "activeFixer", completionGate: ALWAYS_TRUE_QUERY };
    const runner = new PhaseRunner(phase, fixer.id, rig);
    runner.start();

    expect(runner.canEnd()).toBe(true);
    expect(runner.tryEnd()).toEqual({ ok: true });
  });

  it("a forced phase blocks tryEnd until its gate is satisfied, firing onChange exactly once on the flip", () => {
    const rig = makeRig();
    const fixer = createHand([], { id: "fixer-A", properties: { outflow: 5 } });
    rig.entities.add(fixer);

    const calls: string[] = [];
    rig.handlers.register("onStart", () => calls.push("start"));
    rig.handlers.register("onChange", () => calls.push("change"));
    rig.handlers.register("onEnd", () => calls.push("end"));

    const phase: PhaseDefinition = {
      id: "cleanup",
      gateSubject: "activeFixer",
      completionGate: { op: "compare", left: { op: "prop", name: "outflow" }, cmp: "lte", right: { op: "lit", value: 0 } },
      onStart: "onStart",
      onChange: "onChange",
      onEnd: "onEnd",
    };
    const runner = new PhaseRunner(phase, fixer.id, rig);
    runner.start();
    expect(calls).toEqual(["start"]);

    expect(runner.tryEnd()).toEqual({ ok: false, reason: `phase "cleanup" completion gate not satisfied` });

    rig.entities.setProperty(fixer.id, "outflow", 3); // still > 0 — gate stays false, no onChange
    expect(calls).toEqual(["start"]);

    rig.entities.setProperty(fixer.id, "outflow", 0); // flips false -> true
    expect(calls).toEqual(["start", "change"]);

    rig.entities.setProperty(fixer.id, "outflow", 0); // same value — EntityStore no-ops, no recompute at all
    expect(calls).toEqual(["start", "change"]);

    expect(runner.tryEnd()).toEqual({ ok: true });
    expect(calls).toEqual(["start", "change", "end"]);
  });

  it("canEnd() is false if the subject entity doesn't exist, regardless of the gate", () => {
    const rig = makeRig();
    const phase: PhaseDefinition = { id: "x", gateSubject: "activeFixer", completionGate: ALWAYS_TRUE_QUERY };
    const runner = new PhaseRunner(phase, "no-such-fixer", rig);
    expect(runner.canEnd()).toBe(false);
  });

  it("throws a clear error if a referenced handler name isn't registered", () => {
    const rig = makeRig();
    const fixer = createHand([], { id: "fixer-A" });
    rig.entities.add(fixer);
    const phase: PhaseDefinition = {
      id: "x",
      gateSubject: "activeFixer",
      completionGate: ALWAYS_TRUE_QUERY,
      onStart: "missing",
    };
    const runner = new PhaseRunner(phase, fixer.id, rig);
    expect(() => runner.start()).toThrow(/No phase handler registered/);
  });
});

describe("TurnCycle", () => {
  it("advances through phases for one fixer, then wraps to the next fixer and increments turn", () => {
    const rig = makeRig();
    const table = createZone();
    rig.entities.add(table);
    rig.entities.add(createHand([], { id: "fixer-A" }));
    rig.entities.add(createHand([], { id: "fixer-B" }));

    const phases: PhaseDefinition[] = [
      { id: "untap", gateSubject: "activeFixer", completionGate: ALWAYS_TRUE_QUERY },
      { id: "main", gateSubject: "activeFixer", completionGate: ALWAYS_TRUE_QUERY },
    ];
    const cycle = new TurnCycle(phases, ["fixer-A", "fixer-B"], table.id, rig);
    cycle.start();

    expect(cycle.currentPhase.id).toBe("untap");
    expect(cycle.activeFixerId).toBe("fixer-A");
    expect(cycle.turn).toBe(1);

    expect(cycle.tryAdvance()).toEqual({ ok: true });
    expect(cycle.currentPhase.id).toBe("main");
    expect(cycle.activeFixerId).toBe("fixer-A");
    expect(cycle.turn).toBe(1);

    expect(cycle.tryAdvance()).toEqual({ ok: true }); // phase list exhausted -> wraps to fixer-B, turn 2
    expect(cycle.currentPhase.id).toBe("untap");
    expect(cycle.activeFixerId).toBe("fixer-B");
    expect(cycle.turn).toBe(2);
  });

  it("a forced phase blocks advancement only for whichever fixer is currently active", () => {
    const rig = makeRig();
    const table = createZone();
    rig.entities.add(table);
    rig.entities.add(createHand([], { id: "fixer-A", properties: { outflow: 5 } }));
    rig.entities.add(createHand([], { id: "fixer-B", properties: { outflow: 0 } }));

    const phases: PhaseDefinition[] = [
      {
        id: "cleanup",
        gateSubject: "activeFixer",
        completionGate: { op: "compare", left: { op: "prop", name: "outflow" }, cmp: "lte", right: { op: "lit", value: 0 } },
      },
    ];
    const cycle = new TurnCycle(phases, ["fixer-A", "fixer-B"], table.id, rig);
    cycle.start();

    expect(cycle.tryAdvance().ok).toBe(false); // fixer-A's outflow is still 5

    rig.entities.setProperty("fixer-A", "outflow", 0);
    expect(cycle.tryAdvance()).toEqual({ ok: true }); // fixer-B's turn now, whose outflow was already 0
    expect(cycle.activeFixerId).toBe("fixer-B");
    expect(cycle.canEndPhase()).toBe(true);
  });

  it("throws constructing with an empty phase list or empty fixer order", () => {
    const rig = makeRig();
    const table = createZone();
    rig.entities.add(table);
    expect(() => new TurnCycle([], ["fixer-A"], table.id, rig)).toThrow(/at least one phase/);
    expect(
      () => new TurnCycle([{ id: "x", gateSubject: "table", completionGate: ALWAYS_TRUE_QUERY }], [], table.id, rig),
    ).toThrow(/at least one fixer/);
  });
});

describe("turnOrderPriorityWindow", () => {
  it("rotates the seating order to start right after the acting fixer", () => {
    const resolver = turnOrderPriorityWindow(["fixer-A", "fixer-B", "fixer-C"]);
    expect(resolver({ performerId: "p", actingFixerId: "fixer-A", targetIds: [] })).toEqual({
      responderOrder: ["fixer-B", "fixer-C"],
    });
    expect(resolver({ performerId: "p", actingFixerId: "fixer-C", targetIds: [] })).toEqual({
      responderOrder: ["fixer-A", "fixer-B"],
    });
  });

  it("returns an empty window if the acting fixer isn't in the seating order", () => {
    const resolver = turnOrderPriorityWindow(["fixer-A", "fixer-B"]);
    expect(resolver({ performerId: "p", actingFixerId: "ghost", targetIds: [] })).toEqual({ responderOrder: [] });
  });
});

describe("Match", () => {
  function makeMatchRig() {
    const rig = makeRig();
    const table = createZone({}, { id: "table-1" });
    rig.entities.add(table);
    rig.entities.add(createHand([], { id: "fixer-A" }));

    const pregame: PhaseDefinition = { id: "draft", gateSubject: "table", completionGate: ALWAYS_TRUE_QUERY };
    const postgame: PhaseDefinition = { id: "scoring", gateSubject: "table", completionGate: ALWAYS_TRUE_QUERY };
    const turnCycle = new TurnCycle(
      [{ id: "main", gateSubject: "activeFixer", completionGate: ALWAYS_TRUE_QUERY }],
      ["fixer-A"],
      table.id,
      rig,
    );
    const match = new Match(pregame, postgame, turnCycle, table.id, rig);
    return { rig, table, turnCycle, match };
  }

  it("progresses pregame -> playing -> postgame -> complete, with endPlayingStage() exiting playing early", () => {
    const { turnCycle, match } = makeMatchRig();
    match.start();
    expect(match.stage).toBe("pregame");

    expect(match.tryAdvance()).toEqual({ ok: true }); // pregame -> playing
    expect(match.stage).toBe("playing");
    expect(turnCycle.currentPhase.id).toBe("main");

    match.endPlayingStage();
    expect(match.stage).toBe("postgame");

    expect(match.tryAdvance()).toEqual({ ok: true }); // postgame -> complete
    expect(match.stage).toBe("complete");
    expect(match.tryAdvance()).toEqual({ ok: false, reason: "match already complete" });
  });

  it("endPlayingStage() is a no-op outside the playing stage", () => {
    const { match } = makeMatchRig();
    match.start();
    match.endPlayingStage(); // stage is "pregame"
    expect(match.stage).toBe("pregame");
  });
});
