import { describe, expect, it } from "vitest";
import { createCard } from "../core/entity.ts";
import { EventBus } from "../events/bus.ts";
import { EntityStore } from "../events/entity-store.ts";
import { ModifierStore } from "../properties/modifier-store.ts";
import { PropertyResolver } from "../properties/property-resolver.ts";
import { createAbilityRegistry, buildActivateAction, buildActivateEffectHandler } from "./activate.ts";
import { EffectHandlerRegistry } from "./effect-handler.ts";
import { performAction, type PerformActionDeps } from "./pipeline.ts";
import type { ActionContext } from "./action-definition.ts";
import { SeededRandom } from "../persistence/seeded-random.ts";

function makeRig() {
  const bus = new EventBus();
  const entities = new EntityStore(bus);
  const modifiers = new ModifierStore(bus);
  const resolver = new PropertyResolver(entities, modifiers);
  const abilities = createAbilityRegistry();
  const effectHandlers = new EffectHandlerRegistry();

  // A minimal, generic ability — "poke": exactly one target, costs 3 "energy", tags the target "poked".
  abilities.register({
    id: "poke",
    category: () => "poking",
    targetsOwn: false,
    targetsOthers: true,
    targetQuery: () => ({ op: "hasTag", tag: "pokeable" }),
    minTargets: () => 1,
    maxTargets: () => 1,
    cost: () => ({ prop: "energy", amount: 3 }),
    effect: "pokeEffect",
  });
  effectHandlers.register("pokeEffect", (ctx, api) => {
    api.entities.addTag(ctx.targetIds[0]!, "poked");
  });
  effectHandlers.register("activateEffect", buildActivateEffectHandler(abilities, effectHandlers));

  const activate = buildActivateAction(abilities);
  const deps: PerformActionDeps = { entities, resolver, modifiers, handlers: effectHandlers, bus, random: new SeededRandom(1) };

  return { entities, resolver, abilities, activate, deps };
}

describe("buildActivateAction", () => {
  it("dispatches to the named ability's own targetQuery/cost/effect when the performer actually grants it", () => {
    const { entities, resolver, activate, deps } = makeRig();
    entities.add(createCard("Fixer A", { id: "fixer-A", properties: { energy: 5 } }));
    const poker = createCard("Poker", { id: "poker", ownership: ["fixer-A"] });
    poker.tags.add("ability:poke");
    entities.add(poker);
    const target = createCard("Target", { id: "target", ownership: ["fixer-B"] });
    target.tags.add("pokeable");
    entities.add(target);

    const intent: ActionContext = { performerId: "poker", actingFixerId: "fixer-A", targetIds: ["target"], params: { abilityId: "poke" } };
    const result = performAction(intent, activate, deps);

    expect(result.ok).toBe(true);
    expect(entities.get("target")?.tags.has("poked")).toBe(true);
    expect(resolver.getProperty("fixer-A", "energy")).toBe(2); // 5 - 3
  });

  it("rejects if the performer doesn't actually carry the ability:<id> tag — a client can't claim an ability a card doesn't have", () => {
    const { entities, activate, deps } = makeRig();
    entities.add(createCard("Fixer A", { id: "fixer-A", properties: { energy: 5 } }));
    const impostor = createCard("Impostor", { id: "impostor", ownership: ["fixer-A"] });
    // deliberately NOT tagged ability:poke
    entities.add(impostor);
    const target = createCard("Target", { id: "target", ownership: ["fixer-B"] });
    target.tags.add("pokeable");
    entities.add(target);

    const intent: ActionContext = { performerId: "impostor", actingFixerId: "fixer-A", targetIds: ["target"], params: { abilityId: "poke" } };
    const result = performAction(intent, activate, deps);

    expect(result.ok).toBe(false);
  });

  it("rejects a nonexistent abilityId, rather than throwing or silently allowing anything through", () => {
    const { entities, activate, deps } = makeRig();
    entities.add(createCard("Fixer A", { id: "fixer-A", properties: { energy: 5 } }));
    const poker = createCard("Poker", { id: "poker", ownership: ["fixer-A"] });
    poker.tags.add("ability:poke");
    entities.add(poker);

    const intent: ActionContext = { performerId: "poker", actingFixerId: "fixer-A", targetIds: [], params: { abilityId: "nonexistent" } };
    const result = performAction(intent, activate, deps);

    expect(result.ok).toBe(false);
  });

  it("rejects when no abilityId is given at all", () => {
    const { entities, activate, deps } = makeRig();
    entities.add(createCard("Fixer A", { id: "fixer-A", properties: { energy: 5 } }));
    const poker = createCard("Poker", { id: "poker", ownership: ["fixer-A"] });
    poker.tags.add("ability:poke");
    entities.add(poker);

    const intent: ActionContext = { performerId: "poker", actingFixerId: "fixer-A", targetIds: [] };
    const result = performAction(intent, activate, deps);

    expect(result.ok).toBe(false);
  });

  it("enforces the ability's own minTargets/maxTargets, not a fixed arity for every ability", () => {
    const { entities, activate, deps } = makeRig();
    entities.add(createCard("Fixer A", { id: "fixer-A", properties: { energy: 5 } }));
    const poker = createCard("Poker", { id: "poker", ownership: ["fixer-A"] });
    poker.tags.add("ability:poke");
    entities.add(poker);

    // zero targets — poke requires exactly 1
    const intent: ActionContext = { performerId: "poker", actingFixerId: "fixer-A", targetIds: [], params: { abilityId: "poke" } };
    const result = performAction(intent, activate, deps);
    expect(result.ok).toBe(false);
  });

  it("enforces the ability's own cost, not a fixed cost for every ability", () => {
    const { entities, resolver, activate, deps } = makeRig();
    entities.add(createCard("Fixer A", { id: "fixer-A", properties: { energy: 2 } })); // not enough for poke's cost of 3
    const poker = createCard("Poker", { id: "poker", ownership: ["fixer-A"] });
    poker.tags.add("ability:poke");
    entities.add(poker);
    const target = createCard("Target", { id: "target", ownership: ["fixer-B"] });
    target.tags.add("pokeable");
    entities.add(target);

    const intent: ActionContext = { performerId: "poker", actingFixerId: "fixer-A", targetIds: ["target"], params: { abilityId: "poke" } };
    const result = performAction(intent, activate, deps);

    expect(result.ok).toBe(false);
    expect(resolver.getProperty("fixer-A", "energy")).toBe(2); // untouched — nothing deducted on rejection
  });

  it("an ability with NO timingCondition of its own is always legal timing-wise — a real bug this caught: the fallback used to conflate 'no restriction' with 'no such ability,' making every timing-unrestricted ability permanently unusable", () => {
    const { entities, activate, deps } = makeRig();
    entities.add(createCard("Fixer A", { id: "fixer-A", properties: { energy: 5 } }));
    const poker = createCard("Poker", { id: "poker", ownership: ["fixer-A"] });
    poker.tags.add("ability:poke"); // "poke" sets no timingCondition at all
    entities.add(poker);
    const target = createCard("Target", { id: "target", ownership: ["fixer-B"] });
    target.tags.add("pokeable");
    entities.add(target);

    const intent: ActionContext = { performerId: "poker", actingFixerId: "fixer-A", targetIds: ["target"], params: { abilityId: "poke" } };
    expect(performAction(intent, activate, deps).ok).toBe(true);
  });

  it("an ability WITH its own real timingCondition is correctly enforced through activate — not bypassed, not always-rejected", () => {
    const { entities, abilities, activate, deps } = makeRig();
    abilities.register({
      id: "timed-poke",
      category: () => "poking",
      targetsOwn: false,
      targetsOthers: true,
      targetQuery: () => ({ op: "hasTag", tag: "pokeable" }),
      minTargets: () => 1,
      maxTargets: () => 1,
      timingCondition: (ctx) => ({ op: "hasTag", tag: "active-turn", subject: ctx.actingFixerId }),
      effect: "pokeEffect",
    });

    entities.add(createCard("Fixer A", { id: "fixer-A", properties: { energy: 5 } }));
    const poker = createCard("Poker", { id: "poker", ownership: ["fixer-A"] });
    poker.tags.add("ability:timed-poke");
    entities.add(poker);
    const target = createCard("Target", { id: "target", ownership: ["fixer-B"] });
    target.tags.add("pokeable");
    entities.add(target);

    const intent: ActionContext = { performerId: "poker", actingFixerId: "fixer-A", targetIds: ["target"], params: { abilityId: "timed-poke" } };

    // fixer-A does NOT have "active-turn" yet — should be rejected
    expect(performAction(intent, activate, deps).ok).toBe(false);

    // once fixer-A IS active, the same ability becomes legal
    entities.addTag("fixer-A", "active-turn");
    expect(performAction(intent, activate, deps).ok).toBe(true);
  });
});
