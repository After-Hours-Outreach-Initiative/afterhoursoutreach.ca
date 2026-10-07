import {
  expect,
  type Locator,
  type Page,
  type Request,
  type Route,
} from "@playwright/test";

/** Exercise a real mutation while checking loading, duplicate protection and no navigation. */
export async function inPlaceAction(
  page: Page,
  options: {
    endpoint: string;
    form: Locator;
    trigger: () => Promise<unknown>;
    updated: () => Promise<unknown>;
    loadingLabel: string;
    notify?: boolean;
    pending?: () => Promise<unknown>;
  },
) {
  const documents: string[] = [];
  const recordDocument = (request: Request) => {
    if (request.resourceType() === "document") documents.push(request.url());
  };
  const documentId = crypto.randomUUID();
  await page.evaluate((id) => {
    document.documentElement.dataset.testDocument = id;
  }, documentId);
  page.on("request", recordDocument);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let submissions = 0;
  const pause = async (route: Route) => {
    submissions++;
    await gate;
    await route.fallback();
  };
  const pattern = `**${options.endpoint}*`;
  await page.route(pattern, pause);
  try {
    const emailPrompt = await options.form.getAttribute("data-email-prompt");
    await options.trigger();
    if (emailPrompt) {
      const choice = page.getByRole("dialog", {
        name: "Send an email?",
        exact: true,
      });
      await expect(choice).toBeVisible();
      expect(submissions).toBe(0);
      await expect(
        choice.getByRole("button", { name: "Save without email", exact: true }),
      ).toBeFocused();
      await choice
        .getByRole("button", {
          name: options.notify ? "Save and send email" : "Save without email",
          exact: true,
        })
        .click();
    }
    await expect(options.form).toHaveAttribute("aria-busy", "true");
    const loading = options.form
      .locator('button[aria-busy="true"], [data-action-loading]:visible')
      .first();
    await expect(loading).toBeVisible();
    await expect(loading).toHaveText(options.loadingLabel);
    expect(
      await loading.evaluate(
        (element) => getComputedStyle(element, "::before").animationName,
      ),
    ).toBe("volunteer-loading");
    await expect.poll(() => submissions).toBe(1);
    await options.pending?.();
    await options.form.evaluate((element) =>
      (element as HTMLFormElement).requestSubmit(),
    );
    release();
    await options.updated();
    expect(submissions).toBe(1);
    expect(documents).toEqual([]);
    expect(
      await page.evaluate(() => document.documentElement.dataset.testDocument),
    ).toBe(documentId);
  } finally {
    release();
    page.off("request", recordDocument);
    await page.unroute(pattern, pause);
  }
}
