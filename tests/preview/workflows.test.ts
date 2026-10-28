import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "vitest";
import { chromium, expect } from "@playwright/test";
import { createTestHarness } from "wrangler";
import { createSignInOTP } from "../helpers/email-otp";
import { seedVerifiedDiscordMembership } from "../helpers/discord";
import { profileWriteBody } from "../helpers/profile-write";
import { sampleAnswers } from "../helpers/local-account";
import { addCalendarDays, vancouverInput } from "../../src/data/event-time";

test("built Preview walkthrough: submission suppression, conflicts, approval queue and recurring management", async () => {
  const origin = "https://task7-preview.example.org";
  const secret = "task7-preview-only-test-secret-12345678901234567890";
  const server = createTestHarness({
    workers: [
      {
        configPath: "dist-preview/server/wrangler.json",
        // Deliberately wrong runtime mode: the Preview build must still suppress
        // organizer mail. Never supply a real provider key to this local harness.
        vars: { APP_ENV: "production", AUTH_BASE_URL: "" },
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
    await worker.applyD1Migrations("DB");
    const { DB } = await worker.getEnv();
    const send = (path: string, body?: object, cookie = "") =>
      worker.fetch(`${origin}${path}`, {
        method: body ? "POST" : "GET",
        headers: { origin, cookie, "content-type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    const ok = async (
      response: Awaited<ReturnType<typeof send>>,
      status = 200,
    ) => {
      assert.equal(response.status, status, await response.clone().text());
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
    const person = async (email: string, preferredName: string) => {
      const cookie = await signIn(email);
      const body = await profileWriteBody(
        (path) => send(path, undefined, cookie),
        {
          ...sampleAnswers,
          preferredName,
          codeOfConductAccepted: true,
        },
      );
      const saved = (await (
        await ok(await send("/api/v1/account/profile", body, cookie))
      ).json()) as { firstSubmitted: boolean };
      assert.equal(saved.firstSubmitted, true);
      const state = (await (
        await send("/api/v1/account/application-draft", undefined, cookie)
      ).json()) as { userId: string };
      return { id: state.userId, email, cookie, body };
    };
    const organizer = await person(
      "task7-organizer@example.org",
      "Sample Organizer",
    );
    const applicant = await person(
      "task7-applicant@example.org",
      "Sample Applicant",
    );
    const retry = (await (
      await ok(
        await send(
          "/api/v1/account/profile",
          { ...applicant.body, phone: "604-555-0199" },
          applicant.cookie,
        ),
      )
    ).json()) as { alreadySubmitted: boolean };
    assert.equal(retry.alreadySubmitted, true);
    assert.deepEqual(
      (
        await DB.prepare(
          "SELECT mode,status,payload FROM application_submission_notification",
        ).all()
      ).results,
      Array.from({ length: 6 }, () => ({
        mode: "preview",
        status: "suppressed",
        payload: null,
      })),
    );
    await DB.prepare("INSERT INTO organizer_bootstrap VALUES (1,?,?)")
      .bind(organizer.id, Date.now())
      .run();
    organizer.cookie = await signIn(organizer.email);
    await ok(
      await send(
        "/api/v1/organizer/action",
        {
          action: "status",
          userId: applicant.id,
          version: 0,
          active: true,
          applicationApproved: true,
          patrolApproved: false,
        },
        organizer.cookie,
      ),
      409,
    );
    await ok(
      await send(
        "/api/v1/account/naloxone",
        { userId: applicant.id, completed: true },
        applicant.cookie,
      ),
    );
    await seedVerifiedDiscordMembership(DB, applicant.id);

    const context = await browser.newContext();
    await context.addCookies(
      organizer.cookie.split("; ").map((entry) => {
        const index = entry.indexOf("=");
        return {
          name: entry.slice(0, index),
          value: entry.slice(index + 1),
          url: origin,
        };
      }),
    );
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/*", async (route) => {
      const request = route.request();
      if (!request.url().startsWith(origin)) return route.abort();
      const response = await worker.fetch(request.url(), {
        method: request.method(),
        headers: await request.allHeaders(),
        body: request.postDataBuffer() ?? undefined,
        redirect: "manual",
      });
      await route.fulfill({
        status: response.status,
        headers: Object.fromEntries(response.headers),
        body: Buffer.from(await response.arrayBuffer()),
      });
    });
    await page.goto(`${origin}/manage/volunteers?approval=awaiting`);
    await expect(
      page.locator('[aria-label="Preview environment"]'),
    ).toBeVisible();
    await expect(page.locator("[data-awaiting-approval-count]")).toHaveText(
      "2",
    );
    await page.locator("[data-volunteer-search]").fill("Sample Applicant");
    await expect(page.locator("[data-volunteer-results] tbody tr")).toHaveCount(
      1,
    );
    await expect(page.locator("[data-awaiting-approval-count]")).toHaveText(
      "2",
    );
    await page.locator("[data-volunteer-profile-link]").click();
    await page
      .getByRole("button", { name: "Approve application", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Save without email", exact: true })
      .click();
    await expect(
      page.getByRole("button", {
        name: "Revoke application approval",
        exact: true,
      }),
    ).toBeEnabled();
    await page.getByRole("link", { name: "Back to volunteers" }).click();
    await expect(page.locator("[data-awaiting-approval-count]")).toHaveText(
      "1",
    );
    await expect(page.locator("[data-volunteer-results] tbody tr")).toHaveCount(
      0,
    );
    assert.equal(new URL(page.url()).searchParams.get("approval"), "awaiting");
    assert.equal(
      await DB.prepare("SELECT count(*) n FROM event_notification").first("n"),
      0,
    );

    // Conflict API against this same built Preview: independent edits merge;
    // conflicting answers require explicit choice and leave submission untouched.
    const original = await DB.prepare(
      "SELECT submitted_application FROM profile WHERE user_id=?",
    )
      .bind(applicant.id)
      .first();
    const baselineBody = await profileWriteBody(
      (path) => send(path, undefined, applicant.cookie),
      {},
    );
    const baseline = (baselineBody as { baseline: typeof sampleAnswers })
      .baseline;
    const edit = (extra: object) =>
      send(
        "/api/v1/account/profile",
        { ...baseline, ...baselineBody, ...extra, intent: "edit" },
        applicant.cookie,
      );
    await ok(await edit({ phone: "604-555-0111" }));
    await ok(await edit({ pronouns: "they/them" }));
    await ok(await edit({ phone: "604-555-0122" }), 409);
    assert.deepEqual(
      await DB.prepare(
        "SELECT submitted_application FROM profile WHERE user_id=?",
      )
        .bind(applicant.id)
        .first(),
      original,
    );
    assert.equal(
      await DB.prepare(
        "SELECT count(*) n FROM application_submission_notification",
      ).first("n"),
      6,
    );
    await DB.prepare(
      "UPDATE volunteer_status SET patrol_approved=1,approved_by=?,approved_at=? WHERE user_id=?",
    )
      .bind(organizer.id, Date.now(), applicant.id)
      .run();

    const firstDate = addCalendarDays(
      vancouverInput(Date.now()).slice(0, 10),
      2,
    );
    const action = (body: object, cookie = organizer.cookie) =>
      send("/api/v1/events/action", body, cookie);
    const created = (await (
      await ok(
        await action({
          action: "save-series",
          series: {
            firstDate,
            localTime: "20:30",
            intervalWeeks: 2,
            endDate: null,
            meetingPoint: "Sample recurring point",
            meetingPointUrl: "",
            spots: 3,
            open: true,
            hidden: false,
          },
        }),
      )
    ).json()) as { id: string };
    const eventId = `patrol:${created.id}:${firstDate}`;
    await ok(await action({ action: "join", id: eventId }, applicant.cookie));
    const farDate = addCalendarDays(firstDate, 84);
    const farId = `patrol:${created.id}:${farDate}`;
    await ok(
      await action({
        action: "materialize-occurrence",
        id: created.id,
        occurrenceDate: farDate,
      }),
    );
    await ok(
      await action({ action: "join", id: farId }, applicant.cookie),
      409,
    );
    await page.goto(
      `${origin}/manage/events?occurrence=${encodeURIComponent(farId)}`,
    );
    const farCard = page.locator(`[data-live-event="${farId}"]`);
    await expect(farCard).toBeVisible();
    await expect(
      farCard.getByRole("button", { name: "Edit", exact: true }),
    ).toBeEnabled();
    const version = () =>
      DB.prepare("SELECT updated_at FROM patrol_series WHERE id=?")
        .bind(created.id)
        .first<number>("updated_at");
    await ok(
      await action({
        action: "update-series-from",
        id: created.id,
        occurrenceDate: firstDate,
        version: await version(),
        template: {
          localTime: "21:15",
          dayOffset: 1,
          meetingPoint: "Sample changed point",
          meetingPointUrl: "",
          spots: 3,
          open: true,
          hidden: false,
        },
      }),
    );
    const shifted = await DB.prepare(
      "SELECT occurrence_date,starts_at FROM event WHERE id=?",
    )
      .bind(eventId)
      .first<{ occurrence_date: string; starts_at: number }>();
    assert.equal(shifted?.occurrence_date, firstDate);
    assert.equal(
      vancouverInput(shifted!.starts_at),
      `${addCalendarDays(firstDate, 1)}T21:15`,
    );
    const operation = await DB.prepare(
      "SELECT id FROM patrol_series_audit WHERE action='updated_future'",
    ).first<string>("id");
    await ok(await action({ action: "retry-notifications", operation }));
    const visible = (await (
      await ok(await send("/api/v1/events", undefined, applicant.cookie))
    ).json()) as { events: { id: string }[] };
    assert.equal(
      visible.events.filter((event) =>
        event.id.startsWith(`patrol:${created.id}:`),
      ).length,
      3,
    );
    await ok(
      await action({
        action: "stop-series",
        id: created.id,
        occurrenceDate: firstDate,
        version: await version(),
      }),
    );
    assert.equal(
      await DB.prepare("SELECT status FROM signup WHERE event_id=?")
        .bind(eventId)
        .first("status"),
      "cancelled",
    );
    const stopped = await DB.prepare(
      "SELECT stopped_from FROM patrol_series WHERE id=?",
    )
      .bind(created.id)
      .first("stopped_from");
    assert.equal(stopped, firstDate);
    assert.deepEqual(errors, []);
    await context.close();
  } finally {
    await browser.close();
    await server.close();
  }
}, 60_000);
