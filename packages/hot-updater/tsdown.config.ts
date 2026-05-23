import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    config: "./src/config.ts",
    index: "./src/index.ts",
    "commands/index": "./src/commands/index.ts",
  },
  deps: {
    neverBundle: ["@expo/fingerprint"],
    onlyBundle: false,
  },
  exports: {
    bin: {
      "hot-updater": "./src/index.ts",
    },
    customExports: {
      ".": {
        types: "./dist/config.d.mts",
        import: "./dist/config.mjs",
        require: "./dist/config.mjs",
      },
      "./internal/commands": {
        types: "./dist/commands/index.d.mts",
        import: "./dist/commands/index.mjs",
        require: "./dist/commands/index.mjs",
      },
    },
    exclude: ["index"],
    inlinedDependencies: true,
    legacy: true,
  },
  format: ["esm"],
  outDir: "dist",
  dts: true,
  failOnWarn: true,
  shims: true,
});
