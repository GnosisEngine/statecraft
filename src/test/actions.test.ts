import { describe, expect, it, vi } from "vitest";
import { createCard, createHand, currentOwner, transferOwnership } from "../core/entity.ts";
import { EventBus } from "../events/bus.ts";
import { EntityStore } from "../events/entity-store.ts";
import { Hierarchy } from "../events/hierarchy.ts";
import { Stack } from "../events/stack.ts";
import { ModifierStore } from "../properties/modifier-store.ts";
import { PropertyResolver } from "../properties/property-resolver.ts";
import { newModifierId } from "../properties/modifier.ts";
import { SeededRandom } from "../persistence/seeded-random.ts";
import { ActionRegistry, type ActionContext, type ActionDefinition } from "../actions/action-definition.ts";
import { EffectHandlerRegistry, type ActionApi, type ResolvedActionContext } from "../actions/effect-handler.ts";
import { performAction, proposeAction, resolveEffect, validateAction, type PerformActionDeps } from "../actions/pipeline.ts";
import { PendingActionRegistry } from "../actions/pending-action-registry.ts";
import { HierarchyRegistry } from "../query/hierarchy-registry.ts";
import { selectEntities, evaluateBoolExpr } from "../query/interpreter.ts";
import type { BoolExpr } from "../query/types.ts";

/** Builds a fresh store/resolver/registry rig plus two fixers and a shakedown-style action, shared by most tests. */
function makeRig() {
  const bus = new EventBus();
  const entities = new EntityStore(bus);
  const modifiers = new ModifierStore(bus);
  const resolver = new PropertyResolver(entities, modifiers);
  const handlers = new EffectHandlerRegistry();
  const actions = new ActionRegistry();

  const fixerA = createHand([], { id: "fixer-A", properties: { resources: 10 } });
  const fixerB = createHand([], { id: "fixer-B", properties: { resources: 10 } });
  entities.add(fixerA);
  entities.add(fixerB);

  const shakedownTargetQuery = (ctx: ActionContext): BoolExpr => ({
    op: "and",
    exprs: [{ op: "hasTag", tag: "contractor" }, { op: "not", expr: { op: "ownedBy", fixerId: ctx.actingFixerId } }],
  });

  const shakedown: ActionDefinition = {
    id: "shakedown",
    category: () => "coercion",
    targetsOwn: false,
    targetsOthers: true,
    targetQuery: shakedownTargetQuery,
    performerCondition: () => ({ op: "hasTag", tag: "contractor" }),
    cost: () => ({ prop: "resources", amount: 4 }),
    effect: "shakedownEffect",
  };
  actions.register(shakedown);

  handlers.register("shakedownEffect", (ctx: ResolvedActionContext, api: ActionApi) => {
    for (const targetId of ctx.targetIds) {
      api.entities.addTag(targetId, "shaken");
      api.modifiers.add({
        id: newModifierId(),
        targetEntityId: targetId,
        prop: "inflow",
        op: "add",
        value: -3,
        priority: 0,
        source: "shakedown",
      });
    }
  });

  const deps: PerformActionDeps = { entities, resolver, modifiers, handlers, bus, random: new SeededRandom(1) };
  return { bus, entities, modifiers, resolver, handlers, actions, shakedown, deps, fixerA, fixerB };
}

describe("validateAction", () => {
  it("rejects an unknown performer", () => {
    const { shakedown, deps } = makeRig();
    const result = validateAction(
      { performerId: "nope", actingFixerId: "fixer-A", targetIds: [] },
      shakedown,
      deps,
    );
    expect(result).toEqual({ ok: false, reason: "unknown performer: nope" });
  });

  it("rejects when performerCondition fails (performer isn't a contractor)", () => {
    const { entities, shakedown, deps } = makeRig();
    const notAContractor = createCard("Bystander");
    entities.add(notAContractor);

    const result = validateAction(
      { performerId: notAContractor.id, actingFixerId: "fixer-A", targetIds: [] },
      shakedown,
      deps,
    );
    expect(result).toEqual({ ok: false, reason: "performer condition not met" });
  });

  it("rejects an illegal target (not matching targetQuery)", () => {
    const { entities, shakedown, deps } = makeRig();
    const performer = createCard("Razor", { ownership: ["fixer-A"] });
    performer.tags.add("contractor");
    const notATarget = createCard("Irrelevant"); // no "contractor" tag
    entities.add(performer);
    entities.add(notATarget);

    const result = validateAction(
      { performerId: performer.id, actingFixerId: "fixer-A", targetIds: [notATarget.id] },
      shakedown,
      deps,
    );
    expect(result).toEqual({ ok: false, reason: `illegal target: ${notATarget.id}` });
  });

  it("rejects targeting your own contractor via targetQuery exclusion (targetsOwn: false)", () => {
    const { entities, shakedown, deps } = makeRig();
    const performer = createCard("Razor", { ownership: ["fixer-A"] });
    performer.tags.add("contractor");
    const ownContractor = createCard("Fence", { ownership: ["fixer-A"] });
    ownContractor.tags.add("contractor");
    entities.add(performer);
    entities.add(ownContractor);

    const result = validateAction(
      { performerId: performer.id, actingFixerId: "fixer-A", targetIds: [ownContractor.id] },
      shakedown,
      deps,
    );
    expect(result.ok).toBe(false);
  });

  it("belt-and-suspenders: rejects an own-entity target even if targetQuery would have allowed it", () => {
    const { entities, deps } = makeRig();
    // deliberately permissive targetQuery (matches ANY contractor, ownership-blind)
    const permissive: ActionDefinition = {
      id: "loose-action",
      category: () => "coercion",
      targetsOwn: false,
      targetsOthers: true,
      targetQuery: () => ({ op: "hasTag", tag: "contractor" }),
      effect: "noop",
    };
    const performer = createCard("Razor", { ownership: ["fixer-A"] });
    performer.tags.add("contractor");
    const ownContractor = createCard("Fence", { ownership: ["fixer-A"] });
    ownContractor.tags.add("contractor");
    entities.add(performer);
    entities.add(ownContractor);

    const result = validateAction(
      { performerId: performer.id, actingFixerId: "fixer-A", targetIds: [ownContractor.id] },
      permissive,
      deps,
    );
    expect(result).toEqual({
      ok: false,
      reason: `action "loose-action" cannot target the performer's own entities`,
    });
  });

  it("rejects on insufficient resources", () => {
    const { entities, deps, shakedown } = makeRig();
    deps.entities.setProperty("fixer-A", "resources", 1); // neutral cost is 4

    const performer = createCard("Razor", { ownership: ["fixer-A"] });
    performer.tags.add("contractor");
    const target = createCard("Runner", { ownership: ["fixer-B"] });
    target.tags.add("contractor");
    entities.add(performer);
    entities.add(target);

    const result = validateAction(
      { performerId: performer.id, actingFixerId: "fixer-A", targetIds: [target.id] },
      shakedown,
      deps,
    );
    expect(result).toEqual({ ok: false, reason: "insufficient resources: need 4, have 1" });
  });
});

describe("performer-capability cost adjustment", () => {
  it("preferred halves the cost, weak increases it by 50%, neutral is unchanged", () => {
    const { entities, deps, shakedown } = makeRig();
    const target = createCard("Runner", { ownership: ["fixer-B"] });
    target.tags.add("contractor");
    entities.add(target);

    const preferred = createCard("Ace", { ownership: ["fixer-A"] });
    preferred.tags.add("contractor");
    preferred.tags.add("pref:coercion");
    const weak = createCard("Rookie", { ownership: ["fixer-A"] });
    weak.tags.add("contractor");
    weak.tags.add("weak:coercion");
    const neutral = createCard("Grunt", { ownership: ["fixer-A"] });
    neutral.tags.add("contractor");
    entities.add(preferred);
    entities.add(weak);
    entities.add(neutral);

    const r1 = validateAction({ performerId: preferred.id, actingFixerId: "fixer-A", targetIds: [target.id] }, shakedown, deps);
    const r2 = validateAction({ performerId: weak.id, actingFixerId: "fixer-A", targetIds: [target.id] }, shakedown, deps);
    const r3 = validateAction({ performerId: neutral.id, actingFixerId: "fixer-A", targetIds: [target.id] }, shakedown, deps);

    expect(r1).toEqual({ ok: true, adjustedCost: 2, capability: "preferred" });
    expect(r2).toEqual({ ok: true, adjustedCost: 6, capability: "weak" });
    expect(r3).toEqual({ ok: true, adjustedCost: 4, capability: "neutral" });
  });
});

describe("performAction: full pipeline", () => {
  it("deducts adjusted cost, runs the effect handler, and emits action:resolved", () => {
    const { entities, resolver, deps, shakedown, bus } = makeRig();

    const performer = createCard("Ace", { ownership: ["fixer-A"] });
    performer.tags.add("contractor");
    performer.tags.add("pref:coercion");
    const target = createCard("Runner", { ownership: ["fixer-B"], properties: { inflow: 5 } });
    target.tags.add("contractor");
    entities.add(performer);
    entities.add(target);

    const resolvedSpy = vi.fn();
    const proposedSpy = vi.fn();
    bus.on("action:resolved", resolvedSpy);
    bus.on("action:proposed", proposedSpy);

    const result = performAction(
      { performerId: performer.id, actingFixerId: "fixer-A", targetIds: [target.id] },
      shakedown,
      deps,
    );

    expect(result).toEqual({ ok: true, adjustedCost: 2, capability: "preferred" });
    expect(resolver.getProperty("fixer-A", "resources")).toBe(8); // 10 - 2
    expect(target.tags.has("shaken")).toBe(true);
    expect(resolver.getProperty(target.id, "inflow")).toBe(2); // 5 + (-3) modifier

    expect(proposedSpy).toHaveBeenCalledTimes(1);
    expect(resolvedSpy).toHaveBeenCalledWith({
      type: "action:resolved",
      actionId: "shakedown",
      performerId: performer.id,
      actingFixerId: "fixer-A",
      targetIds: [target.id],
      capability: "preferred",
      adjustedCost: 2,
    });
  });

  it("emits action:rejected and performs no mutation when validation fails", () => {
    const { entities, resolver, deps, shakedown, bus } = makeRig();
    const performer = createCard("Ace", { ownership: ["fixer-A"] });
    performer.tags.add("contractor");
    entities.add(performer);

    const rejectedSpy = vi.fn();
    bus.on("action:rejected", rejectedSpy);

    const result = performAction(
      { performerId: performer.id, actingFixerId: "fixer-A", targetIds: ["does-not-exist"] },
      shakedown,
      deps,
    );

    expect(result.ok).toBe(false);
    expect(resolver.getProperty("fixer-A", "resources")).toBe(10); // untouched
    expect(rejectedSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: "action:rejected", actionId: "shakedown" }),
    );
  });

  it("throws a clear error if the effect handler was never registered", () => {
    const { entities, deps, actions } = makeRig();
    const performer = createCard("Ace", { ownership: ["fixer-A"] });
    performer.tags.add("contractor");
    const target = createCard("Runner", { ownership: ["fixer-B"] });
    target.tags.add("contractor");
    entities.add(performer);
    entities.add(target);

    const orphanAction: ActionDefinition = {
      id: "orphan",
      category: () => "coercion",
      targetsOwn: false,
      targetsOthers: true,
      targetQuery: () => ({ op: "hasTag", tag: "contractor" }),
      effect: "does-not-exist",
    };

    expect(() =>
      performAction({ performerId: performer.id, actingFixerId: "fixer-A", targetIds: [target.id] }, orphanAction, deps),
    ).toThrow(/No effect handler registered/);
  });
});

describe("proposeAction/resolveEffect: the split that lets a game wait for priority before resolving", () => {
  it("proposeAction validates and pays cost, but does NOT run the effect — the target isn't tagged, no modifier is added, yet", () => {
    const { entities, resolver, shakedown, deps, fixerA } = makeRig();
    const performer = createCard("Fixer's Contractor", { ownership: ["fixer-A"] });
    performer.tags.add("contractor");
    const target = createCard("Rival Contractor", { ownership: ["fixer-B"] });
    target.tags.add("contractor");
    entities.add(performer);
    entities.add(target);
    fixerA.properties.resources = 10;

    const result = proposeAction({ performerId: performer.id, actingFixerId: "fixer-A", targetIds: [target.id] }, shakedown, deps);

    expect(result).toEqual({ ok: true, adjustedCost: 4, capability: "neutral" });
    expect(resolver.getProperty("fixer-A", "resources")).toBe(6); // cost WAS paid — non-refundable if never resolved
    expect(target.tags.has("shaken")).toBe(false); // but the effect has NOT run
  });

  it("resolveEffect, called separately with the stored result, actually runs the effect and fires action:resolved", () => {
    const { entities, bus, shakedown, deps, fixerA } = makeRig();
    const performer = createCard("Fixer's Contractor", { ownership: ["fixer-A"] });
    performer.tags.add("contractor");
    const target = createCard("Rival Contractor", { ownership: ["fixer-B"] });
    target.tags.add("contractor");
    entities.add(performer);
    entities.add(target);
    fixerA.properties.resources = 10;

    const intent = { performerId: performer.id, actingFixerId: "fixer-A", targetIds: [target.id] };
    const proposed = proposeAction(intent, shakedown, deps);
    expect(proposed.ok).toBe(true);
    if (!proposed.ok) return;

    const resolved = vi.fn();
    bus.on("action:resolved", resolved);
    resolveEffect(intent, shakedown, proposed.capability, proposed.adjustedCost, deps);

    expect(target.tags.has("shaken")).toBe(true);
    expect(resolved).toHaveBeenCalledOnce();
  });

  it("resolveEffect can run arbitrarily later, after unrelated mutations happen in between — simulating a real wait for priority", () => {
    const { entities, shakedown, deps, fixerA } = makeRig();
    const performer = createCard("Fixer's Contractor", { ownership: ["fixer-A"] });
    performer.tags.add("contractor");
    const target = createCard("Rival Contractor", { ownership: ["fixer-B"] });
    target.tags.add("contractor");
    entities.add(performer);
    entities.add(target);
    fixerA.properties.resources = 10;

    const intent = { performerId: performer.id, actingFixerId: "fixer-A", targetIds: [target.id] };
    const proposed = proposeAction(intent, shakedown, deps);
    if (!proposed.ok) throw new Error("expected proposal to succeed");

    // time passes; unrelated state changes happen in between (e.g. a
    // different fixer's own action resolving first)
    entities.setProperty("fixer-B", "unrelatedProperty", 42);
    entities.addTag(target.id, "some-other-unrelated-tag");

    resolveEffect(intent, shakedown, proposed.capability, proposed.adjustedCost, deps);
    expect(target.tags.has("shaken")).toBe(true); // still resolves correctly despite the delay
  });

  it("a rejected proposal never reaches resolveEffect at all — nothing is charged, nothing is stored to resolve later", () => {
    const { entities, resolver, shakedown, deps, fixerA } = makeRig();
    const performer = createCard("Fixer's Contractor", { ownership: ["fixer-A"] });
    performer.tags.add("contractor");
    const target = createCard("Rival Contractor", { ownership: ["fixer-B"] });
    target.tags.add("contractor");
    entities.add(performer);
    entities.add(target);
    fixerA.properties.resources = 1; // not enough for the cost of 4

    const result = proposeAction({ performerId: performer.id, actingFixerId: "fixer-A", targetIds: [target.id] }, shakedown, deps);

    expect(result.ok).toBe(false);
    expect(resolver.getProperty("fixer-A", "resources")).toBe(1); // untouched
  });
});

describe("'Dead Drop': what actually happens when the performer no longer exists by the time resolveEffect runs", () => {
  it("an effect that only ever reads ctx.targetIds, on an action with NO performerCondition at all, resolves correctly regardless — the performer vanishing changes nothing it touches. (shakedown itself no longer demonstrates this — see the note below)", () => {
    const { entities, actions, handlers, deps } = makeRig();
    const performer = createCard("Fixer's Contractor", { ownership: ["fixer-A"] });
    const target = createCard("Rival Contractor", { ownership: ["fixer-B"] });
    target.tags.add("contractor");
    entities.add(performer);
    entities.add(target);

    // Deliberately NO performerCondition — Protection's re-validation
    // fix means an action THAT HAS one would now fizzle for a vanished
    // performer (see the next test), so demonstrating this specific
    // claim needs an action that never had anything to re-validate
    // about the performer in the first place.
    const noPerformerConditionAction: ActionDefinition = {
      id: "no-performer-condition",
      category: () => "test",
      targetsOwn: false,
      targetsOthers: true,
      targetQuery: () => ({ op: "hasTag", tag: "contractor" }),
      effect: "tagOnlyEffect",
    };
    actions.register(noPerformerConditionAction);
    handlers.register("tagOnlyEffect", (ctx, api) => {
      api.entities.addTag(ctx.targetIds[0]!, "shaken");
    });

    const intent = { performerId: performer.id, actingFixerId: "fixer-A", targetIds: [target.id] };
    const proposed = proposeAction(intent, noPerformerConditionAction, deps);
    if (!proposed.ok) throw new Error("expected proposal to succeed");

    entities.remove(performer.id); // "Dead Drop": performer discarded before this resolves

    const result = resolveEffect(intent, noPerformerConditionAction, proposed.capability, proposed.adjustedCost, deps);
    expect(result.fizzled).toBe(false);
    expect(target.tags.has("shaken")).toBe(true); // resolved fine — never touched performerId, and nothing re-validated it either
  });

  it("shakedown ITSELF (which DOES have performerCondition) now correctly FIZZLES for a vanished performer instead of resolving — Protection's re-validation fix superseding the old behavior for any action that actually checks the performer's own state", () => {
    const { entities, shakedown, bus, deps } = makeRig();
    const performer = createCard("Fixer's Contractor", { ownership: ["fixer-A"] });
    performer.tags.add("contractor");
    const target = createCard("Rival Contractor", { ownership: ["fixer-B"] });
    target.tags.add("contractor");
    entities.add(performer);
    entities.add(target);

    const intent = { performerId: performer.id, actingFixerId: "fixer-A", targetIds: [target.id] };
    const proposed = proposeAction(intent, shakedown, deps);
    if (!proposed.ok) throw new Error("expected proposal to succeed");

    entities.remove(performer.id);

    const fizzled = vi.fn();
    bus.on("action:fizzled", fizzled);
    const result = resolveEffect(intent, shakedown, proposed.capability, proposed.adjustedCost, deps);

    expect(result).toEqual({ fizzled: true, reason: "performer condition no longer met" });
    expect(target.tags.has("shaken")).toBe(false); // the effect never ran at all
    expect(fizzled).toHaveBeenCalledOnce();
  });

  it("an effect that READS the performer's own property gets undefined (not 0, not a crash, not a stale value) — the honest three-state signal PropertyResolver already gives for 'the entity itself doesn't exist'", () => {
    const { entities, handlers, actions, deps } = makeRig();
    const performer = createCard("Fixer's Contractor", { ownership: ["fixer-A"], properties: { inflow: 7 } });
    entities.add(performer);

    const scalesByPerformer: ActionDefinition = {
      id: "scales-by-performer",
      category: () => "test",
      targetsOwn: true,
      targetsOthers: false,
      targetQuery: () => ({ op: "and", exprs: [] }),
      effect: "scalesByPerformerEffect",
    };
    actions.register(scalesByPerformer);
    let observedInflow: number | undefined = -1; // sentinel — never a real return value
    handlers.register("scalesByPerformerEffect", (ctx: ResolvedActionContext, api: ActionApi) => {
      observedInflow = api.resolver.getProperty(ctx.performerId, "inflow");
    });

    const intent = { performerId: performer.id, actingFixerId: "fixer-A", targetIds: [] };
    const proposed = proposeAction(intent, scalesByPerformer, deps);
    if (!proposed.ok) throw new Error("expected proposal to succeed");

    entities.remove(performer.id); // "Dead Drop"

    resolveEffect(intent, scalesByPerformer, proposed.capability, proposed.adjustedCost, deps);
    expect(observedInflow).toBeUndefined(); // NOT 0 — an author using `?? 0` gets a safe default; one who doesn't guard at all gets undefined, not a silently wrong number
  });

  it("an effect that tries to MUTATE the vanished performer (setProperty/addTag) throws loudly — EntityStore's own mustGet, not a silent no-op", () => {
    const { entities, handlers, actions, deps } = makeRig();
    const performer = createCard("Fixer's Contractor", { ownership: ["fixer-A"] });
    entities.add(performer);

    const tapsItself: ActionDefinition = {
      id: "taps-itself",
      category: () => "test",
      targetsOwn: true,
      targetsOthers: false,
      targetQuery: () => ({ op: "and", exprs: [] }),
      effect: "tapsItselfEffect",
    };
    actions.register(tapsItself);
    handlers.register("tapsItselfEffect", (ctx: ResolvedActionContext, api: ActionApi) => {
      api.entities.addTag(ctx.performerId, "tapped"); // mutates ITSELF, not a target
    });

    const intent = { performerId: performer.id, actingFixerId: "fixer-A", targetIds: [] };
    const proposed = proposeAction(intent, tapsItself, deps);
    if (!proposed.ok) throw new Error("expected proposal to succeed");

    entities.remove(performer.id); // "Dead Drop"

    // loud failure, not silent corruption — an author who assumes the
    // performer still exists finds out immediately, not by way of a
    // mysteriously-never-tapped card three turns later
    expect(() => resolveEffect(intent, tapsItself, proposed.capability, proposed.adjustedCost, deps)).toThrow(/Unknown entity/);
  });
});

describe("'Blackmail': can a cost ever be paid by someone other than the performer?", () => {
  it("NO — definition.cost is hardcoded to deduct from intent.actingFixerId in both validateAction and the deduction step; there is no field or mechanism to redirect it", () => {
    const { entities, resolver, actions, handlers, deps } = makeRig();
    const performer = createCard("Blackmailer", { ownership: ["fixer-A"] });
    const victim = createCard("Blackmailer's Target", { ownership: ["fixer-B"] });
    entities.add(performer);
    entities.add(victim);
    entities.get("fixer-B")!.properties.resources = 10;
    entities.get("fixer-A")!.properties.resources = 0; // performer has NOTHING

    const costsTheTarget: ActionDefinition = {
      id: "costs-the-target",
      category: () => "test",
      targetsOwn: false,
      targetsOthers: true,
      targetQuery: () => ({ op: "and", exprs: [] }),
      cost: () => ({ prop: "resources", amount: 5 }), // this ALWAYS means "actingFixerId pays"
      effect: "noopEffect",
    };
    actions.register(costsTheTarget);
    handlers.register("noopEffect", () => {});

    const intent = { performerId: performer.id, actingFixerId: "fixer-A", targetIds: [victim.id] };
    const result = proposeAction(intent, costsTheTarget, deps);

    // rejected — actingFixerId (fixer-A) is who cost.prop always checks
    // and deducts from, regardless of who's actually being targeted
    expect(result.ok).toBe(false);
  });

  it("YES, if the effect handler does it directly — cost stays undefined/trivial, and the effect itself mutates the TARGET's owner's property. Zero engine change needed; ordinary use of what ActionApi already exposes", () => {
    const { entities, resolver, actions, handlers, deps } = makeRig();
    const performer = createCard("Blackmailer", { ownership: ["fixer-A"] });
    const victim = createCard("Blackmailer's Target", { ownership: ["fixer-B"] });
    entities.add(performer);
    entities.add(victim);
    entities.get("fixer-B")!.properties.resources = 10;
    entities.get("fixer-A")!.properties.resources = 0;

    const blackmail: ActionDefinition = {
      id: "blackmail",
      category: () => "test",
      targetsOwn: false,
      targetsOthers: true,
      targetQuery: () => ({ op: "and", exprs: [] }),
      // NO cost field at all — the performer pays nothing through the
      // standard mechanism
      effect: "blackmailEffect",
    };
    actions.register(blackmail);
    handlers.register("blackmailEffect", (ctx, api) => {
      // derives the target's ACTUAL current owner via the query engine
      // (currentOwner reads the target entity's own ownership stack) —
      // not a hardcoded id. This is the general case: an effect handler
      // has the same full read access to state that any BoolExpr/NumExpr
      // evaluation does, and should be assumed capable of reaching ANY
      // entity reachable that way, not just ctx.targetIds/performerId.
      const target = api.entities.get(ctx.targetIds[0]!)!;
      const targetOwner = currentOwner(target)!;
      const current = api.resolver.getProperty(targetOwner, "resources") ?? 0;
      api.entities.setProperty(targetOwner, "resources", current - 5);
    });

    const intent = { performerId: performer.id, actingFixerId: "fixer-A", targetIds: [victim.id] };
    const result = performAction(intent, blackmail, deps);

    expect(result.ok).toBe(true);
    expect(resolver.getProperty("fixer-A", "resources")).toBe(0); // performer untouched — paid nothing
    expect(resolver.getProperty("fixer-B", "resources")).toBe(5); // the TARGET paid instead
  });
});

describe("'Chain Reaction': can an effect handler autonomously push a new item onto the stack as part of its own resolution?", () => {
  it("NOT DIRECTLY — an effect handler resolving 'Chain Reaction' cannot call stack.push itself (ActionApi has no reference to Stack at all), so it has to tag something as its own effect and let a SEPARATE rule (the 'Reflex' pattern) react to that tag by doing the actual push. Proven end to end, not just asserted", () => {
    const bus = new EventBus();
    const entities = new EntityStore(bus);
    const modifiers = new ModifierStore(bus);
    const resolver = new PropertyResolver(entities, modifiers);
    const random = new SeededRandom(1);
    const hierarchy = new Hierarchy("chain-stack", bus);
    const anchorId = "table";
    entities.add(createCard("Table", { id: anchorId }));
    const stack = new Stack(hierarchy, entities, bus, anchorId);
    const handlers = new EffectHandlerRegistry();
    const actions = new ActionRegistry();
    const deps: PerformActionDeps = { entities, resolver, modifiers, handlers, bus, random };

    // The RULE — this is what makes the chain actually happen. Bound to
    // an ordinary tag, exactly like "Reflex" was.
    let followupPushed = false;
    bus.on("entity:tagAdded", (event) => {
      if (event.tag !== "triggers-followup") return;
      entities.add(createCard("Follow-up", { id: "followup-item" }));
      stack.push("followup-item", null);
      followupPushed = true;
    });

    // The EFFECT — cannot touch Stack directly, only tags something.
    const chainReaction: ActionDefinition = {
      id: "chain-reaction",
      category: () => "test",
      targetsOwn: true,
      targetsOthers: false,
      targetQuery: () => ({ op: "and", exprs: [] }),
      effect: "chainReactionEffect",
    };
    actions.register(chainReaction);
    handlers.register("chainReactionEffect", (ctx, api) => {
      // api has NO api.stack — this is the only kind of thing it CAN do
      // to eventually cause a push: tag something, and trust a rule to
      // pick it up.
      api.entities.addTag(ctx.performerId, "triggers-followup");
    });

    const performer = createCard("Trigger card", { id: "trigger", ownership: ["fixer-A"] });
    entities.add(performer);
    performAction({ performerId: performer.id, actingFixerId: "fixer-A", targetIds: [] }, chainReaction, deps);

    expect(followupPushed).toBe(true);
    expect(stack.leaves()).toEqual(["followup-item"]);
  });
});

describe("'Guilt by Association': an effect can reach entities that were NEVER in ctx.targetIds at all, via the same query engine any BoolExpr already uses", () => {
  it("targets ONE entity explicitly, but its effect uses descendantOf (through api.resolver, which already supports it when constructed with a HierarchyRegistry) to find and debuff every owner in the response chain beneath it — including owners that were never named in the proposal", () => {
    const bus = new EventBus();
    const entities = new EntityStore(bus);
    const modifiers = new ModifierStore(bus);
    const hierarchyRegistry = new HierarchyRegistry();
    const responseHierarchy = new Hierarchy("responses", bus);
    hierarchyRegistry.register(responseHierarchy);
    const resolver = new PropertyResolver(entities, modifiers, undefined, undefined, hierarchyRegistry);
    const handlers = new EffectHandlerRegistry();
    const actions = new ActionRegistry();
    const random = new SeededRandom(1);
    const deps: PerformActionDeps = { entities, resolver, modifiers, handlers, bus, random };

    entities.add(createHand([], { id: "fixer-A", properties: { resources: 10 } }));
    entities.add(createHand([], { id: "fixer-B", properties: { resources: 10 } }));

    // a chain of mixed ownership: root (A) <- child1 (B) <- child2 (A)
    const root = createCard("Root", { id: "root", ownership: ["fixer-A"] });
    const child1 = createCard("Child 1", { id: "child1", ownership: ["fixer-B"] });
    const child2 = createCard("Child 2", { id: "child2", ownership: ["fixer-A"] });
    entities.add(root);
    entities.add(child1);
    entities.add(child2);
    responseHierarchy.setParent("child1", "root");
    responseHierarchy.setParent("child2", "child1");

    const guiltByAssociation: ActionDefinition = {
      id: "guilt-by-association",
      category: () => "test",
      targetsOwn: true,
      targetsOthers: true,
      targetQuery: () => ({ op: "and", exprs: [] }),
      effect: "guiltByAssociationEffect",
    };
    actions.register(guiltByAssociation);
    handlers.register("guiltByAssociationEffect", (ctx, api) => {
      const rootId = ctx.targetIds[0]!;
      // find EVERY entity in the "responses" hierarchy that descends
      // from the explicit target — child1 and child2 were NEVER named
      // in ctx.targetIds, only rootId was
      const implicated = selectEntities({ op: "descendantOf", ancestor: rootId, hierarchy: "responses" }, api.resolver);
      const allImplicated = [api.entities.get(rootId)!, ...implicated];
      for (const entity of allImplicated) {
        const owner = currentOwner(entity)!;
        const current = api.resolver.getProperty(owner, "resources") ?? 0;
        api.entities.setProperty(owner, "resources", current - 1);
      }
    });

    const performer = createCard("Ace", { id: "ace", ownership: ["fixer-A"] });
    entities.add(performer);
    // proposal ONLY names "root" as a target
    performAction({ performerId: performer.id, actingFixerId: "fixer-A", targetIds: ["root"] }, guiltByAssociation, deps);

    // fixer-A owns root AND child2 — debuffed TWICE
    expect(resolver.getProperty("fixer-A", "resources")).toBe(8);
    // fixer-B owns ONLY child1 — debuffed ONCE, despite never being
    // named anywhere in the original proposal at all
    expect(resolver.getProperty("fixer-B", "resources")).toBe(9);
  });
});

describe("'Malfunction': what survives when an effect handler throws PARTWAY through several mutations — no rollback, no transaction guarantee", () => {
  it("mutations made before the throw are permanent — resolveEffect does NOT wrap the handler in any kind of transaction, so a buggy or partially-illegal effect leaves the board in whatever state it reached before failing", () => {
    const { entities, resolver, actions, handlers, deps } = makeRig();
    entities.add(createHand([], { id: "fixer-C", properties: { resources: 10 } }));
    entities.add(createHand([], { id: "fixer-D", properties: { resources: 10 } }));
    const performer = createCard("Malfunctioning Card", { ownership: ["fixer-A"] });
    entities.add(performer);

    const malfunction: ActionDefinition = {
      id: "malfunction",
      category: () => "test",
      targetsOwn: true,
      targetsOthers: true,
      targetQuery: () => ({ op: "and", exprs: [] }),
      effect: "malfunctionEffect",
    };
    actions.register(malfunction);
    handlers.register("malfunctionEffect", (ctx, api) => {
      // three sequential mutations, then a throw — mimicking a real
      // bug (e.g. an unguarded lookup on an entity that doesn't exist)
      // partway through an otherwise-working effect
      api.entities.setProperty("fixer-C", "resources", 3);
      api.entities.addTag("fixer-D", "malfunction-touched");
      throw new Error("simulated bug mid-effect");
      // eslint-disable-next-line no-unreachable
      api.entities.setProperty("fixer-D", "resources", 999); // never reached
    });

    const intent = { performerId: performer.id, actingFixerId: "fixer-A", targetIds: [] };
    expect(() => performAction(intent, malfunction, deps)).toThrow(/simulated bug mid-effect/);

    // the FIRST TWO mutations are permanent — no rollback happened
    expect(resolver.getProperty("fixer-C", "resources")).toBe(3);
    expect(entities.get("fixer-D")?.tags.has("malfunction-touched")).toBe(true);
    // the mutation AFTER the throw correctly never ran
    expect(resolver.getProperty("fixer-D", "resources")).toBe(10); // untouched, unlike the two above
  });

  it("cost was ALREADY deducted before the effect handler ever ran (proposeAction pays cost, resolveEffect only runs the handler) — a mid-effect throw does not refund it either", () => {
    const { entities, resolver, actions, handlers, deps } = makeRig();
    const performer = createCard("Malfunctioning Card", { ownership: ["fixer-A"] });
    entities.add(performer);
    entities.get("fixer-A")!.properties.resources = 10;

    const malfunctionWithCost: ActionDefinition = {
      id: "malfunction-with-cost",
      category: () => "test",
      targetsOwn: true,
      targetsOthers: true,
      targetQuery: () => ({ op: "and", exprs: [] }),
      cost: () => ({ prop: "resources", amount: 4 }),
      effect: "malfunctionWithCostEffect",
    };
    actions.register(malfunctionWithCost);
    handlers.register("malfunctionWithCostEffect", () => {
      throw new Error("simulated bug");
    });

    const intent = { performerId: performer.id, actingFixerId: "fixer-A", targetIds: [] };
    expect(() => performAction(intent, malfunctionWithCost, deps)).toThrow();

    expect(resolver.getProperty("fixer-A", "resources")).toBe(6); // 10 - 4, cost stays paid despite the crash
  });
});

describe("'Protection', fixed: resolveEffect now re-validates legality immediately before running the handler — a fizzle, with an action:fizzled event, not a silent resolve", () => {
  it("a proposal legal at PROPOSE time now correctly FIZZLES if the target becomes illegal in the meantime (loses the tag targetQuery required) — the effect never runs, and action:fizzled fires so other content can react", () => {
    const { entities, actions, handlers, bus, deps } = makeRig();
    const performer = createCard("Fixer's Contractor", { ownership: ["fixer-A"] });
    performer.tags.add("contractor");
    const target = createCard("Rival Contractor", { ownership: ["fixer-B"] });
    target.tags.add("contractor"); // legal at PROPOSE time — targetQuery requires this tag
    entities.add(performer);
    entities.add(target);

    const shakedownLike: ActionDefinition = {
      id: "shakedown-like",
      category: () => "coercion",
      targetsOwn: false,
      targetsOthers: true,
      targetQuery: () => ({ op: "hasTag", tag: "contractor" }),
      effect: "tagTargetEffect2",
    };
    actions.register(shakedownLike);
    handlers.register("tagTargetEffect2", (ctx, api) => {
      api.entities.addTag(ctx.targetIds[0]!, "shaken");
    });

    const intent = { performerId: performer.id, actingFixerId: "fixer-A", targetIds: [target.id] };
    const proposed = proposeAction(intent, shakedownLike, deps);
    expect(proposed.ok).toBe(true);
    if (!proposed.ok) return;

    // "Protection": an intervening response strips the tag that made
    // this a legal target in the first place — simulating a real
    // reactive card responding to the pending shakedown
    target.tags.delete("contractor");

    const fizzled = vi.fn();
    bus.on("action:fizzled", fizzled);
    const result = resolveEffect(intent, shakedownLike, proposed.capability, proposed.adjustedCost, deps);

    expect(result).toEqual({ fizzled: true, reason: 'target "' + target.id + '" is no longer legal' });
    expect(target.tags.has("shaken")).toBe(false); // "Protection" now genuinely protects — the effect never landed
    expect(fizzled).toHaveBeenCalledWith({
      type: "action:fizzled",
      actionId: "shakedown-like",
      performerId: performer.id,
      actingFixerId: "fixer-A",
      targetIds: [target.id],
      reason: 'target "' + target.id + '" is no longer legal',
    });
  });

  it("same fix applies to performerCondition — a proposal legal at propose time now fizzles if the PERFORMER'S OWN legality (not just the target's) changes in the meantime", () => {
    const { entities, actions, handlers, deps } = makeRig();
    const performer = createCard("Fixer's Contractor", { ownership: ["fixer-A"] });
    performer.tags.add("contractor"); // legal at propose time — performerCondition requires this
    const target = createCard("Rival Contractor", { ownership: ["fixer-B"] });
    entities.add(performer);
    entities.add(target);

    const requiresContractorPerformer: ActionDefinition = {
      id: "requires-contractor-performer",
      category: () => "test",
      targetsOwn: false,
      targetsOthers: true,
      targetQuery: () => ({ op: "and", exprs: [] }),
      performerCondition: () => ({ op: "hasTag", tag: "contractor" }),
      effect: "tagTargetEffect3",
    };
    actions.register(requiresContractorPerformer);
    handlers.register("tagTargetEffect3", (ctx, api) => {
      api.entities.addTag(ctx.targetIds[0]!, "affected");
    });

    const intent = { performerId: performer.id, actingFixerId: "fixer-A", targetIds: [target.id] };
    const proposed = proposeAction(intent, requiresContractorPerformer, deps);
    expect(proposed.ok).toBe(true);
    if (!proposed.ok) return;

    // the PERFORMER itself loses the tag that made THEM legal to act at all
    performer.tags.delete("contractor");

    const result = resolveEffect(intent, requiresContractorPerformer, proposed.capability, proposed.adjustedCost, deps);
    expect(result).toEqual({ fizzled: true, reason: "performer condition no longer met" });
    expect(target.tags.has("affected")).toBe(false); // never ran — performerCondition correctly re-checked
  });

  it("cost stays paid even on a fizzle — consistent with Malfunction's own 'no refund' contract, since cost was already deducted at propose time", () => {
    const { entities, resolver, actions, handlers, deps } = makeRig();
    const performer = createCard("Fixer's Contractor", { ownership: ["fixer-A"] });
    performer.tags.add("contractor");
    const target = createCard("Rival Contractor", { ownership: ["fixer-B"] });
    target.tags.add("contractor");
    entities.add(performer);
    entities.add(target);
    entities.get("fixer-A")!.properties.resources = 10;

    const costsToPropose: ActionDefinition = {
      id: "costs-to-propose",
      category: () => "test",
      targetsOwn: false,
      targetsOthers: true,
      targetQuery: () => ({ op: "hasTag", tag: "contractor" }),
      cost: () => ({ prop: "resources", amount: 4 }),
      effect: "noopFizzleEffect",
    };
    actions.register(costsToPropose);
    handlers.register("noopFizzleEffect", () => {});

    const intent = { performerId: performer.id, actingFixerId: "fixer-A", targetIds: [target.id] };
    const proposed = proposeAction(intent, costsToPropose, deps);
    if (!proposed.ok) throw new Error("expected proposal to succeed");
    expect(resolver.getProperty("fixer-A", "resources")).toBe(6); // cost already paid

    target.tags.delete("contractor"); // now illegal — will fizzle

    const result = resolveEffect(intent, costsToPropose, proposed.capability, proposed.adjustedCost, deps);
    expect(result.fizzled).toBe(true);
    expect(resolver.getProperty("fixer-A", "resources")).toBe(6); // still 6 — no refund on fizzle
  });
});

describe("'The Cleaner': a rule can react to action:fizzled however its own game logic wants — proving the actual point of the event, not just that it fires", () => {
  it("a rule bound to action:fizzled can grant a partial consolation refund — one possible game-specific response among many the engine deliberately doesn't prescribe", () => {
    const { entities, resolver, actions, handlers, bus, deps } = makeRig();
    const performer = createCard("Fixer's Contractor", { ownership: ["fixer-A"] });
    performer.tags.add("contractor");
    const target = createCard("Rival Contractor", { ownership: ["fixer-B"] });
    target.tags.add("contractor");
    entities.add(performer);
    entities.add(target);
    entities.get("fixer-A")!.properties.resources = 10;

    const consolationAction: ActionDefinition = {
      id: "consolation-action",
      category: () => "test",
      targetsOwn: false,
      targetsOthers: true,
      targetQuery: () => ({ op: "hasTag", tag: "contractor" }),
      cost: () => ({ prop: "resources", amount: 4 }),
      effect: "consolationEffect",
    };
    actions.register(consolationAction);
    handlers.register("consolationEffect", () => {});

    // "The Cleaner": a rule that reacts to ANY fizzle by refunding HALF
    // the fixer's most recent loss — entirely game-specific logic the
    // engine itself has no opinion about
    bus.on("action:fizzled", (event) => {
      const current = resolver.getProperty(event.actingFixerId, "resources") ?? 0;
      entities.setProperty(event.actingFixerId, "resources", current + 2); // half of the 4 lost
    });

    const intent = { performerId: performer.id, actingFixerId: "fixer-A", targetIds: [target.id] };
    const proposed = proposeAction(intent, consolationAction, deps);
    if (!proposed.ok) throw new Error("expected proposal to succeed");
    expect(resolver.getProperty("fixer-A", "resources")).toBe(6); // 10 - 4

    target.tags.delete("contractor"); // now illegal — will fizzle

    resolveEffect(intent, consolationAction, proposed.capability, proposed.adjustedCost, deps);
    expect(resolver.getProperty("fixer-A", "resources")).toBe(8); // 6 + 2 consolation — entirely the RULE's own doing, not the engine's
  });

  it("a DIFFERENT game could instead tag the fixer with something for other cards to react to — the engine imposes no single fixed meaning for what a fizzle does", () => {
    const { entities, actions, handlers, bus, deps } = makeRig();
    const performer = createCard("Fixer's Contractor", { ownership: ["fixer-A"] });
    performer.tags.add("contractor");
    const target = createCard("Rival Contractor", { ownership: ["fixer-B"] });
    target.tags.add("contractor");
    entities.add(performer);
    entities.add(target);

    const failableAction: ActionDefinition = {
      id: "failable-action",
      category: () => "test",
      targetsOwn: false,
      targetsOthers: true,
      targetQuery: () => ({ op: "hasTag", tag: "contractor" }),
      effect: "failableEffect",
    };
    actions.register(failableAction);
    handlers.register("failableEffect", () => {});

    bus.on("action:fizzled", (event) => {
      entities.addTag(event.actingFixerId, "botched-a-play"); // a completely different design choice than a refund
    });

    const intent = { performerId: performer.id, actingFixerId: "fixer-A", targetIds: [target.id] };
    const proposed = proposeAction(intent, failableAction, deps);
    if (!proposed.ok) throw new Error("expected proposal to succeed");

    target.tags.delete("contractor");
    resolveEffect(intent, failableAction, proposed.capability, proposed.adjustedCost, deps);

    expect(entities.get("fixer-A")?.tags.has("botched-a-play")).toBe(true);
  });
});

describe("'Vanishing Target': a target REMOVED ENTIRELY (not just re-tagged) before resolution — does re-validation handle this gracefully, or crash?", () => {
  it("fizzles cleanly, same as a re-tagged target — selectEntities simply never finds a removed entity, so it's correctly treated as no longer legal, not a special crash case", () => {
    const { entities, actions, handlers, deps } = makeRig();
    const performer = createCard("Fixer's Contractor", { ownership: ["fixer-A"] });
    performer.tags.add("contractor");
    const target = createCard("Rival Contractor", { ownership: ["fixer-B"] });
    target.tags.add("contractor");
    entities.add(performer);
    entities.add(target);

    const vanishingTargetAction: ActionDefinition = {
      id: "vanishing-target-action",
      category: () => "test",
      targetsOwn: false,
      targetsOthers: true,
      targetQuery: () => ({ op: "hasTag", tag: "contractor" }),
      effect: "noopVanishEffect",
    };
    actions.register(vanishingTargetAction);
    handlers.register("noopVanishEffect", () => {});

    const intent = { performerId: performer.id, actingFixerId: "fixer-A", targetIds: [target.id] };
    const proposed = proposeAction(intent, vanishingTargetAction, deps);
    if (!proposed.ok) throw new Error("expected proposal to succeed");

    entities.remove(target.id); // discarded entirely, not just re-tagged

    const result = resolveEffect(intent, vanishingTargetAction, proposed.capability, proposed.adjustedCost, deps);
    expect(result).toEqual({ fizzled: true, reason: `target "${target.id}" is no longer legal` });
  });
});

describe("'Defector': does re-validation's OWNERSHIP re-check work, not just targetQuery's own tag checks?", () => {
  it("a target legally owned by the opponent at propose time, whose ownership transfers to the PERFORMER'S OWN fixer before resolution, now fails the targetsOthers check and fizzles — even though it still passes targetQuery's own tag requirement", () => {
    const { entities, actions, handlers, deps } = makeRig();
    const performer = createCard("Fixer's Contractor", { ownership: ["fixer-A"] });
    performer.tags.add("contractor");
    const target = createCard("Rival Contractor", { ownership: ["fixer-B"] }); // legal: owned by the OTHER fixer
    target.tags.add("contractor");
    entities.add(performer);
    entities.add(target);

    const targetsOthersOnly: ActionDefinition = {
      id: "targets-others-only",
      category: () => "test",
      targetsOwn: false,
      targetsOthers: true,
      targetQuery: () => ({ op: "hasTag", tag: "contractor" }), // still true after the defection — tag never changes
      effect: "noopDefectorEffect",
    };
    actions.register(targetsOthersOnly);
    handlers.register("noopDefectorEffect", () => {});

    const intent = { performerId: performer.id, actingFixerId: "fixer-A", targetIds: [target.id] };
    const proposed = proposeAction(intent, targetsOthersOnly, deps);
    if (!proposed.ok) throw new Error("expected proposal to succeed");

    // "Defector": the target's OWNERSHIP transfers to the performer's
    // OWN fixer — targetQuery's tag check is untouched, but ownership
    // re-validation must still catch this
    target.ownership = transferOwnership(target, "fixer-A");

    const result = resolveEffect(intent, targetsOthersOnly, proposed.capability, proposed.adjustedCost, deps);
    expect(result).toEqual({ fizzled: true, reason: `target "${target.id}" is now owned by the performer's own fixer` });
  });
});

describe("re-validation checks EVERY target, not just the first one", () => {
  it("with two targets, the SECOND one becoming illegal still triggers a fizzle — re-validation doesn't stop checking after the first target passes", () => {
    const { entities, actions, handlers, deps } = makeRig();
    const performer = createCard("Fixer's Contractor", { ownership: ["fixer-A"] });
    performer.tags.add("contractor");
    const targetA = createCard("Still legal", { ownership: ["fixer-B"] });
    targetA.tags.add("contractor");
    const targetB = createCard("Becomes illegal", { ownership: ["fixer-B"] });
    targetB.tags.add("contractor");
    entities.add(performer);
    entities.add(targetA);
    entities.add(targetB);

    const multiTargetAction: ActionDefinition = {
      id: "multi-target-action",
      category: () => "test",
      targetsOwn: false,
      targetsOthers: true,
      targetQuery: () => ({ op: "hasTag", tag: "contractor" }),
      minTargets: () => 2,
      maxTargets: () => 2,
      effect: "noopMultiEffect",
    };
    actions.register(multiTargetAction);
    handlers.register("noopMultiEffect", () => {});

    const intent = { performerId: performer.id, actingFixerId: "fixer-A", targetIds: [targetA.id, targetB.id] };
    const proposed = proposeAction(intent, multiTargetAction, deps);
    if (!proposed.ok) throw new Error("expected proposal to succeed");

    // only the SECOND target becomes illegal — the first stays fully legal
    targetB.tags.delete("contractor");

    const result = resolveEffect(intent, multiTargetAction, proposed.capability, proposed.adjustedCost, deps);
    expect(result).toEqual({ fizzled: true, reason: `target "${targetB.id}" is no longer legal` });
  });
});


describe("'Surveillance State': can a targetQuery itself (not just an effect, after the fact) reach the resolution hierarchy's current shape — legality gated on what's pending, checked at VALIDATION time", () => {
  it("YES — targetQuery and an effect handler are evaluated against the exact same resolver reference, so a proposal can be rejected outright for targeting something whose relationship to a KNOWN pending item disqualifies it, before anything is even accepted", () => {
    const bus = new EventBus();
    const entities = new EntityStore(bus);
    const modifiers = new ModifierStore(bus);
    const hierarchyRegistry = new HierarchyRegistry();
    const responseHierarchy = new Hierarchy("responses", bus);
    hierarchyRegistry.register(responseHierarchy);
    const resolver = new PropertyResolver(entities, modifiers, undefined, undefined, hierarchyRegistry);
    const handlers = new EffectHandlerRegistry();
    const actions = new ActionRegistry();
    const random = new SeededRandom(1);
    const deps: PerformActionDeps = { entities, resolver, modifiers, handlers, bus, random };

    entities.add(createCard("Root proposal", { id: "root" }));
    entities.add(createCard("Response to root", { id: "response-to-root" }));
    entities.add(createCard("Unrelated card", { id: "unrelated" }));
    entities.add(createCard("Performer", { id: "performer", ownership: ["fixer-A"] }));
    responseHierarchy.setParent("response-to-root", "root"); // currently responding to "root"

    // "Surveillance State": legal ONLY against something that's
    // CURRENTLY part of the response chain under "root" — a targeting
    // restriction gated on live pending structure, not just tags/props
    const onlyWithinTheChain: ActionDefinition = {
      id: "only-within-the-chain",
      category: () => "test",
      targetsOwn: true,
      targetsOthers: true,
      targetQuery: () => ({ op: "descendantOf", ancestor: "root", hierarchy: "responses" }),
      effect: "noopSurveillanceEffect",
    };
    actions.register(onlyWithinTheChain);
    handlers.register("noopSurveillanceEffect", () => {});

    const legalAttempt = proposeAction(
      { performerId: "performer", actingFixerId: "fixer-A", targetIds: ["response-to-root"] },
      onlyWithinTheChain,
      deps,
    );
    expect(legalAttempt.ok).toBe(true); // "response-to-root" IS currently part of the chain

    const illegalAttempt = proposeAction(
      { performerId: "performer", actingFixerId: "fixer-A", targetIds: ["unrelated"] },
      onlyWithinTheChain,
      deps,
    );
    expect(illegalAttempt.ok).toBe(false); // rejected at VALIDATION — never even accepted as a proposal
  });

  it("the REVERSE direction — 'nothing currently responds to me' — is NOT directly expressible the same way, confirmed by actually attempting it: childOf/descendantOf only check whether the CANDIDATE descends from a KNOWN reference point, never whether something else descends from the candidate. Expressing the reverse needs a fold whose where clause references the outer candidate as a label — but the top-level targetQuery subject is never automatically bound to one, so the attempt throws exactly the unbound-label error this engine already uses for that case", () => {
    const bus = new EventBus();
    const entities = new EntityStore(bus);
    const modifiers = new ModifierStore(bus);
    const hierarchyRegistry = new HierarchyRegistry();
    const responseHierarchy = new Hierarchy("responses", bus);
    hierarchyRegistry.register(responseHierarchy);
    const resolver = new PropertyResolver(entities, modifiers, undefined, undefined, hierarchyRegistry);
    entities.add(createCard("Root proposal", { id: "root" }));
    entities.add(createCard("Response to root", { id: "response-to-root" }));
    responseHierarchy.setParent("response-to-root", "root");

    // the attempted (and NOT directly expressible) query: "count entities
    // whose parent is ME" — referencing a label ("me") that nothing at
    // this level ever binds
    const nothingRespondsToMe: BoolExpr = {
      op: "compare",
      left: { op: "fold", fold: "count", where: { op: "childOf", parent: { op: "ref", label: "me" }, hierarchy: "responses" } },
      cmp: "eq",
      right: { op: "lit", value: 0 },
    };

    expect(() => evaluateBoolExpr(nothingRespondsToMe, "root", resolver)).toThrow(/ref to unbound label "me"/);
  });
});

describe("'Wiretap': api.pendingActions gives an effect handler a real, working reference into another pending action's own intent — the actual capability the PendingActionRegistry-in-buildContent refactor was for", () => {
  it("an effect handler reads a DIFFERENT pending action's own targetIds via api.pendingActions and acts on the revealed target — something no BoolExpr/NumExpr query could ever express, since PendingAction.definition has live function fields", () => {
    const bus = new EventBus();
    const entities = new EntityStore(bus);
    const modifiers = new ModifierStore(bus);
    const resolver = new PropertyResolver(entities, modifiers);
    const handlers = new EffectHandlerRegistry();
    const actions = new ActionRegistry();
    const random = new SeededRandom(1);
    const pendingActions = new PendingActionRegistry();
    const deps: PerformActionDeps = { entities, resolver, modifiers, handlers, bus, random, pendingActions };

    entities.add(createCard("Ace", { id: "ace", ownership: ["fixer-A"] }));
    entities.add(createCard("Target of the shakedown", { id: "target-a", ownership: ["fixer-B"] }));
    entities.add(createCard("Data Broker", { id: "broker", ownership: ["fixer-C"] }));

    // simulates an already-proposed, still-pending shakedown that a
    // real room's own proposeAndPush would have created
    const shakedownDefinition: ActionDefinition = { id: "shakedown", category: () => "coercion", targetsOwn: false, targetsOthers: true, targetQuery: () => ({ op: "and", exprs: [] }), effect: "noopShakedownEffect" };
    pendingActions.set("pending-shakedown", {
      intent: { performerId: "ace", actingFixerId: "fixer-A", targetIds: ["target-a"] },
      actionId: "shakedown",
      definition: shakedownDefinition,
      capability: "preferred",
      adjustedCost: 2,
    });

    const wiretap: ActionDefinition = {
      id: "wiretap",
      category: () => "data",
      targetsOwn: true,
      targetsOthers: true,
      targetQuery: () => ({ op: "and", exprs: [] }),
      effect: "wiretapEffect",
    };
    actions.register(wiretap);
    handlers.register("wiretapEffect", (_ctx, api) => {
      const revealed = api.pendingActions?.get("pending-shakedown");
      if (!revealed) throw new Error("expected to find the pending shakedown");
      for (const targetId of revealed.intent.targetIds) {
        api.entities.addTag(targetId, "exposed-by-wiretap");
      }
    });

    performAction({ performerId: "broker", actingFixerId: "fixer-C", targetIds: [] }, wiretap, deps);

    expect(entities.get("target-a")?.tags.has("exposed-by-wiretap")).toBe(true);
  });

  it("is undefined, not a throw, when deps was constructed without a PendingActionRegistry at all — the overwhelming majority of existing tests, and every game that doesn't do interactive propose-now-resolve-later play", () => {
    const { deps, actions, handlers } = makeRig();
    const noRegistryAction: ActionDefinition = { id: "no-registry-action", category: () => "test", targetsOwn: true, targetsOthers: true, targetQuery: () => ({ op: "and", exprs: [] }), effect: "checksForRegistryEffect" };
    actions.register(noRegistryAction);
    let observedPendingActions: unknown = "sentinel — never a real value";
    handlers.register("checksForRegistryEffect", (_ctx, api) => {
      observedPendingActions = api.pendingActions;
    });
    const performer = createCard("Performer", { ownership: ["fixer-A"] });
    deps.entities.add(performer);
    performAction({ performerId: performer.id, actingFixerId: "fixer-A", targetIds: [] }, noRegistryAction, deps);
    expect(observedPendingActions).toBeUndefined();
  });
});
