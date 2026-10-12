import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "ubuntu-installation.acceptance.spec.ts",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  timeout: 900_000,
  expect: { timeout: 20_000 },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  use: {
    ...devices["Desktop Chrome"],
    baseURL: "https://127.0.0.1:3444",
    ignoreHTTPSErrors: true,
    trace: "retain-on-failure"
  }
});
