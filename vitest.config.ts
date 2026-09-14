import { defineConfig } from "vitest/config";

// games/*/client-solid is a genuinely separate package (own package.json,
// own node_modules, own vitest config) — it happening to also run
// correctly under the ROOT vitest command is an accident of how Node
// resolves node_modules by walking up from the importing file, not a
// real integration. Excluded here deliberately, so the root suite never
// implicitly depends on a client package's node_modules existing.
export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/client-solid/**"],
  },
});
