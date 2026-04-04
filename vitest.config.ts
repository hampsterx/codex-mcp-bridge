import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: [
      "tests/integration/**",
      "node_modules",
      "dist",
    ],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
    },
  },
});
