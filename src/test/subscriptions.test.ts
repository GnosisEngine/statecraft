import { describe, expect, it, vi } from "vitest";
import { extractNumExprDependencies } from "../query/interpreter.ts";
import { SubscriptionRegistry } from "../query/subscriptions.ts";
import type { NumExpr } from "../query/types.ts";

describe("SubscriptionRegistry", () => {
  it("fires only subscriptions whose deps intersect the change", () => {
    const registry = new SubscriptionRegistry();

    const inflowAgg: NumExpr = { op: "fold", fold: "sum", of: { op: "prop", name: "inflow" }, where: { op: "hasTag", tag: "contractor" } };
    const deps = extractNumExprDependencies(inflowAgg);

    const inflowCallback = vi.fn();
    const unrelatedCallback = vi.fn();

    registry.subscribe(deps, inflowCallback);
    registry.subscribe(new Set(["prop:reputation"]), unrelatedCallback);

    registry.notify([{ kind: "tag", tag: "contractor" }]);

    expect(inflowCallback).toHaveBeenCalledTimes(1);
    expect(unrelatedCallback).not.toHaveBeenCalled();
  });

  it("unsubscribe stops future notifications", () => {
    const registry = new SubscriptionRegistry();
    const callback = vi.fn();
    const sub = registry.subscribe(new Set(["prop:inflow"]), callback);

    registry.notify([{ kind: "prop", prop: "inflow" }]);
    expect(callback).toHaveBeenCalledTimes(1);

    sub.unsubscribe();
    registry.notify([{ kind: "prop", prop: "inflow" }]);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(registry.size).toBe(0);
  });
});
