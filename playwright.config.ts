import { defineConfig } from "@playwright/test";
import { existsSync } from "node:fs";
import { playwrightTarget } from "./scripts/ui-test-target.mjs";

const baseURL = playwrightTarget();

export default defineConfig({
  testDir: "./tests/ui",
  outputDir: "./test-results/playwright",
  testMatch: baseURL.startsWith("https://")
    ? "deployed-site.spec.ts"
    : "**/*.spec.ts",
  fullyParallel: true,
  use: {
    baseURL,
    browserName: "chromium",
    launchOptions: {
      executablePath:
        process.env.CHROMIUM_PATH ??
        (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined),
    },
    trace: "retain-on-failure",
  },
});
