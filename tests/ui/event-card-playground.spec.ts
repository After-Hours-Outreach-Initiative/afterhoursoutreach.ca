import { expect, test } from "@playwright/test";

test("event card previews fit their content without phantom scrollbars", async ({
  page,
  baseURL,
}) => {
  test.skip(
    !baseURL?.startsWith("http://"),
    "The playground is development-only.",
  );
  await page.goto("/dev/ui/event-card");
  const frames = page.locator("[data-ui-event-frame]");
  await expect(frames).toHaveCount(8);
  const expectNoOverflow = async () => {
    await expect
      .poll(() =>
        frames.evaluateAll((elements) =>
          elements.map((element) => {
            const frame = element as HTMLIFrameElement;
            const document = frame.contentDocument;
            if (!document?.querySelector("[data-ui-event-preview]"))
              return null;
            return {
              vertical:
                document.documentElement.scrollHeight -
                document.documentElement.clientHeight,
              horizontal:
                document.documentElement.scrollWidth -
                document.documentElement.clientWidth,
            };
          }),
        ),
      )
      .toEqual(
        Array.from({ length: 8 }, () => ({ vertical: 0, horizontal: 0 })),
      );
  };
  await expectNoOverflow();
  const width = page.getByRole("combobox", { name: "Preview width" });
  const rosters = page.getByRole("checkbox", { name: "Expand all rosters" });
  for (const size of ["320", "375", "768", "fit"]) {
    await width.selectOption(size);
    for (const expanded of [true, false]) {
      await rosters.setChecked(expanded);
      await expectNoOverflow();
    }
  }
  for (const viewport of [375, 320]) {
    await page.setViewportSize({ width: viewport, height: 812 });
    await expectNoOverflow();
  }
});

test("event card playground shows varied real rosters, resizes, and simulates registrations without APIs", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(60_000);
  test.skip(
    !baseURL?.startsWith("http://"),
    "The playground exists only in local development.",
  );
  const origin = new URL(baseURL!).origin;
  const forbidden: string[] = [];
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin || url.pathname.startsWith("/api/v1")) {
      forbidden.push(url.href);
      await route.abort();
    } else {
      await route.continue();
    }
  });
  await page.goto("/dev/ui/event-card");
  const previewResponse = await page.request.get(
    "/dev/ui/event-card/preview?scenario=full",
  );
  expect(previewResponse.headers()["content-security-policy"]).toBe(
    "form-action 'none'",
  );
  await expect(
    page.getByRole("link", { name: "Event card", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await expect(page.locator("[data-ui-event-frame]")).toHaveCount(8);
  const samples = page.locator("[data-ui-avatar-style]");
  await expect(samples).toHaveCount(4);
  for (const style of ["dot", "outline", "gradient", "gradient-horizontal"]) {
    const option = page.locator(`[data-ui-avatar-style="${style}"]`);
    for (const avatar of await option.locator(".attendee-avatar").all()) {
      await expect(avatar).toHaveCSS("color", "rgb(65, 105, 225)");
      await expect(avatar.locator("[data-avatar-outline]")).toHaveCount(0);
      const gradient = avatar.locator("linearGradient");
      if (await gradient.count()) {
        const gradientId = await gradient.getAttribute("id");
        await expect(avatar.locator("svg > circle")).toHaveAttribute(
          "fill",
          `url(#${gradientId})`,
        );
        await expect(avatar.locator("svg > path").first()).toHaveAttribute(
          "fill",
          `url(#${gradientId})`,
        );
        await expect(gradient.locator("stop").first()).toHaveCSS(
          "stop-color",
          "rgb(65, 105, 225)",
        );
        await expect(gradient.locator("stop").last()).toHaveCSS(
          "stop-color",
          "rgb(34, 197, 94)",
        );
      } else {
        await expect(avatar.locator('circle[fill="currentColor"]')).toHaveCSS(
          "fill",
          "rgb(65, 105, 225)",
        );
      }
    }
    await expect(option.locator('.ui-avatar-sample [role="img"]')).toHaveCount(
      0,
    );
    await expect(option.locator("svg text")).toHaveCount(0);
    for (const [selector, height] of [
      [".ui-avatar-sample:not(.ui-avatar-enlarged)", 24],
      [".ui-avatar-enlarged", 56],
    ] as const) {
      await expect(option.locator(`${selector} .attendee-avatar`)).toHaveCSS(
        "height",
        `${height}px`,
      );
    }
    await expect(
      option.locator(".ui-avatar-team .attendee-avatar"),
    ).toHaveCount(8);
    await expect(
      option.locator(`.ui-avatar-team [data-avatar-decoration="new-${style}"]`),
    ).toHaveCount(4);
    const newMedic = option
      .locator(".ui-avatar-team .attendee-new-volunteer")
      .filter({ has: page.locator('[data-avatar-decoration="medic-cross"]') });
    await expect(newMedic).toHaveCount(1);
    await expect(newMedic).toHaveAttribute(
      "aria-label",
      "New medic: registered",
    );
    await expect(
      newMedic.locator('[data-avatar-decoration="medic-cross"]'),
    ).toHaveCSS("fill", "rgb(255, 255, 255)");
  }
  for (const style of ["gradient", "gradient-horizontal"]) {
    const option = page.locator(`[data-ui-avatar-style="${style}"]`);
    await expect(
      option.locator(
        '[data-avatar-decoration="new-dot"], [data-avatar-decoration="new-outline"]',
      ),
    ).toHaveCount(0);
    const gradient = option.locator("linearGradient").first();
    await expect(gradient).toHaveAttribute(
      "x1",
      style === "gradient" ? "12" : "5",
    );
    await expect(gradient).toHaveAttribute(
      "x2",
      style === "gradient" ? "12" : "19",
    );
    await expect(gradient).toHaveAttribute(
      "y1",
      style === "gradient" ? "2.5" : "12",
    );
    await expect(gradient).toHaveAttribute(
      "y2",
      style === "gradient" ? "22" : "12",
    );
    await expect(gradient.locator("stop")).toHaveCount(2);
    await expect(gradient.locator("stop").first()).toHaveAttribute(
      "offset",
      "0",
    );
    await expect(gradient.locator("stop").last()).toHaveAttribute(
      "offset",
      "1",
    );
  }
  const gradientIds = await page
    .locator("[data-ui-avatar-variations] linearGradient")
    .evaluateAll((elements) => elements.map((element) => element.id));
  expect(gradientIds).toHaveLength(12);
  expect(new Set(gradientIds).size).toBe(gradientIds.length);
  const outlineOption = page.locator('[data-ui-avatar-style="outline"]');
  await expect(
    outlineOption.locator('[data-avatar-decoration="new-dot"]'),
  ).toHaveCount(0);
  const outline = outlineOption
    .locator('[data-avatar-decoration="new-outline"]')
    .first();
  await expect(outline).toHaveCSS("stroke", "rgb(34, 197, 94)");
  await expect(outline).toHaveAttribute("stroke-width", "1");
  await expect(outline).toHaveCSS("fill", "none");
  await expect(outline.locator("circle")).toHaveCount(1);
  await expect(outline.locator("path")).toHaveCount(1);
  const team = page.locator('[data-ui-avatar-style="dot"] .ui-avatar-team');
  await expect(team.locator(".attendee-avatar")).toHaveCount(8);
  await expect(
    team.locator('[data-avatar-decoration="medic-cross"]'),
  ).toHaveCount(3);
  await expect(team.locator('[data-avatar-decoration="new-dot"]')).toHaveCount(
    4,
  );
  const full = page.frameLocator('[data-ui-event-frame="full"]');
  const card = full.locator(".volunteer-event-card");
  await expect(card).toContainText("8 of 8 spots taken");
  await expect(card).toContainText("This event is full.");
  await expect(
    card.getByRole("button", { name: "Register", exact: true }),
  ).toHaveCount(0);
  const avatars = card.locator(".event-avatar-row");
  await expect(avatars.locator("[data-avatar-outline]")).toHaveCount(0);
  await expect(avatars.locator(".attendee-medic")).toHaveCount(2);
  await expect(avatars.locator(".attendee-outreach-volunteer")).toHaveCount(2);
  await expect(avatars.locator(".attendee-new-volunteer")).toHaveCount(4);
  await expect(
    avatars.locator('[data-avatar-decoration="medic-cross"]'),
  ).toHaveCount(3);
  await expect(
    avatars.locator(
      '.attendee-new-volunteer [data-avatar-decoration="medic-cross"]',
    ),
  ).toHaveCount(1);
  await expect(
    avatars.locator('[data-avatar-decoration="new-gradient-horizontal"]'),
  ).toHaveCount(4);
  await expect(
    avatars.locator(
      '[data-avatar-decoration="new-dot"], [data-avatar-decoration="new-outline"]',
    ),
  ).toHaveCount(0);
  const medicSymbol = avatars
    .locator('[data-avatar-decoration="medic-cross"]')
    .first();
  await expect(medicSymbol).toHaveAttribute(
    "d",
    "M10.75 12.25h2.5v2.5h2.5v2.5h-2.5v2.5h-2.5v-2.5h-2.5v-2.5h2.5Z",
  );
  await expect(medicSymbol).toHaveCSS("fill", "rgb(255, 255, 255)");
  const newVolunteerGradient = avatars
    .locator('linearGradient[data-avatar-decoration="new-gradient-horizontal"]')
    .first();
  await expect(newVolunteerGradient).toHaveAttribute("x1", "5");
  await expect(newVolunteerGradient).toHaveAttribute("x2", "19");
  await expect(newVolunteerGradient).toHaveAttribute("y1", "12");
  await expect(newVolunteerGradient).toHaveAttribute("y2", "12");
  await expect(newVolunteerGradient.locator("stop")).toHaveCount(2);
  await expect(newVolunteerGradient.locator("stop").first()).toHaveCSS(
    "stop-color",
    "rgb(65, 105, 225)",
  );
  await expect(newVolunteerGradient.locator("stop").last()).toHaveCSS(
    "stop-color",
    "rgb(34, 197, 94)",
  );
  await expect(avatars.locator(".attendee-medic").first()).toHaveAttribute(
    "aria-label",
    "Approved medic: registered",
  );
  await expect(
    avatars.locator(".attendee-new-volunteer").first(),
  ).toHaveAttribute("aria-label", "New medic: registered");
  for (const category of ["medic", "outreach-volunteer", "new-volunteer"]) {
    await expect(avatars.locator(`.attendee-${category}`).first()).toHaveCSS(
      "color",
      "rgb(65, 105, 225)",
    );
  }
  await page.getByRole("checkbox", { name: "Expand all rosters" }).check();
  await expect(card.locator("details")).toHaveAttribute("open", "");
  await expect(card.getByRole("row")).toHaveCount(9);
  await expect(
    card.locator(
      '.event-roster-person [data-avatar-decoration="new-gradient-horizontal"]',
    ),
  ).toHaveCount(4);
  await expect(card.locator(".event-roster-new-badge")).toHaveText([
    "New",
    "New",
    "New",
    "New",
  ]);
  await expect(
    card.locator(".event-roster-name").filter({ hasText: "Avery K." }),
  ).toHaveText("Avery K. New");
  const newMedicRow = card
    .locator(".event-roster-table tbody tr")
    .filter({ hasText: "Avery K." });
  await expect(
    newMedicRow.locator('[data-avatar-decoration="medic-cross"]'),
  ).toHaveCount(1);
  await expect(newMedicRow.locator(".event-roster-new-badge")).toHaveText(
    "New",
  );
  for (const row of await card.locator(".event-roster-table tbody tr").all()) {
    await expect(row.locator(".event-roster-new-badge")).toHaveCount(
      await row.locator(".attendee-new-volunteer").count(),
    );
  }
  await expect
    .poll(async () =>
      Number(
        await page
          .locator('[data-ui-event-frame="full"]')
          .getAttribute("height"),
      ),
    )
    .toBeGreaterThan(500);

  const width = page.getByRole("combobox", { name: "Preview width" });
  await width.selectOption("320");
  await expect.poll(() => card.evaluate(() => window.innerWidth)).toBe(320);
  expect(
    await card.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await width.selectOption("768");
  await expect.poll(() => card.evaluate(() => window.innerWidth)).toBe(768);
  expect(
    await card.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);

  const mixed = page.frameLocator('[data-ui-event-frame="mixed"]');
  await mixed.getByRole("button", { name: "Register", exact: true }).click();
  await expect(mixed.locator("[data-event-availability]")).toContainText(
    "Registered · 7 of 8 spots taken",
  );
  await expect(
    mixed.getByRole("rowheader", { name: "Morgan P." }),
  ).toBeVisible();
  await mixed.getByRole("button", { name: "Unregister", exact: true }).click();
  await expect(mixed.locator("[data-event-availability]")).toHaveText(
    "6 of 8 spots taken",
  );

  const registered = page.frameLocator('[data-ui-event-frame="registered"]');
  await registered
    .getByRole("button", { name: "Unregister", exact: true })
    .click();
  await expect(
    registered.getByRole("button", { name: "Register", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Reset previews" }).click();
  await expect(width).toHaveValue("fit");
  await expect(
    page.getByRole("checkbox", { name: "Expand all rosters" }),
  ).not.toBeChecked();
  await expect(
    registered.getByRole("button", { name: "Unregister", exact: true }),
  ).toBeVisible();
  await expect(card.locator("details")).not.toHaveAttribute("open", "");
  await page.setViewportSize({ width: 375, height: 812 });
  await expect
    .poll(() => card.evaluate(() => window.innerWidth))
    .toBeLessThanOrEqual(375);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  expect(forbidden).toEqual([]);
});
