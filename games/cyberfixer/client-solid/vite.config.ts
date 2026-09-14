import { defineConfig } from "vite";
import solidPlugin from "vite-plugin-solid";

// This client deliberately imports large parts of the SERVER's own
// src/ tree directly (the query evaluator, core entity helpers, shared
// types) — see src/sdk/entity-view.ts's header for why. Vite/esbuild
// bundle plain relative TS imports fine regardless of which
// package.json they happen to live under; nothing special is needed
// here to allow it, since it's all one filesystem/one repo.
export default defineConfig({
  plugins: [solidPlugin()],
  server: {
    port: 5173,
  },
  build: {
    target: "esnext",
  },
});
