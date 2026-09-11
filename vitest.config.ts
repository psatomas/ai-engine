import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "packages/*/test/**/*.test.ts", "extensions/*/src/**/*.test.ts"],
    environment: "node",
    reporters: "default",
    passWithNoTests: false
  }
});
