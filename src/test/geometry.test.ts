import { describe, expect, it } from "vitest";
import { createZone } from "../core/entity.ts";
import { distanceBetween, entitiesWithinRange } from "../core/geometry.ts";

describe("distanceBetween", () => {
  it("chebyshev counts diagonal moves as distance 1 (a king's move)", () => {
    expect(distanceBetween({ x: 0, y: 0 }, { x: 1, y: 1 }, "chebyshev")).toBe(1);
    expect(distanceBetween({ x: 0, y: 0 }, { x: 3, y: 1 }, "chebyshev")).toBe(3);
  });

  it("manhattan counts diagonal moves as distance 2 (orthogonal only, a rook's move)", () => {
    expect(distanceBetween({ x: 0, y: 0 }, { x: 1, y: 1 }, "manhattan")).toBe(2);
    expect(distanceBetween({ x: 0, y: 0 }, { x: 3, y: 1 }, "manhattan")).toBe(4);
  });

  it("hex uses cube coordinates (max of the three axis deltas)", () => {
    expect(distanceBetween({ x: 1, y: -1, z: 0 }, { x: -1, y: 0, z: 1 }, "hex")).toBe(2);
    expect(distanceBetween({ x: 0, y: 0 }, { x: 0, y: 0 }, "hex")).toBe(0);
  });

  it("defaults to chebyshev when no metric is given", () => {
    expect(distanceBetween({ x: 0, y: 0 }, { x: 2, y: 2 })).toBe(2);
  });
});

describe("entitiesWithinRange", () => {
  it("returns only entities within maxDistance, reading x/y straight off properties", () => {
    const near = createZone({}, { id: "near", properties: { x: 1, y: 0 } });
    const far = createZone({}, { id: "far", properties: { x: 5, y: 5 } });
    const exact = createZone({}, { id: "exact", properties: { x: 0, y: 1 } });

    const result = entitiesWithinRange([near, far, exact], { x: 0, y: 0 }, 1);
    expect(result.sort()).toEqual(["exact", "near"]);
  });

  it("treats a missing x/y/z as 0", () => {
    const origin = createZone({}, { id: "origin" }); // no position properties at all
    const result = entitiesWithinRange([origin], { x: 0, y: 0 }, 0);
    expect(result).toEqual(["origin"]);
  });
});
