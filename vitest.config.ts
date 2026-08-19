import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 15_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
    },
  },
})
