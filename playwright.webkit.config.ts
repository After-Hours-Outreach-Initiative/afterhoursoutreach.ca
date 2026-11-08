import { defineConfig, devices } from "@playwright/test";
import config from "./playwright.config";

// Opt-in iPhone-engine coverage: pnpm test:ui -c playwright.webkit.config.ts
export default defineConfig(config, {
  testMatch: "directory-table-header.spec.ts",
  outputDir: "./test-results/playwright-webkit",
  use: {
    ...devices["iPhone 13"],
    browserName: "webkit",
    launchOptions: { executablePath: process.env.WEBKIT_PATH },
  },
});
