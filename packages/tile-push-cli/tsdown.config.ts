import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    index: "./src/index.ts",
    "bin/tile-push": "./bin/tile-push.ts",
  },
  format: ["esm", "cjs"],
  outDir: "dist",
  dts: true,
  // Wrapper-style CLI — depend on hot-updater + its sub-packages at runtime;
  // don't pull their entire trees into our bundle. Everything else
  // (commander, picocolors, open + transitive deps) gets bundled so the CLI
  // ships as a self-contained binary that doesn't fight with the customer's
  // existing node_modules layout.
  deps: {
    neverBundle: [
      "hot-updater",
      "@hot-updater/plugin-core",
      "@hot-updater/cli-tools",
    ],
    onlyBundle: false,
  },
  exports: {
    bin: {
      "tile-push": "./bin/tile-push.ts",
    },
    inlinedDependencies: true,
    legacy: true,
  },
});
