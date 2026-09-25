import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["tests/companion/**/*.test.ts"], testTimeout: 30_000 },
});
