import { describe, expect, it } from "vitest";
import { createCard } from "../core/entity.ts";
import { EventBus } from "../events/bus.ts";
import { EntityStore } from "../events/entity-store.ts";
import { Hierarchy } from "../events/hierarchy.ts";
import { Stack } from "../events/stack.ts";
import { ModifierStore } from "../properties/modifier-store.ts";
import { PropertyResolver } from "../properties/property-resolver.ts";
import { SeededRandom } from "../persistence/seeded-random.ts";
import { RuleTable } from "../rules/rule-table.ts";
import { RuleHandlerRegistry } from "../rules/rule-handler.ts";
import { RuleEngine } from "../rules/rule-engine.ts";
import { ActionRegistry, type ActionDefinition } from "../actions/action-definition.ts";
import { EffectHandlerRegistry } from "../actions/effect-handler.ts";
import { PendingActionRegistry } from "../actions/pending-action-registry.ts";
import { buildActivateAction, buildActivateEffectHandler, createAbilityRegistry } from "../actions/activate.ts";
import { resolveEffect, type PerformActionDeps } from "../actions/pipeline.ts";
import { registerReflex, type ReflexDeps } from "./reflex.ts";

/**
 * A deliberately generic rig — no cyberfixer-specific vocabulary
 * anywhere (no "fixer", no "outflow", no faction tags) — specifically
 * to prove registerReflex genuinely doesn't depend on any of that.
 */
function makeRig() {
  const bus = new EventBus();
  const entities = new EntityStore(bus);
  const modifiers = new ModifierStore(bus);
  const resolver = new PropertyResolver(entities, modifiers);
  const random = new SeededRandom(1);
  const hierarchy = new Hierarchy("pending", bus);
  entities.add(createCard("Anchor", { id: "anchor" }));
  const stack = new Stack(hierarchy, entities, bus, "anchor");
  const ruleTable = new RuleTable("core-rules");
  const ruleHandlers = new RuleHandlerRegistry();
  const engine = new RuleEngine(ruleTable, ruleHandlers, entities, modifiers, resolver, random);
  engine.wire(bus);
  const abilities = createAbilityRegistry();
  const actions = new ActionRegistry();
  const activateDefinition = buildActivateAction(abilities);
  actions.register(activateDefinition);
  const effectHandlers = new EffectHandlerRegistry();
  effectHandlers.register("activateEffect", buildActivateEffectHandler(abilities, effectHandlers));
  const pendingActions = new PendingActionRegistry();
  const deps: PerformActionDeps = { entities, resolver, modifiers, handlers: effectHandlers, bus, random, pendingActions };
  const reflexDeps: ReflexDeps = { ruleTable, ruleHandlers, stack, pendingActions, effectHandlers, bus, activateDefinition, anchorEntityId: "anchor", counterProperty: "reflexCounter" };
  return { bus, entities, resolver, modifiers, abilities, actions, effectHandlers, deps, reflexDeps, stack, pendingActions, activateDefinition };
}

describe("registerReflex — a generic engine primitive, proven independently of any specific game's content", () => {
  it("automatically proposes the bound response, through the ordinary proposeAction path, paying its normal cost — not a bespoke, free side effect", () => {
    const { entities, resolver, abilities, effectHandlers, deps, reflexDeps, stack, pendingActions, activateDefinition } = makeRig();

    entities.add(createCard("Trigger", { id: "trigger", ownership: ["player-A"] }));
    entities.add(createCard("Guard", { id: "guard", ownership: ["player-B"] }));
    entities.add(createCard("Player B", { id: "player-B", properties: { budget: 10 } })); // cost is deducted from the FIXER (actingFixerId), not the performer card itself

    const respond: ActionDefinition = {
      id: "respond",
      category: () => "test",
      targetsOwn: false,
      targetsOthers: true,
      targetQuery: () => ({ op: "and", exprs: [] }),
      cost: () => ({ prop: "budget", amount: 3 }),
      effect: "respondEffect",
    };
    abilities.register(respond);
    effectHandlers.register("respondEffect", (ctx, api) => {
      api.entities.addTag(ctx.targetIds[0]!, "responded-to");
    });

    registerReflex(reflexDeps, {
      id: "guard-reflex",
      boundAbilityTag: "ability:respond",
      trigger: "entity:tagAdded",
      matches: (event, boundEntityId) => event.tag === "provoked" && event.entityId !== boundEntityId,
      responseAbilityId: "respond",
      buildIntent: (event) => ({ targetIds: [event.entityId] }),
    });
    entities.get("guard")!.tags.add("ability:respond");

    entities.addTag("trigger", "provoked"); // fires the reflex

    // the reflex's own proposal is now genuinely pending, not resolved yet
    expect(stack.leaves().length).toBe(1);
    const pendingId = stack.leaves()[0]!;
    expect(pendingActions.get(pendingId)?.actionId).toBe("activate");

    // it actually paid its own normal cost, at propose time
    expect(resolver.getProperty("player-B", "budget")).toBe(7);

    // resolve it and confirm the effect actually lands
    const pending = pendingActions.get(pendingId)!;
    resolveEffect(pending.intent, pending.definition, pending.capability, pending.adjustedCost, deps);
    expect(entities.get("trigger")?.tags.has("responded-to")).toBe(true);
  });

  it("silently does not fire if the bound fixer can't afford the response — proposeAction's own rejection, not special-cased by the reflex", () => {
    const { entities, resolver, abilities, effectHandlers, reflexDeps, stack } = makeRig();

    entities.add(createCard("Trigger", { id: "trigger", ownership: ["player-A"] }));
    entities.add(createCard("Guard", { id: "guard", ownership: ["player-B"] }));
    entities.add(createCard("Player B", { id: "player-B", properties: { budget: 1 } })); // genuinely insufficient for cost 3 — not just absent

    const respond: ActionDefinition = {
      id: "respond",
      category: () => "test",
      targetsOwn: false,
      targetsOthers: true,
      targetQuery: () => ({ op: "and", exprs: [] }),
      cost: () => ({ prop: "budget", amount: 3 }),
      effect: "respondEffect",
    };
    abilities.register(respond);
    effectHandlers.register("respondEffect", () => {});

    registerReflex(reflexDeps, {
      id: "guard-reflex-2",
      boundAbilityTag: "ability:respond",
      trigger: "entity:tagAdded",
      matches: (event, boundEntityId) => event.tag === "provoked" && event.entityId !== boundEntityId,
      responseAbilityId: "respond",
      buildIntent: (event) => ({ targetIds: [event.entityId] }),
    });
    entities.get("guard")!.tags.add("ability:respond");

    entities.addTag("trigger", "provoked");

    expect(stack.leaves().length).toBe(0); // never fired — unaffordable, silently
    expect(resolver.getProperty("player-B", "budget")).toBe(1); // untouched
  });

  it("bound entities are found by TAG, not by a hardcoded id — a SECOND entity gaining the ability tag later reacts too, without registering the reflex again", () => {
    const { entities, abilities, effectHandlers, reflexDeps, stack } = makeRig();

    entities.add(createCard("Trigger", { id: "trigger", ownership: ["player-A"] }));
    entities.add(createCard("Late guard", { id: "late-guard", ownership: ["player-B"], properties: { budget: 10 } }));

    const respond: ActionDefinition = {
      id: "respond",
      category: () => "test",
      targetsOwn: false,
      targetsOthers: true,
      targetQuery: () => ({ op: "and", exprs: [] }),
      effect: "respondEffect",
    };
    abilities.register(respond);
    effectHandlers.register("respondEffect", () => {});

    registerReflex(reflexDeps, {
      id: "guard-reflex-3",
      boundAbilityTag: "ability:respond",
      trigger: "entity:tagAdded",
      matches: (event, boundEntityId) => event.tag === "provoked" && event.entityId !== boundEntityId,
      responseAbilityId: "respond",
      buildIntent: (event) => ({ targetIds: [event.entityId] }),
    });

    // the ability tag is granted AFTER registerReflex was already called
    entities.get("late-guard")!.tags.add("ability:respond");
    entities.addTag("trigger", "provoked");

    expect(stack.leaves().length).toBe(1); // still fired — found by tag, not by an id captured at registration time
  });
});
