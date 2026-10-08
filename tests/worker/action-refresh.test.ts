import { existsSync } from "node:fs";
import { test } from "vitest";
import { chromium, expect } from "@playwright/test";
import { createTestHarness } from "wrangler";

for (const failFirst of [false, true]) {
  test(`overlapping signup refreshes stay ordered${failFirst ? " after a failed refresh" : ""}`, async () => {
    const origin = "https://afterhoursoutreach.ca";
    const server = createTestHarness({
      workers: [
        {
          configPath: "dist/server/wrangler.json",
          vars: { APP_ENV: "production", AUTH_BASE_URL: origin },
          secrets: {
            BETTER_AUTH_SECRET:
              "action-refresh-test-secret-12345678901234567890",
            RESEND_API_KEY: "",
          },
        },
      ],
    });
    const browser = await chromium.launch({
      executablePath:
        process.env.CHROMIUM_PATH ??
        (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined),
    });
    try {
      await server.listen();
      const worker = server.getWorker<Env>();
      await worker.applyD1Migrations("DB");
      const page = await browser.newPage();
      await page.route("**/*", async (route) => {
        const request = route.request();
        if (!request.url().startsWith(origin)) return route.abort();
        const response = await worker.fetch(request.url(), {
          headers: await request.allHeaders(),
        });
        await route.fulfill({
          status: response.status,
          headers: Object.fromEntries(response.headers),
          body: Buffer.from(await response.arrayBuffer()),
        });
      });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const signedUp = new Set<string>();
      const listing = () => `
    <section data-event-browser>
      <ul data-event-list>
        ${["first", "second"]
          .map(
            (id) => `
          <li data-live-event="${id}" data-event-type="orientation">
            <h3>${id} event</h3>
            ${signedUp.has(id) ? '<span class="volunteer-badge">Signed up</span>' : ""}
            <form data-live-signup>
              <input type="hidden" name="id" value="${id}" />
              <input type="hidden" name="action" value="${signedUp.has(id) ? "cancel" : "join"}" />
              <button type="submit" data-loading-label="Saving…">${signedUp.has(id) ? "Cancel my spot" : "Sign up"}</button>
              <p data-form-message hidden></p>
            </form>
          </li>`,
          )
          .join("")}
      </ul>
      <p data-empty-events hidden></p>
      <p data-event-limit hidden></p>
    </section>`;
      // Exercise the production client script with an isolated database and controlled responses.
      await page.goto(`${origin}/volunteer`);
      await expect(page.locator("[data-event-browser]")).toBeVisible();
      await page.evaluate((html) => {
        const parsed = new DOMParser().parseFromString(html, "text/html");
        document
          .querySelector("[data-event-browser]")!
          .replaceChildren(
            ...parsed.querySelector("[data-event-browser]")!.childNodes,
          );
      }, listing());
      await page.route("**/api/events/action", async (route) => {
        signedUp.add(route.request().postDataJSON().id);
        await route.fulfill({ json: { message: "Your spot is confirmed." } });
      });
      let release!: () => void;
      const firstRefresh = new Promise<void>((resolve) => {
        release = resolve;
      });
      let refreshes = 0;
      let pending = 0;
      let maxPending = 0;
      await page.route("**/volunteer", async (route) => {
        const body = listing();
        const index = ++refreshes;
        maxPending = Math.max(maxPending, ++pending);
        if (index === 1) await firstRefresh;
        await route.fulfill({
          status: failFirst && index === 1 ? 503 : 200,
          contentType: "text/html",
          body,
        });
        pending--;
      });
      try {
        const first = page.locator('[data-live-event="first"]');
        const second = page.locator('[data-live-event="second"]');
        await first
          .getByRole("button", { name: "Sign up", exact: true })
          .click();
        await expect.poll(() => refreshes).toBe(1);
        const secondSaved = page.waitForResponse(
          (response) =>
            response.url().endsWith("/api/events/action") &&
            response.request().postDataJSON().id === "second",
        );
        await second
          .getByRole("button", { name: "Sign up", exact: true })
          .click();
        await secondSaved;
        // Allow the resolved POST to reach its refresh while the first GET is held.
        await page.evaluate(
          () =>
            new Promise<void>((resolve) =>
              requestAnimationFrame(() =>
                requestAnimationFrame(() => resolve()),
              ),
            ),
        );
        release();
        for (const card of [first, second]) {
          await expect(
            card.getByText("Signed up", { exact: true }),
          ).toBeVisible();
          await expect(
            card.getByRole("button", { name: "Cancel my spot", exact: true }),
          ).toBeEnabled();
        }
        expect(refreshes).toBe(2);
        expect(maxPending).toBe(1);
        expect(errors).toEqual([]);
      } finally {
        release();
      }
    } finally {
      await browser.close();
      await server.close();
    }
  });
}
