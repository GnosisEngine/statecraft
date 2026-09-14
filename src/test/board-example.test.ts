import { describe, expect, it } from "vitest";
import { createCard, createZone } from "../core/entity.ts";
import { EventBus } from "../events/bus.ts";
import { EntityStore } from "../events/entity-store.ts";
import { ModifierStore } from "../properties/modifier-store.ts";
import { PropertyResolver } from "../properties/property-resolver.ts";
import { SeededRandom } from "../persistence/seeded-random.ts";
import { ActionRegistry, type ActionDefinition } from "../actions/action-definition.ts";
import { EffectHandlerRegistry } from "../actions/effect-handler.ts";
import { performAction, type PerformActionDeps } from "../actions/pipeline.ts";
import { RuleHandlerRegistry } from "../rules/rule-handler.ts";
import { RuleTable } from "../rules/rule-table.ts";
import { RuleEngine } from "../rules/rule-engine.ts";

/**
 * Proof that "zones as board slots, cards as placeable pieces" works
 * against the actual engine, not just in the abstract. Two things worth
 * noting about how targeting works here:
 *
 * 1. A piece's x/y is denormalized onto the CARD itself (not looked up
 *    through its zone) whenever it moves. withinDistance reads x/y off
 *    whatever entity you hand it, so pieces need their own copy to make
 *    relational queries direct rather than requiring an extra zone
 *    lookup at query time.
 *
 * 2. targetQuery builds `{ op: "withinDistance", of: ctx.performerId,
 *    maxDistance: 1 }` — it does NOT pre-resolve "which zones are
 *    nearby" into a concrete list. That resolution happens per-candidate
 *    inside the query interpreter itself, at evaluation time, reading
 *    the performer's position live off ctx. This is a case where the
 *    first-class op turns out to earn its keep for ACTION TARGETING too,
 *    not just for reactive rule conditions — the plain-code
 *    entitiesWithinRange helper is still useful for building a concrete
 *    candidate list on demand, but it's not the only way to use this,
 *    and here the relational query is actually the cleaner shape.
 */
describe("board example: grid movement + reactive ambush", () => {
  it("a piece can move to an adjacent zone, and moving into range of an enemy triggers a reactive rule", () => {
    const bus = new EventBus();
    const entities = new EntityStore(bus);
    const modifiers = new ModifierStore(bus);
    const resolver = new PropertyResolver(entities, modifiers);
    const actions = new ActionRegistry();
    const effectHandlers = new EffectHandlerRegistry();
    const ruleHandlers = new RuleHandlerRegistry();
    const ruleTable = new RuleTable("board-rules");
    const ruleEngine = new RuleEngine(ruleTable, ruleHandlers, entities, modifiers, resolver, new SeededRandom(1));
    ruleEngine.wire(bus);

    // 3x3 grid of public zones, each carrying its own x/y.
    for (let x = 0; x < 3; x++) {
      for (let y = 0; y < 3; y++) {
        entities.add(createZone({ visibility: "public" }, { id: `zone-${x}-${y}`, properties: { x, y } }));
      }
    }

    const piece = createCard("Scout", { id: "piece-A", zoneId: "zone-0-0", properties: { x: 0, y: 0 }, ownership: ["fixer-A"] });
    const enemy = createCard("Sentinel", { id: "piece-B", zoneId: "zone-2-2", properties: { x: 2, y: 2 }, ownership: ["fixer-B"] });
    entities.add(piece);
    entities.add(enemy);

    const move: ActionDefinition = {
      id: "move",
      category: () => "movement",
      targetsOwn: false,
      targetsOthers: false,
      targetQuery: (ctx) => ({
        op: "and",
        exprs: [{ op: "kindIs", kind: "zone" }, { op: "withinDistance", of: ctx.performerId, maxDistance: 1 }],
      }),
      effect: "moveEffect",
    };
    actions.register(move);
    effectHandlers.register("moveEffect", (ctx, api) => {
      const destinationZoneId = ctx.targetIds[0]!;
      api.entities.moveToZone(ctx.performerId, destinationZoneId);
      const zone = api.entities.get(destinationZoneId)!;
      api.entities.setProperty(ctx.performerId, "x", zone.properties.x ?? 0);
      api.entities.setProperty(ctx.performerId, "y", zone.properties.y ?? 0);
    });

    ruleTable.add({
      id: "ambush",
      trigger: "action:resolved",
      match: (event) => event.actionId === "move",
      subject: (event) => event.performerId,
      condition: { op: "withinDistance", of: "piece-B", maxDistance: 1 },
      effect: "ambushEffect",
    });
    ruleHandlers.register("ambushEffect", (_event, api) => {
      const e = _event as Extract<typeof _event, { type: "action:resolved" }>;
      api.entities.addTag(e.performerId, "ambushed");
    });

    const deps: PerformActionDeps = { entities, resolver, modifiers, handlers: effectHandlers, bus, random: new SeededRandom(1) };

    // move 1: (0,0) -> (1,0). Still distance 2 from the enemy at (2,2) — safe.
    const r1 = performAction({ performerId: "piece-A", actingFixerId: "fixer-A", targetIds: ["zone-1-0"] }, move, deps);
    expect(r1.ok).toBe(true);
    expect(piece.tags.has("ambushed")).toBe(false);

    // move 2: (1,0) -> (1,1). Now distance 1 from the enemy at (2,2) — ambush fires.
    const r2 = performAction({ performerId: "piece-A", actingFixerId: "fixer-A", targetIds: ["zone-1-1"] }, move, deps);
    expect(r2.ok).toBe(true);
    expect(piece.tags.has("ambushed")).toBe(true);
  });

  it("rejects moving further than one step away", () => {
    const bus = new EventBus();
    const entities = new EntityStore(bus);
    const modifiers = new ModifierStore(bus);
    const resolver = new PropertyResolver(entities, modifiers);
    const actions = new ActionRegistry();
    const effectHandlers = new EffectHandlerRegistry();

    for (let x = 0; x < 3; x++) {
      for (let y = 0; y < 3; y++) {
        entities.add(createZone({ visibility: "public" }, { id: `zone-${x}-${y}`, properties: { x, y } }));
      }
    }
    const piece = createCard("Scout", { id: "piece-A", zoneId: "zone-0-0", properties: { x: 0, y: 0 }, ownership: ["fixer-A"] });
    entities.add(piece);

    const move: ActionDefinition = {
      id: "move",
      category: () => "movement",
      targetsOwn: false,
      targetsOthers: false,
      targetQuery: (ctx) => ({
        op: "and",
        exprs: [{ op: "kindIs", kind: "zone" }, { op: "withinDistance", of: ctx.performerId, maxDistance: 1 }],
      }),
      effect: "moveEffect",
    };
    actions.register(move);
    effectHandlers.register("moveEffect", (ctx, api) => {
      api.entities.moveToZone(ctx.performerId, ctx.targetIds[0]!);
    });

    const deps: PerformActionDeps = { entities, resolver, modifiers, handlers: effectHandlers, bus, random: new SeededRandom(1) };
    const result = performAction({ performerId: "piece-A", actingFixerId: "fixer-A", targetIds: ["zone-2-2"] }, move, deps);

    expect(result).toEqual({ ok: false, reason: "illegal target: zone-2-2" });
  });
});
