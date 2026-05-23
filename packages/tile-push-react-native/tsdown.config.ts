import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  // Wrapper-style package — depend on the host's installed peers, don't bundle them.
  deps: {
    neverBundle: ["@hot-updater/react-native", "react", "react-native"],
  },
});
