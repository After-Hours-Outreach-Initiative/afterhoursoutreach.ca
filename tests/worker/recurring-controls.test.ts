import { makeWaitingChange } from "../helpers/pending-action";
import { launchWorkerBrowser } from "../helpers/worker-browser";
import { test } from "vitest";
import { expect, type Page } from "@playwright/test";
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
  const browser = await launchWorkerBrowser();
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
    const action = async (body: object, cookie = organizer.cookie) =>
      makeWaitingChange(
        "/api/v1/events/action",
        await send("/api/v1/events/action", body, cookie),
        (path, body) => send(path, body, cookie),
      );
    const tooSmall = await action({
      action: "save-series",
      series: {
        ...seriesInput,
        includesOrientation: true,
        spots: 1,
      },
    });
    expect(tooSmall.status).toBe(400);
    expect(await tooSmall.text()).toContain("reserved medic places");
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
    // Dates beyond the two-month window are generated later; insert one early.
    const farDate = addCalendarDays(firstDate, 140);
    const far = { id: `patrol:${series.id}:${farDate}` };
    await DB.prepare(
      `INSERT INTO event (id,type,series_id,occurrence_date,starts_at,meeting_point,spots,created_by,created_at,updated_at)
      VALUES (?,'patrol',?,?,?,'Changed recurring meeting point',3,?,0,0)`,
    )
      .bind(
        far.id,
        series.id,
        farDate,
        Date.parse(`${farDate}T12:00:00Z`),
        organizer.id,
      )
      .run();
    await ok(
      await action({ action: "join", id: far.id }, volunteer.cookie),
      409,
    );
    const selectedHtml = await (
      await ok(
        await send(
          `/events?occurrence=${encodeURIComponent(far.id)}`,
          undefined,
          organizer.cookie,
        ),
      )
    ).text();
    expect(selectedHtml).toContain(`data-live-event="${far.id}"`);
    expect(selectedHtml).not.toContain("nominal date");
    expect(selectedHtml).not.toMatch(
      /You can register|You can’t register|Registration opens/,
    );
    expect(selectedHtml).toContain('value="future"');
    expect(selectedHtml).toContain('value="all"');
    expect(selectedHtml).not.toContain("Manage recurring series");
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
    await organizerPage.goto(`${origin}/events`);
    const topLevel = organizerPage.locator("[data-event-list] > li");
    const occurrences = organizerPage.locator(
      `[data-event-list] > [data-event-series="${series.id}"]`,
    );
    const initialOccurrenceCount = (await rows()).length;
    await expect(topLevel).toHaveCount(initialOccurrenceCount + 1);
    await expect(
      organizerPage.locator(
        "[data-event-list] > [data-live-event]:not([data-event-series])",
      ),
    ).toHaveAttribute("data-live-event", oneOffId!);
    await expect(
      organizerPage.getByText("Manage recurring series"),
    ).toHaveCount(0);
    expect(await occurrences.count()).toBeGreaterThan(1);

    // Polling updates other events without discarding an open editor draft.
    const firstCard = organizerPage.locator(
      `[data-live-event="${initial[0].id}"]`,
    );
    const draftCard = organizerPage.locator(
      `[data-live-event="${initial[2].id}"]`,
    );
    await draftCard.getByRole("button", { name: "Edit", exact: true }).click();
    const draftEditor = draftCard.locator("dialog");
    await draftEditor
      .getByLabel("Meeting point", { exact: true })
      .fill("Unsaved meeting point");
    await ok(
      await action({ action: "cancel", id: initial[0].id }, volunteer.cookie),
    );
    await expect(firstCard.locator("[data-event-availability]")).toHaveText(
      "Open · 3 of 3 spots remaining",
      { timeout: 15_000 },
    );
    await expect(
      draftEditor.getByLabel("Meeting point", { exact: true }),
    ).toHaveValue("Unsaved meeting point");
    await draftEditor
      .getByRole("button", { name: "Close", exact: true })
      .click();
    await ok(
      await action({ action: "join", id: initial[0].id }, volunteer.cookie),
    );

    // A cancelled series date stays listed for organizers, who can restore it.
    const occurrenceCount = await occurrences.count();
    const lastId = `patrol:${series.id}:${addCalendarDays(firstDate, 56)}`;
    const lastCard = organizerPage.locator(`[data-live-event="${lastId}"]`);
    await ok(
      await action({
        action: "cancel-event",
        id: lastId,
        version: await DB.prepare("SELECT updated_at FROM event WHERE id=?")
          .bind(lastId)
          .first<number>("updated_at"),
        reason: "",
      }),
    );
    await expect(lastCard.locator(".volunteer-hidden")).toHaveText(
      "Cancelled",
      { timeout: 15_000 },
    );
    await expect(occurrences).toHaveCount(occurrenceCount);
    await lastCard
      .getByRole("button", { name: "Restore", exact: true })
      .click();
    await organizerPage
      .getByRole("dialog", { name: "Restore this event?", exact: true })
      .getByRole("button", { name: "Restore", exact: true })
      .click();
    await expect(lastCard.locator(".volunteer-hidden")).toHaveCount(0);
    await expect(
      lastCard.getByRole("button", { name: "Edit", exact: true }),
    ).toBeFocused();
    expect(
      await DB.prepare("SELECT cancelled_at FROM event WHERE id=?")
        .bind(lastId)
        .first("cancelled_at"),
    ).toBeNull();

    await organizerPage
      .getByRole("button", { name: "Create", exact: true })
      .click();
    const creator = organizerPage.locator("#event-editor-new");
    await creator
      .getByRole("group", { name: "Event type" })
      .getByText("Orientation + Patrol", { exact: true })
      .click();
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
    await creator.getByRole("button", { name: "Create", exact: true }).click();
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
    const uiDate = addCalendarDays(firstDate, 42);
    const uiId = `patrol:${uiSeries}:${uiDate}`;
    const uiCard = organizerPage.locator(`[data-live-event="${uiId}"]`);
    await uiCard.getByRole("button", { name: "Edit", exact: true }).click();
    const editor = uiCard.locator("dialog");
    await expect(editor).toBeVisible();
    await expect(
      editor
        .getByRole("group", { name: "Event type" })
        .getByRole("radio", { name: "Orientation + Patrol", exact: true }),
    ).toBeChecked();
    await expect(editor.getByLabel("Repeat every (weeks)")).toHaveValue("2");
    // Like Google Calendar, Save asks which events to change.
    const prompt = organizerPage.locator("dialog").filter({
      has: organizerPage.getByRole("group", { name: "Apply changes to" }),
    });
    const saveTo = async (dialog: typeof editor, scope?: string) => {
      await dialog.getByRole("button", { name: "Save", exact: true }).click();
      if (scope) await prompt.getByText(scope, { exact: true }).click();
      await prompt.getByRole("button", { name: "Save", exact: true }).click();
    };
    // A new repeat schedule can't apply to one date alone.
    await editor.getByLabel("Repeat every (weeks)").fill("3");
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    await expect(
      prompt.getByRole("radio", { name: "This event", exact: true }),
    ).toBeDisabled();
    await expect(
      prompt.getByRole("radio", {
        name: "This and following events",
        exact: true,
      }),
    ).toBeChecked();
    await prompt.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(prompt).toHaveCount(0);
    await expect(editor).toBeVisible();
    await editor.getByLabel("Repeat every (weeks)").fill("2");
    await editor
      .getByRole("group", { name: "Event type" })
      .getByText("Patrol", { exact: true })
      .click();
    await editor
      .getByLabel("Meeting point", { exact: true })
      .fill("UI future meeting point");
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    await expect(
      prompt.getByRole("radio", { name: "This event", exact: true }),
    ).toBeChecked();
    await prompt
      .getByText("This and following events", { exact: true })
      .click();
    await prompt.getByRole("button", { name: "Save", exact: true }).click();
    await expect(uiCard.locator("dialog")).not.toBeVisible();
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
      .getByRole("group", { name: "Event type" })
      .getByText("Orientation + Patrol", { exact: true })
      .click();
    await saveTo(uiCard.locator("dialog"));
    await expect(uiCard.locator("dialog")).not.toBeVisible();
    expect(
      await DB.prepare("SELECT includes_orientation FROM event WHERE id=?")
        .bind(uiId)
        .first("includes_orientation"),
    ).toBe(1);

    // All events: a new time and a weekly cadence from the next upcoming date.
    const uiFirstCard = organizerPage.locator(
      `[data-live-event="patrol:${uiSeries}:${firstDate}"]`,
    );
    await uiFirstCard
      .getByRole("button", { name: "Edit", exact: true })
      .click();
    const firstEditor = uiFirstCard.locator("dialog");
    await firstEditor.getByLabel("Start time").fill("19:15");
    await firstEditor.getByLabel("Repeat every (weeks)").fill("1");
    await saveTo(firstEditor, "All events");
    await expect(firstEditor).not.toBeVisible();
    const weeklyId = `patrol:${uiSeries}:${addCalendarDays(firstDate, 7)}`;
    await expect(
      organizerPage.locator(`[data-live-event="${weeklyId}"]`),
    ).toHaveCount(1);
    expect(
      await DB.prepare("SELECT starts_at FROM event WHERE id=?")
        .bind(weeklyId)
        .first<number>("starts_at")
        .then((start) => vancouverInput(start!)),
    ).toBe(`${addCalendarDays(firstDate, 7)}T19:15`);

    // A shorter last date from one event removes the later dates.
    await uiFirstCard
      .getByRole("button", { name: "Edit", exact: true })
      .click();
    await firstEditor
      .getByLabel("Last recurring date (optional, inclusive)")
      .fill(addCalendarDays(firstDate, 28));
    await saveTo(firstEditor);
    await expect(firstEditor).not.toBeVisible();
    await expect(uiCard).toHaveCount(0);
    expect(
      await DB.prepare("SELECT end_date FROM patrol_series WHERE id=?")
        .bind(uiSeries)
        .first("end_date"),
    ).toBe(addCalendarDays(firstDate, 28));

    await uiFirstCard
      .getByRole("button", { name: "Edit", exact: true })
      .click();
    await uiFirstCard
      .getByRole("button", { name: "Cancel event", exact: true })
      .click();
    const cancelForm = uiFirstCard.locator("[data-event-cancel]");
    await cancelForm
      .getByText("This and following events", { exact: true })
      .click();
    await expect(
      cancelForm.getByRole("heading", { name: "Cancel event?", exact: true }),
    ).toBeVisible();
    await expect(cancelForm.locator("[data-event-cancel-reason]")).toBeHidden();
    await uiFirstCard
      .getByRole("button", { name: "Confirm cancellation", exact: true })
      .click();
    await expect(uiFirstCard).toHaveCount(0);
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
    await expect(uiFirstCard).toHaveCount(0);
    // Their event records and audit history remain after reload.
    expect(
      await DB.prepare("SELECT count(*) n FROM event WHERE id=?")
        .bind(uiId)
        .first("n"),
    ).toBe(1);
    // The same production script still initializes task4's extracted browser:
    // live searching must retain its approval filter and refresh its queue count.
    const awaiting = await DB.prepare(
      "SELECT count(*) n FROM profile p JOIN volunteer_status v ON v.user_id=p.user_id JOIN user u ON u.id=p.user_id WHERE v.registration_approved=0 AND v.application_rejection_reason IS NULL AND p.registered_at IS NOT NULL AND p.naloxone_completed_at IS NOT NULL AND u.deleted_at IS NULL",
    ).first<number>("n");
    await organizerPage.goto(`${origin}/applications?approval=awaiting`);
    await expect(
      organizerPage.locator("[data-awaiting-approval-count]"),
    ).toHaveText(String(awaiting));
    await organizerPage
      .locator("[data-volunteer-search]")
      .fill("No matching applicant");
    await expect(
      organizerPage.locator("[data-volunteer-results]"),
    ).toContainText("No applications ready for review match your search");
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
    // Every date in the next two months is listed; the started one moves to history.
    for (const days of [28, 42, 56])
      await expect(
        page.locator(
          `[data-live-event="patrol:${series.id}:${addCalendarDays(firstDate, days)}"]`,
        ),
      ).toBeVisible();
    await expect(
      page.locator(`[data-event-list] [data-live-event="${initial[0].id}"]`),
    ).toHaveCount(0, { timeout: 15_000 });
    const pastCard = page.locator(
      `[data-past-event-list] [data-live-event="${initial[0].id}"]`,
    );
    await expect(pastCard).toBeVisible();
    await expect(pastCard).toContainText("You registered");
    // The default unregister window stays open after the start.
    await expect(pastCard.locator("[data-live-signup] button")).toHaveText(
      "Unregister",
    );
    await expect(
      page.getByRole("group", { name: "Filter events" }),
    ).toHaveCount(0);
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
