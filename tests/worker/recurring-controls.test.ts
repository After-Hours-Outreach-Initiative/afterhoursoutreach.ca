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
          `/volunteer?occurrence=${encodeURIComponent(far.id)}`,
          undefined,
          organizer.cookie,
        ),
      )
    ).text();
    expect(selectedHtml).toContain(`data-live-event="${far.id}"`);
    expect(selectedHtml).toContain("Outside the volunteer signup window");
    expect(selectedHtml).toContain('value="future"');
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
    await organizerPage.goto(`${origin}/volunteer`);
    await organizerPage
      .getByRole("button", { name: "Add an event", exact: true })
      .click();
    const creator = organizerPage.locator("#event-editor-new");
    await creator.locator('[name="type"]').selectOption("orientation");
    await expect(creator.locator("[data-recurrence-controls]")).toBeHidden();
    await creator.locator('[name="type"]').selectOption("patrol");
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
      .getByRole("button", { name: "Save event", exact: true })
      .click();
    await expect(creator).not.toBeVisible();
    const uiSeries = await DB.prepare(
      "SELECT id FROM patrol_series WHERE meeting_point='UI recurring patrol'",
    ).first<string>("id");
    expect(uiSeries).toBeTruthy();
    const manager = organizerPage.locator(`[data-live-series="${uiSeries}"]`);
    await manager.locator("summary").click();
    const uiDate = addCalendarDays(firstDate, 42);
    await manager
      .locator('[data-series-occurrence] [name="occurrenceDate"]')
      .fill(uiDate);
    await manager
      .getByRole("button", { name: "Open occurrence", exact: true })
      .click();
    const uiId = `patrol:${uiSeries}:${uiDate}`;
    const uiCard = organizerPage.locator(`[data-live-event="${uiId}"]`);
    const editor = uiCard.locator("dialog");
    await expect(editor).toBeVisible();
    await expect(uiCard).toContainText("Outside the volunteer signup window");
    await expect(
      uiCard.getByRole("button", { name: "Register", exact: true }),
    ).toHaveCount(0);
    await editor
      .locator('[data-event-save] [name="scope"]')
      .selectOption("future");
    await editor
      .getByLabel("Meeting point", { exact: true })
      .fill("UI future meeting point");
    await editor
      .getByRole("button", { name: "Save event", exact: true })
      .click();
    await expect(
      organizerPage.getByRole("dialog", { name: "Send an email?" }),
    ).toContainText("whose booked patrol occurrences change");
    await organizerPage
      .getByRole("button", { name: "Save without email", exact: true })
      .click();
    await expect(uiCard.locator("dialog")).not.toBeVisible();
    await expect(uiCard).toContainText("UI future meeting point");
    // An open manager is protected from polling; closing it applies the deferred version.
    await manager.locator("summary").click();
    const uiVersion = await DB.prepare(
      "SELECT updated_at FROM patrol_series WHERE id=?",
    )
      .bind(uiSeries)
      .first<number>("updated_at");
    await expect(manager).toHaveAttribute(
      "data-series-version",
      String(uiVersion),
    );
    await manager.locator("summary").click();
    await manager
      .locator('[data-series-end] [name="endDate"]')
      .fill(addCalendarDays(firstDate, 28));
    await manager
      .getByRole("button", { name: "Save end date", exact: true })
      .click();
    await organizerPage
      .getByRole("button", { name: "Save without email", exact: true })
      .click();
    await expect(uiCard).toContainText("Cancelled");
    // Existing cancellation history remains accessible beyond the shortened end.
    await manager
      .locator('[data-series-occurrence] [name="occurrenceDate"]')
      .fill(uiDate);
    await manager
      .getByRole("button", { name: "Open occurrence", exact: true })
      .click();
    await expect(
      uiCard.getByRole("button", { name: "Edit", exact: true }),
    ).toHaveCount(0);
    await expect(
      manager.getByRole("button", { name: "Open occurrence", exact: true }),
    ).toBeEnabled();
    const uiFirstCard = organizerPage.locator(
      `[data-live-event="patrol:${uiSeries}:${firstDate}"]`,
    );
    await uiFirstCard
      .getByRole("button", { name: "Edit", exact: true })
      .click();
    const cancelForm = uiFirstCard.locator("[data-event-cancel]");
    await cancelForm.locator('[name="scope"]').selectOption("future");
    await cancelForm
      .getByRole("button", { name: "Cancel event", exact: true })
      .click();
    await expect(
      organizerPage.getByRole("dialog", { name: "Send an email?" }),
    ).toContainText("whose future patrol bookings are cancelled");
    await organizerPage
      .getByRole("button", { name: "Save without email", exact: true })
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
    // The same production script still initializes task4's extracted browser:
    // live searching must retain its approval filter and global queue count.
    const awaiting = await DB.prepare(
      "SELECT count(*) n FROM profile p JOIN volunteer_status v ON v.user_id=p.user_id WHERE v.registration_approved=0",
    ).first<number>("n");
    await organizerPage.goto(
      `${origin}/volunteer/volunteers?approval=awaiting`,
    );
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
    ).toHaveText(String(awaiting));
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
    await page.goto(`${origin}/volunteer`);
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
      page.locator(`[data-live-event="${initial[0].id}"]`),
    ).toHaveCount(0);
    expect(
      await DB.prepare("SELECT status FROM signup WHERE event_id=?")
        .bind(initial[0].id)
        .first("status"),
    ).toBe("confirmed");
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
