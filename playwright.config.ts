import { defineConfig } from "@playwright/test";
import { existsSync } from "node:fs";
import { serialTarget, playwrightTarget } from "./scripts/ui-test-target.mjs";

const baseURL = playwrightTarget();
const deployed = baseURL.startsWith("https://");
const browserName =
  process.env.PLAYWRIGHT_BROWSER === "webkit" ? "webkit" : "chromium";
// Tests tagged with this need the seeded fixtures alone or a quiet machine.
const serial = /@serial/;

export default defineConfig({
  testDir: "./tests/ui",
  outputDir: "./test-results/playwright",
  testMatch: deployed ? "deployed-site.spec.ts" : "**/*.spec.ts",
  fullyParallel: true,
  // Beyond this, the shared dev server falls behind and timed steps fail.
  workers: 6,
  use: {
    baseURL,
    browserName,
    launchOptions:
      browserName === "chromium"
        ? {
            executablePath:
              process.env.CHROMIUM_PATH ??
              (existsSync("/usr/bin/chromium")
                ? "/usr/bin/chromium"
                : undefined),
          }
        : {},
    trace: "retain-on-failure",
  },
  projects: deployed
    ? [{ name: "deployed" }]
    : [
        { name: "shared", grepInvert: serial },
        {
          name: "serial",
          grep: serial,
          // One at a time on a separate server, so the parallel run neither
          // changes what these tests count nor delays their timed steps.
          workers: 1,
          use: { baseURL: serialTarget() },
        },
      ],
});
