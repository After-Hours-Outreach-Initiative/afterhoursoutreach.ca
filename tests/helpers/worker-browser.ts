import { chromium, type Browser } from "@playwright/test";
import { existsSync } from "node:fs";

/** Chromium for the built Worker tests. Reduced motion turns off page
 * transitions, which Chromium reports as errors whenever it skips one. */
export async function launchWorkerBrowser(): Promise<Browser> {
  const browser = await chromium.launch({
    executablePath:
      process.env.CHROMIUM_PATH ??
      (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined),
  });
  const newContext = browser.newContext.bind(browser);
  browser.newContext = (options) =>
    newContext({ reducedMotion: "reduce", ...options });
  const newPage = browser.newPage.bind(browser);
  browser.newPage = (options) =>
    newPage({ reducedMotion: "reduce", ...options });
  return browser;
}
