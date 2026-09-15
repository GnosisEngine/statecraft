import { describe, expect, it } from "vitest";
import { namespacedTag } from "./tags.ts";

describe("namespacedTag", () => {
  it("joins namespace and id with a colon", () => {
    expect(namespacedTag("ability", "shakedown")).toBe("ability:shakedown");
    expect(namespacedTag("faction", "corporations")).toBe("faction:corporations");
  });

  it("works for any namespace a game chooses — not a closed, hardcoded set", () => {
    expect(namespacedTag("domain", "financial")).toBe("domain:financial");
    expect(namespacedTag("family", "boardroom")).toBe("family:boardroom");
    expect(namespacedTag("kind", "escrow")).toBe("kind:escrow");
  });
});
