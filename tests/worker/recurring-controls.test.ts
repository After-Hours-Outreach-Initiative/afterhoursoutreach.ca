import { existsSync } from "node:fs";
import { test } from "vitest";
import { chromium, expect, type Page } from "@playwright/test";
import { createTestHarness } from "wrangler";
import { createSignInOTP } from "../helpers/email-otp";
import { profileWriteBody } from "../helpers/profile-write";
import { sampleAnswers } from "../helpers/local-account";
import { addCalendarDays, vancouverInput } from "../../src/data/event-time";
import { fillDateInput } from "../helpers/date-input";

test("organizer recurrence API and controls preserve exceptions/bookings; an open volunteer page rolls forward at start", async () => {
  const origin = "https://afterhoursoutreach.ca";
  const secret = "recurring-controls-secret-12345678901234567890";
  const server = createTestHarness({
    workers: [
      {
        configPath: "dist/server/wrangler.json",
        vars: { APP_ENV: "production", AUTH_BASE_URL: origin },
        secrets: { BETTER_AUTH_SECRET: secret, RESEND_API_KEY: "" },
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
    const { DB } = await worker.getEnv();
    await worker.applyD1Migrations("DB");
    const send = (path: string, body?: object, cookie = "") =>
      worker.fetch(`${origin}${path}`, {
        method: body ? "POST" : "GET",
        headers: { origin, "content-type": "application/json", cookie },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    const ok = async (
      response: Awaited<ReturnType<typeof send>>,
      expected = 200,
    ) => {
      expect(response.status, await response.clone().text()).toBe(expected);
      return response;
    };
    const signIn = async (email: string) => {
      const response = await ok(
        await send(
          "/api/v1/auth/sign-in/email-otp",
          await createSignInOTP(DB, secret, email),
        ),
      );
      return response.headers
        .getSetCookie()
        .filter((value) => !value.includes("Max-Age=0"))
        .map((value) => value.split(";")[0])
        .join("; ");
    };
    const person = async (email: string) => {
      const cookie = await signIn(email);
      await ok(
        await send(
          "/api/v1/account/profile",
          await profileWriteBody((path) => send(path, undefined, cookie), {
            ...sampleAnswers,
            codeOfConductAccepted: true,
          }),
          cookie,
        ),
      );
      const session = (await (
        await send("/api/v1/auth/get-session", undefined, cookie)
      ).json()) as { user: { id: string } };
      return { cookie, id: session.user.id };
    };
    const organizer = await person("recurring-organizer@example.org");
    const volunteer = await person("recurring-volunteer@example.org");
    await DB.prepare("INSERT INTO organizer_bootstrap VALUES(1,?,?)")
      .bind(organizer.id, Date.now())
      .run();
    organizer.cookie = await signIn("recurring-organizer@example.org");
    await DB.prepare(
      "UPDATE volunteer_status SET registration_approved=1,patrol_approved=1,approved_by=?,approved_at=? WHERE user_id=?",
    )
      .bind(organizer.id, Date.now(), volunteer.id)
      .run();
    const firstDate = addCalendarDays(
      vancouverInput(Date.now()).slice(0, 10),
      1,
    );
    const seriesInput = {
      firstDate,
      localTime: "20:30",
      intervalWeeks: 2,
      endDate: null,
      meetingPoint: "Recurring meeting point",
      meetingPointUrl: "",
      spots: 3,
      open: true,
      hidden: false,
    };
    const action = (body: object, cookie = organizer.cookie) =>
      send("/api/v1/events/action", body, cookie);
    const tooSmall = await action({
      action: "save-series",
      series: {
        ...seriesInput,
        includesOrientation: true,
        spots: 1,
      },
    });
    expect(tooSmall.status).toBe(400);
    expect(await tooSmall.text()).toContain("at least 2 total volunteer spots");
    await ok(
      await action(
        { action: "save-series", series: seriesInput },
        volunteer.cookie,
      ),
      403,
    );
    await ok(
      await action({
        action: "save-series",
        series: { ...seriesInput, intervalWeeks: 0 },
      }),
      400,
    );
    const series = (await (
      await ok(await action({ action: "save-series", series: seriesInput }))
    ).json()) as { id: string };
    const rows = async () =>
      (
        await DB.prepare(
          "SELECT id,occurrence_date AS date,updated_at AS version FROM event WHERE series_id=? ORDER BY occurrence_date",
        )
          .bind(series.id)
          .all<{ id: string; date: string; version: number }>()
      ).results;
    const currentVersion = () =>
      DB.prepare("SELECT updated_at FROM patrol_series WHERE id=?")
        .bind(series.id)
        .first<number>("updated_at");
    const initial = await rows();
    await ok(
      await action({ action: "join", id: initial[0].id }, volunteer.cookie),
    );
    await ok(
      await action({ action: "join", id: initial[1].id }, volunteer.cookie),
    );
    const bookings = (
      await DB.prepare("SELECT * FROM signup ORDER BY id").all()
    ).results;
    await ok(
      await action({
        action: "save",
        id: initial[1].id,
        version: initial[1].version,
        event: {
          type: "patrol",
          startsAt: new Date(Date.now() + 60 * 86_400_000).toISOString(),
          meetingPoint: "Individual exception",
          meetingPointUrl: "",
          spots: 3,
          open: true,
          hidden: false,
        },
      }),
    );
    const version = await currentVersion();
    await ok(
      await action({
        action: "update-series-from",
        id: series.id,
        version,
        occurrenceDate: firstDate,
        template: {
          localTime: "21:15",
          dayOffset: 1,
          meetingPoint: "Changed recurring meeting point",
          meetingPointUrl: "",
          spots: 3,
          open: true,
          hidden: false,
        },
      }),
    );
    expect(
      await DB.prepare("SELECT meeting_point FROM event WHERE id=?")
        .bind(initial[1].id)
        .first("meeting_point"),
    ).toBe("Individual exception");
    expect(
      (await DB.prepare("SELECT * FROM signup ORDER BY id").all()).results,
    ).toEqual(bookings);
    expect(
      await DB.prepare("SELECT count(*) n FROM event_notification").first("n"),
    ).toBe(0);
    await ok(
      await action({
        action: "update-series-from",
        id: series.id,
        version,
        occurrenceDate: firstDate,
        template: {
          localTime: "21:15",
          dayOffset: 1,
          meetingPoint: "Stale",
          meetingPointUrl: "",
          spots: 3,
          open: true,
          hidden: false,
        },
      }),
      409,
    );
    const farDate = addCalendarDays(firstDate, 140);
    const far = (await (
      await ok(
        await action({
          action: "materialize-occurrence",
          id: series.id,
          occurrenceDate: farDate,
        }),
      )
    ).json()) as { id: string };
    await ok(
      await action({ action: "join", id: far.id }, volunteer.cookie),
      409,
    );
    const selectedHtml = await (
      await ok(
        await send(
          `/manage/events?occurrence=${encodeURIComponent(far.id)}`,
          undefined,
          organizer.cookie,
        ),
      )
    ).text();
    expect(selectedHtml).toContain(`data-live-event="${far.id}"`);
    expect(selectedHtml).not.toContain("nominal date");
    expect(selectedHtml).not.toMatch(
      /data-live-signup|You can register|You can’t register|Registration is available only/,
    );
    expect(selectedHtml).toContain('value="future"');
    expect(
      selectedHtml.match(new RegExp(`data-series-card="${series.id}"`, "g")),
    ).toHaveLength(1);
    // A series operation with no event_audit row of the exact operation ID is retryable.
    const auditOperation = await DB.prepare(
      "SELECT id FROM patrol_series_audit WHERE action='updated_future'",
    ).first<string>("id");
    await ok(
      await action({
        action: "retry-notifications",
        operation: auditOperation,
      }),
    );

    const routeToWorker = (page: Page) =>
      page.route("**/*", async (route) => {
        const request = route.request();
        if (!request.url().startsWith(origin)) return route.abort();
        const response = await worker.fetch(request.url(), {
          method: request.method(),
          headers: await request.allHeaders(),
          ...(request.postData() ? { body: request.postData()! } : {}),
        });
        await route.fulfill({
          status: response.status,
          headers: Object.fromEntries(response.headers),
          body: Buffer.from(await response.arrayBuffer()),
        });
      });
    const cookieValues = (cookie: string) =>
      cookie.split("; ").map((entry) => {
        const split = entry.indexOf("=");
        return {
          name: entry.slice(0, split),
          value: entry.slice(split + 1),
          url: origin,
        };
      });
    const organizerContext = await browser.newContext();
    await organizerContext.addCookies(cookieValues(organizer.cookie));
    const organizerPage = await organizerContext.newPage();
    await routeToWorker(organizerPage);
    const organizerErrors: string[] = [];
    organizerPage.on("pageerror", (error) =>
      organizerErrors.push(error.message),
    );
    await ok(
      await action({
        action: "save",
        event: {
          includesOrientation: false,
          startsAt: new Date(Date.now() + 86_400_000).toISOString(),
          meetingPoint: "One-off management event",
          meetingPointUrl: "",
          spots: 3,
          open: true,
          hidden: false,
        },
      }),
    );
    const oneOffId = await DB.prepare(
      "SELECT id FROM event WHERE meeting_point='One-off management event'",
    ).first<string>("id");
    const pastDate = addCalendarDays(firstDate, -365);
    const emptySeries = { id: "ended-empty-series" };
    await DB.prepare(
      `INSERT INTO patrol_series
      (id,first_date,local_time,interval_weeks,end_date,meeting_point,spots,created_by,created_at,updated_at)
      VALUES (?,?,'20:30',2,?,'Ended series without occurrences',3,?,0,0)`,
    )
      .bind(emptySeries.id, pastDate, pastDate, organizer.id)
      .run();
    await organizerPage.goto(`${origin}/manage/events`);
    const topLevel = organizerPage.locator("[data-event-list] > li");
    const initialGroup = organizerPage.locator(
      `[data-series-card="${series.id}"]`,
    );
    const emptyGroup = organizerPage.locator(
      `[data-series-card="${emptySeries.id}"]`,
    );
    await expect(topLevel).toHaveCount(3);
    await expect(
      organizerPage.locator("[data-event-list] > [data-live-event]"),
    ).toHaveAttribute("data-live-event", oneOffId!);
    await expect(initialGroup).toHaveCount(1);
    const weekday = new Intl.DateTimeFormat("en-CA", {
      weekday: "long",
      timeZone: "UTC",
    }).format(new Date(`${firstDate}T00:00:00Z`));
    await expect(initialGroup.locator("[data-series-summary] h3")).toHaveText(
      `Every 2 weeks on ${weekday}`,
    );
    await expect(
      initialGroup.locator("[data-series-summary] > p").first(),
    ).toHaveText("Patrol");
    await expect(initialGroup.locator("[data-series-summary]")).toContainText(
      "Starting on",
    );
    await expect(initialGroup.locator("[data-series-summary]")).toContainText(
      "8:30 PM",
    );
    await expect(
      initialGroup.locator("[data-series-summary]"),
    ).not.toContainText("Original defaults");
    expect(
      await initialGroup.locator("[data-live-event]").count(),
    ).toBeGreaterThan(1);
    await expect(emptyGroup.locator("[data-live-event]")).toHaveCount(0);
    await expect(emptyGroup.locator("[data-live-series]")).toHaveCount(1);
    await expect(
      organizerPage.getByRole("heading", {
        name: "Recurring patrols",
        exact: true,
      }),
    ).toHaveCount(0);
    await organizerPage
      .getByRole("button", { name: /^One-off events \(\d+\)$/ })
      .click();
    await expect(
      organizerPage.locator("[data-event-list] > li:visible"),
    ).toHaveCount(1);
    await expect(initialGroup).toBeHidden();
    await organizerPage.reload();
    await expect(initialGroup).toBeHidden();
    await organizerPage
      .getByRole("button", { name: /^Recurring series \(\d+\)$/ })
      .click();
    await expect(
      organizerPage.locator("[data-event-list] > li:visible"),
    ).toHaveCount(2);
    await expect(emptyGroup).toBeVisible();
    await organizerPage.goBack();
    await expect(initialGroup).toBeHidden();
    await organizerPage.getByRole("button", { name: /^All \(\d+\)$/ }).click();

    // Polling updates occurrences without discarding the open series draft or
    // collapsing an expanded roster/occurrence list behind the modal.
    const originalManager = initialGroup.locator("[data-live-series]");
    await initialGroup.locator("[data-series-occurrences] > summary").click();
    const firstCard = initialGroup.locator(
      `[data-live-event="${initial[0].id}"]`,
    );
    await firstCard.locator(".volunteer-roster > summary").click();
    await initialGroup
      .getByRole("button", { name: "Edit series", exact: true })
      .click();
    const draftEnd = addCalendarDays(firstDate, 350);
    await originalManager
      .locator('[data-series-save] [name="endDate"]')
      .fill(draftEnd);
    await originalManager
      .locator('[name="meetingPoint"]')
      .fill("Unsaved series meeting point");
    const oldVersion = await originalManager.getAttribute(
      "data-series-version",
    );
    await ok(
      await action({
        action: "save-series",
        id: series.id,
        version: await currentVersion(),
        series: { ...seriesInput, endDate: addCalendarDays(firstDate, 280) },
      }),
    );
    await ok(
      await action({ action: "cancel", id: initial[0].id }, volunteer.cookie),
    );
    await expect(firstCard.locator("[data-event-availability]")).toHaveText(
      "0 of 3 spots taken",
      { timeout: 15_000 },
    );
    await expect(
      originalManager.locator('[data-series-save] [name="endDate"]'),
    ).toHaveValue(draftEnd);
    await expect(originalManager.locator('[name="meetingPoint"]')).toHaveValue(
      "Unsaved series meeting point",
    );
    await expect(originalManager).toHaveAttribute(
      "data-series-version",
      oldVersion!,
    );
    await originalManager
      .getByRole("button", { name: "Close", exact: true })
      .click();
    await expect(firstCard.locator(".volunteer-roster > summary")).toHaveText(
      "Volunteers (0)",
    );
    await expect(firstCard.locator(".volunteer-roster")).toHaveAttribute(
      "open",
      "",
    );
    await expect(
      initialGroup.locator("[data-series-occurrences]"),
    ).toHaveAttribute("open", "");
    await expect(originalManager).toHaveAttribute(
      "data-series-version",
      String(await currentVersion()),
    );
    await ok(
      await action({ action: "join", id: initial[0].id }, volunteer.cookie),
    );
    const occurrenceCount = await initialGroup
      .locator("[data-live-event]")
      .count();
    await initialGroup.locator("[data-series-occurrences] > summary").focus();
    await ok(
      await action({
        action: "materialize-occurrence",
        id: series.id,
        occurrenceDate: addCalendarDays(firstDate, 154),
      }),
    );
    await expect(initialGroup.locator("[data-live-event]")).toHaveCount(
      occurrenceCount + 1,
      { timeout: 15_000 },
    );
    await expect(
      initialGroup.locator("[data-series-occurrences] > summary"),
    ).toBeFocused();
    await expect(initialGroup).toHaveCount(1);
    await organizerPage
      .getByRole("button", { name: /^Recurring series \(\d+\)$/ })
      .click();
    await organizerPage
      .getByRole("button", { name: "Create", exact: true })
      .click();
    const creator = organizerPage.locator("#event-editor-new");
    await creator
      .getByRole("checkbox", { name: "Includes orientation", exact: true })
      .check();
    await expect(creator.locator("[data-recurrence-controls]")).toBeVisible();
    await creator.locator('[name="recurring"]').check();
    await expect(creator.locator('[name="intervalWeeks"]')).toBeEnabled();
    await creator.locator('[name="intervalWeeks"]').fill("2");
    await creator
      .locator('[name="endDate"]')
      .fill(addCalendarDays(firstDate, 56));
    await fillDateInput(creator, "startsAt", `${firstDate}T20:30`);
    await creator
      .getByLabel("Meeting point", { exact: true })
      .fill("UI recurring patrol");
    await creator
      .locator("label.volunteer-state-option")
      .filter({ hasText: /^Visible$/ })
      .click();
    await creator
      .getByRole("button", { name: "Create event", exact: true })
      .click();
    await expect(creator).not.toBeVisible();
    const uiSeries = await DB.prepare(
      "SELECT id FROM patrol_series WHERE meeting_point='UI recurring patrol'",
    ).first<string>("id");
    expect(uiSeries).toBeTruthy();
    expect(
      await DB.prepare(
        "SELECT includes_orientation FROM patrol_series WHERE id=?",
      )
        .bind(uiSeries)
        .first("includes_orientation"),
    ).toBe(1);
    const manager = organizerPage.locator(`[data-live-series="${uiSeries}"]`);
    const uiGroup = organizerPage.locator(`[data-series-card="${uiSeries}"]`);
    await expect(uiGroup).toHaveCount(1);
    await expect(uiGroup).toBeVisible();
    await expect(
      organizerPage.locator("[data-event-list] > [data-live-event]"),
    ).toBeHidden();
    await organizerPage
      .getByRole("button", { name: /^Orientations \(\d+\)$/ })
      .click();
    await expect(uiGroup).toBeVisible();
    await expect(initialGroup).toBeHidden();
    await organizerPage
      .getByRole("button", { name: /^Recurring series \(\d+\)$/ })
      .click();
    await uiGroup
      .getByRole("button", { name: "Edit series", exact: true })
      .click();
    await expect(manager.locator('[name="recurring"]')).toHaveCount(0);
    await expect(manager.getByLabel("Start time")).toHaveValue("8:30 PM");
    await expect(manager.getByLabel("Interval (weeks)")).toBeEditable();
    await expect(manager.getByLabel("Start time")).toBeEditable();
    await expect(manager.locator("[data-native-date]").first()).toHaveAttribute(
      "readonly",
      "",
    );
    await manager.getByLabel("Start time").fill("7:15 PM");
    await manager.getByLabel("Interval (weeks)").fill("3");
    await manager
      .getByRole("button", { name: "Save series defaults", exact: true })
      .click();
    await organizerPage
      .getByRole("button", { name: "Save without email", exact: true })
      .click();
    await expect(manager).not.toBeVisible();
    expect(
      await DB.prepare(
        "SELECT local_time, interval_weeks FROM patrol_series WHERE id=?",
      )
        .bind(uiSeries)
        .first(),
    ).toEqual({ local_time: "19:15", interval_weeks: 3 });
    expect(
      await DB.prepare(
        "SELECT starts_at FROM event WHERE series_id=? AND occurrence_date=?",
      )
        .bind(uiSeries, addCalendarDays(firstDate, 21))
        .first<number>("starts_at")
        .then((start) => vancouverInput(start!)),
    ).toBe(`${addCalendarDays(firstDate, 21)}T19:15`);
    await uiGroup.locator("[data-series-occurrences] > summary").click();
    const uiDate = addCalendarDays(firstDate, 42);
    await uiGroup
      .locator('[data-series-occurrence] [name="occurrenceDate"]')
      .fill(uiDate);
    await uiGroup
      .getByRole("button", { name: "Open occurrence", exact: true })
      .click();
    const uiId = `patrol:${uiSeries}:${uiDate}`;
    const uiCard = organizerPage.locator(`[data-live-event="${uiId}"]`);
    const editor = uiCard.locator("dialog");
    await expect(editor).toBeVisible();
    expect(new URL(organizerPage.url()).searchParams.get("type")).toBe(
      "recurring",
    );
    expect(new URL(organizerPage.url()).searchParams.get("occurrence")).toBe(
      uiId,
    );
    await expect(uiGroup.locator(`[data-live-event="${uiId}"]`)).toHaveCount(1);
    await expect(uiGroup).toHaveCount(1);
    await expect(
      editor.getByRole("checkbox", {
        name: "Includes orientation",
        exact: true,
      }),
    ).toBeChecked();
    await expect(uiCard).not.toContainText("nominal date");
    await expect(
      uiCard.getByRole("button", { name: "Register", exact: true }),
    ).toHaveCount(0);
    await editor
      .locator('[data-event-save] [name="scope"]')
      .selectOption("future");
    await editor
      .getByRole("checkbox", { name: "Includes orientation", exact: true })
      .uncheck();
    await editor
      .getByLabel("Meeting point", { exact: true })
      .fill("UI future meeting point");
    await editor
      .getByRole("button", { name: "Save event", exact: true })
      .click();
    await expect(uiCard.locator("dialog")).not.toBeVisible();
    // Empty occurrences do not offer roster email or a cancellation reason.
    await expect(
      organizerPage.getByRole("dialog", { name: "Send an email?" }),
    ).not.toBeVisible();
    await expect(uiCard).toContainText("UI future meeting point");
    expect(
      await DB.prepare(
        "SELECT includes_orientation FROM patrol_series_template WHERE series_id=?",
      )
        .bind(uiSeries)
        .first("includes_orientation"),
    ).toBe(0);
    // The same orientation setting can then be overridden on just this patrol.
    await uiCard.getByRole("button", { name: "Edit", exact: true }).click();
    await uiCard
      .locator("dialog")
      .getByRole("checkbox", { name: "Includes orientation", exact: true })
      .check();
    await uiCard
      .locator("dialog")
      .getByRole("button", { name: "Save event", exact: true })
      .click();
    await expect(uiCard.locator("dialog")).not.toBeVisible();
    expect(
      await DB.prepare("SELECT includes_orientation FROM event WHERE id=?")
        .bind(uiId)
        .first("includes_orientation"),
    ).toBe(1);
    const uiVersion = await DB.prepare(
      "SELECT updated_at FROM patrol_series WHERE id=?",
    )
      .bind(uiSeries)
      .first<number>("updated_at");
    await expect(manager).toHaveAttribute(
      "data-series-version",
      String(uiVersion),
    );
    await uiGroup
      .getByRole("button", { name: "Edit series", exact: true })
      .click();
    await manager
      .locator('[data-series-save] [name="endDate"]')
      .fill(addCalendarDays(firstDate, 28));
    await manager
      .getByRole("button", { name: "Save series defaults", exact: true })
      .click();
    await organizerPage
      .getByRole("button", { name: "Save without email", exact: true })
      .click();
    await expect(uiCard).toContainText("Cancelled");
    await expect(uiGroup).toHaveCount(1);
    expect(
      await DB.prepare(
        "SELECT includes_orientation FROM patrol_series WHERE id=?",
      )
        .bind(uiSeries)
        .first("includes_orientation"),
    ).toBe(1);
    // Existing cancellation history remains accessible beyond the shortened end.
    await uiGroup
      .locator('[data-series-occurrence] [name="occurrenceDate"]')
      .fill(uiDate);
    await uiGroup
      .getByRole("button", { name: "Open occurrence", exact: true })
      .click();
    await expect(
      uiCard.getByRole("button", { name: "Edit", exact: true }),
    ).toHaveCount(1);
    await expect(editor).toBeVisible();
    await expect(
      editor.locator("[data-event-save], [data-event-cancel]"),
    ).toHaveCount(0);
    await expect(
      editor.getByRole("button", { name: "Delete occurrence", exact: true }),
    ).toBeEnabled();
    await editor.getByRole("button", { name: "Close", exact: true }).click();
    await expect(
      uiGroup.getByRole("button", { name: "Open occurrence", exact: true }),
    ).toBeEnabled();
    const uiFirstCard = organizerPage.locator(
      `[data-live-event="patrol:${uiSeries}:${firstDate}"]`,
    );
    await uiFirstCard
      .getByRole("button", { name: "Edit", exact: true })
      .click();
    const cancelForm = uiFirstCard.locator("[data-event-cancel]");
    await cancelForm.locator('[name="scope"]').selectOption("future");
    await expect(
      cancelForm.locator("[data-event-cancel-heading]"),
    ).toBeHidden();
    await expect(cancelForm.locator("[data-event-cancel-reason]")).toBeHidden();
    await uiFirstCard
      .getByRole("button", { name: "Cancel event", exact: true })
      .click();
    await expect(uiFirstCard.locator(".volunteer-hidden")).toHaveText(
      "Cancelled",
    );
    expect(
      await DB.prepare("SELECT stopped_from FROM patrol_series WHERE id=?")
        .bind(uiSeries)
        .first("stopped_from"),
    ).toBe(firstDate);
    expect(
      await DB.prepare("SELECT count(*) n FROM event_notification").first("n"),
    ).toBe(0);
    expect(organizerErrors).toEqual([]);
    await organizerPage.reload();
    await expect(uiCard).toBeVisible();
    await expect(uiGroup).toHaveCount(1);
    // Cancelled dates remain removable, without deleting the other occurrences.
    await uiCard.getByRole("button", { name: "Edit", exact: true }).click();
    await uiCard
      .getByRole("button", { name: "Delete occurrence", exact: true })
      .click();
    const confirmation = organizerPage.getByRole("dialog", {
      name: "Delete occurrence?",
      exact: true,
    });
    await confirmation
      .getByRole("button", { name: "Keep", exact: true })
      .click();
    await expect(uiCard).toBeVisible();
    await uiCard
      .getByRole("button", { name: "Delete occurrence", exact: true })
      .click();
    await confirmation
      .getByRole("button", { name: "Delete", exact: true })
      .click();
    await expect(uiCard).toHaveCount(0);
    await expect(uiGroup).toHaveCount(1);
    expect(
      await DB.prepare("SELECT count(*) n FROM event WHERE id=?")
        .bind(uiId)
        .first("n"),
    ).toBe(1);
    await emptyGroup
      .getByRole("button", { name: "Edit series", exact: true })
      .click();
    await emptyGroup
      .getByRole("button", { name: "Delete series", exact: true })
      .click();
    await organizerPage
      .getByRole("dialog", { name: "Delete series?", exact: true })
      .getByRole("button", { name: "Delete", exact: true })
      .click();
    await organizerPage
      .getByRole("button", { name: "Save without email", exact: true })
      .click();
    await expect(emptyGroup).toHaveCount(0);
    await expect(uiGroup).toHaveCount(1);
    // The same production script still initializes task4's extracted browser:
    // live searching must retain its approval filter and refresh its queue count.
    const awaiting = await DB.prepare(
      "SELECT count(*) n FROM profile p JOIN volunteer_status v ON v.user_id=p.user_id WHERE v.registration_approved=0",
    ).first<number>("n");
    await organizerPage.goto(`${origin}/manage/volunteers?approval=awaiting`);
    await expect(
      organizerPage.locator("[data-awaiting-approval-count]"),
    ).toHaveText(String(awaiting));
    await organizerPage
      .locator("[data-volunteer-search]")
      .fill("No matching applicant");
    await expect(
      organizerPage.locator("[data-volunteer-results]"),
    ).toContainText("No applications awaiting approval match your search");
    await expect(
      organizerPage.locator("[data-awaiting-approval-count]"),
    ).toHaveText("0");
    expect(new URL(organizerPage.url()).searchParams.get("approval")).toBe(
      "awaiting",
    );
    await organizerContext.close();

    const context = await browser.newContext();
    await context.addCookies(cookieValues(volunteer.cookie));
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await routeToWorker(page);
    // No writes occur after opening: SQLite's live clock crosses the actual start.
    await DB.prepare("UPDATE event SET starts_at=? WHERE id=?")
      .bind(Date.now() + 3_000, initial[0].id)
      .run();
    await page.goto(`${origin}/events`);
    await expect(
      page.locator(`[data-live-event="${initial[0].id}"]`),
    ).toBeVisible();
    const replacementId = `patrol:${series.id}:${addCalendarDays(firstDate, 42)}`;
    // The rescheduled exception is later than the ordinary fourth date.
    await expect(
      page.locator(`[data-live-event="${replacementId}"]`),
    ).toBeVisible();
    const nextId = `patrol:${series.id}:${addCalendarDays(firstDate, 56)}`;
    await expect(page.locator(`[data-live-event="${nextId}"]`)).toHaveCount(0);
    await expect(page.locator(`[data-live-event="${nextId}"]`)).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      page.locator(`[data-event-list] [data-live-event="${initial[0].id}"]`),
    ).toHaveCount(0);
    const pastCard = page.locator(
      `[data-past-event-list] [data-live-event="${initial[0].id}"]`,
    );
    await expect(pastCard).toBeVisible();
    await expect(pastCard).toContainText("You registered");
    await expect(pastCard.locator("[data-live-signup]")).toHaveCount(0);
    await page.locator('[data-event-filter="orientation"]').click();
    await expect(pastCard).toBeHidden();
    await page.locator('[data-event-filter="all"]').click();
    await expect(pastCard).toBeVisible();
    expect(
      await DB.prepare(
        "SELECT count(*) n FROM signup WHERE event_id=? AND status='confirmed'",
      )
        .bind(initial[0].id)
        .first("n"),
    ).toBe(1);
    expect(errors).toEqual([]);

    await ok(
      await action({
        action: "stop-series",
        id: series.id,
        occurrenceDate: initial[1].date,
        version: await currentVersion(),
        reason: "End season",
        notify: true,
      }),
    );
    expect(
      await DB.prepare("SELECT status FROM signup WHERE event_id=?")
        .bind(initial[1].id)
        .first("status"),
    ).toBe("cancelled");
    expect(
      await DB.prepare("SELECT count(*) n FROM event_notification").first("n"),
    ).toBe(1);
    const ended = await DB.prepare(
      "SELECT count(*) n FROM event WHERE cancelled_at IS NOT NULL",
    ).first<number>("n");
    await ok(await send("/api/v1/events/version", undefined, volunteer.cookie));
    expect(
      await DB.prepare(
        "SELECT count(*) n FROM event WHERE cancelled_at IS NOT NULL",
      ).first("n"),
    ).toBe(ended);
    await context.close();
  } finally {
    await browser.close();
    await server.close();
  }
}, 60_000);
