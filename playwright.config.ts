import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  workers: 1,
  retries: 0,
  reporter: process.env.CI ? [["list"], ["github"]] : "list",
  use: { trace: "off", screenshot: "only-on-failure" },
});
