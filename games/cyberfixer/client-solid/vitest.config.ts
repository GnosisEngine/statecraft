import { defineConfig } from "vitest/config";

// Framework-agnostic SDK logic (src/sdk/) needs no DOM at all — plain
// node environment. If Solid COMPONENT tests are ever added, those
// specifically would need jsdom + @solidjs/testing-library, but that's
// a separate, heavier dependency this first pass doesn't need.
export default defineConfig({
  test: {
    environment: "node",
  },
});
