import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { createTestHarness } from "wrangler";
import { chromium, expect, type Locator } from "@playwright/test";
import { inPlaceAction } from "../helpers/in-place-action";
import { createSignInOTP } from "../helpers/email-otp";
import { totpFromSetupKey } from "../helpers/totp";

const origin = "https://afterhoursoutreach.ca";
const secret = "worker-event-test-secret-12345678901234567890";
const answers = {
  name: "Sample Volunteer",
  pronouns: "they/them",
  phone: "604-555-0100",
  birthDate: "1995-04-12",
  emergencyName: "Sample contact",
  emergencyPhone: "604-555-0101",
  emergencyRelationship: "Friend",
  heardAboutUs: "Friend",
  motivation: "Sample answer",
  teams: ["outreach"],
  certification: "None",
  experience: "None",
  medicalConditions: "PRIVATE HEALTH ANSWER",
};
const cookies = (response: { headers: { getSetCookie(): string[] } }) =>
  response.headers
    .getSetCookie()
    .filter((cookie) => !cookie.includes("Max-Age=0"))
    .map((cookie) => cookie.split(";")[0])
    .join("; ");

test("real event and organizer flows in the built Worker", async (t) => {
  const server = createTestHarness({
    workers: [
      {
        configPath: "dist/server/wrangler.json",
        vars: {
          APP_ENV: "production",
          AUTH_BASE_URL: "",
        },
        secrets: { BETTER_AUTH_SECRET: secret, RESEND_API_KEY: "" },
      },
    ],
  });
  try {
    await server.listen();
    const worker = server.getWorker<Env>();
    await worker.applyD1Migrations("DB");
    const { DB } = await worker.getEnv();
    const cookieIPs = new Map<string, string>();
    const send = (
      path: string,
      body?: object,
      cookie?: string,
      requestOrigin = origin,
      ip = cookieIPs.get(cookie ?? "") ?? "192.0.2.1",
    ) =>
      worker.fetch(`${origin}${path}`, {
        method: body ? "POST" : "GET",
        redirect: "manual",
        headers: {
          origin: requestOrigin,
          "content-type": "application/json",
          "cf-connecting-ip": ip,
          ...(cookie ? { cookie } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    const ok = async <
      T extends { status: number; clone(): { text(): Promise<string> } },
    >(
      response: T,
      status = 200,
    ) => {
      assert.equal(response.status, status, await response.clone().text());
      return response;
    };
    const signIn = async (email: string, factorKey?: string) => {
      const ip =
        email === "bob@example.org"
          ? "192.0.2.2"
          : email === "alice@example.org"
            ? "192.0.2.3"
            : "192.0.2.1";
      const proof = await createSignInOTP(DB, secret, email);
      const response = await ok(
        await send(
          "/api/auth/sign-in/email-otp?returnTo=%2Fvolunteer",
          proof,
          undefined,
          origin,
          ip,
        ),
      );
      let cookie = cookies(response);
      cookieIPs.set(cookie, ip);
      if (factorKey)
        cookie = cookies(
          await ok(
            await send(
              "/api/auth/two-factor/verify-totp",
              { code: totpFromSetupKey(factorKey) },
              cookie,
            ),
          ),
        );
      cookieIPs.set(cookie, ip);
      return cookie;
    };
    const person = async (email: string, name: string) => {
      let cookie = await signIn(email);
      await ok(
        await send("/api/account/profile", { ...answers, name }, cookie),
      );
      const session = (await (
        await ok(await send("/api/auth/get-session", undefined, cookie))
      ).json()) as { user: { id: string }; session: { id: string } };
      return {
        cookie,
        id: session.user.id,
        sessionId: session.session.id,
        email,
      };
    };
    const organizer = await person("organizer@example.org", "Sample Organizer");
    const alice = await person("alice@example.org", "Sample Alice");
    const bob = await person("bob@example.org", "Sample Bob");
    const eventInput = (type = "orientation", spots = 2) => ({
      type,
      startsAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      meetingPoint: "Sample meeting point",
      meetingPointUrl: "https://example.org/map",
      spots,
      open: true,
      hidden: false,
    });

    await t.test(
      "new databases show a genuine empty event list, not sample fixtures",
      async () => {
        const response = await ok(await send("/volunteer"));
        assert.match(await response.text(), /No upcoming events are scheduled/);
        const list = (await (await ok(await send("/api/events"))).json()) as {
          events: unknown[];
        };
        assert.deepEqual(list.events, []);
      },
    );

    await t.test(
      "bootstrap requires verified registration but not two-factor, is atomic and one-time",
      async () => {
        await DB.prepare("UPDATE user SET email_verified=0 WHERE id=?")
          .bind(organizer.id)
          .run();
        await assert.rejects(
          DB.prepare("INSERT INTO organizer_bootstrap VALUES(1,?,?)")
            .bind(organizer.id, Date.now())
            .run(),
          /organizer_not_ready/,
        );
        await DB.prepare("UPDATE user SET email_verified=1 WHERE id=?")
          .bind(organizer.id)
          .run();
        assert.equal(
          (
            await DB.prepare(
              "SELECT count(*) AS n FROM audit_log WHERE action='role_changed'",
            ).first()
          )?.n,
          0,
        );
        assert.equal(
          (
            await DB.prepare("SELECT two_factor_enabled FROM user WHERE id=?")
              .bind(organizer.id)
              .first()
          )?.two_factor_enabled,
          0,
        );
        await DB.prepare("INSERT INTO organizer_bootstrap VALUES(1,?,?)")
          .bind(organizer.id, Date.now())
          .run();
        assert.equal(
          (
            await DB.prepare(
              "SELECT count(*) AS n FROM session WHERE user_id=?",
            )
              .bind(organizer.id)
              .first()
          )?.n,
          0,
        );
        organizer.cookie = await signIn(organizer.email);
        await assert.rejects(
          DB.prepare("INSERT INTO organizer_bootstrap VALUES(1,?,?)")
            .bind(alice.id, Date.now())
            .run(),
          /organizer_already_exists|UNIQUE/,
        );
      },
    );

    await t.test(
      "visitors and volunteers cannot perform organizer actions; CSRF is rejected",
      async () => {
        await ok(
          await send("/api/events/action", {
            action: "save",
            event: eventInput(),
          }),
          401,
        );
        await ok(
          await send(
            "/api/events/action",
            { action: "save", event: eventInput() },
            alice.cookie,
          ),
          403,
        );
        await ok(
          await send(
            "/api/organizer/action",
            { action: "role", userId: alice.id, role: "organizer" },
            alice.cookie,
          ),
          403,
        );
        await ok(
          await send(
            "/api/events/action",
            { action: "save", event: eventInput() },
            organizer.cookie,
            "https://evil.example",
          ),
          403,
        );
        await ok(
          await send(
            `/volunteer/volunteers/${alice.id}`,
            undefined,
            alice.cookie,
          ),
          403,
        );
        await ok(await send("/volunteer/volunteers"), 302);
      },
    );

    const createEvent = async (type = "orientation", spots = 2) => {
      const data = eventInput(type, spots);
      await ok(
        await send(
          "/api/events/action",
          { action: "save", event: data },
          organizer.cookie,
        ),
      );
      const row = await DB.prepare(
        "SELECT id,updated_at AS version FROM event ORDER BY created_at DESC LIMIT 1",
      ).first<{ id: string; version: number }>();
      assert.ok(row);
      return { ...row, data };
    };
    const orientation = await createEvent("orientation", 1);
    const patrol = await createEvent("patrol", 3);
    const destination = await createEvent("orientation", 2);
    const join = (eventId: string, cookie: string) =>
      send("/api/events/action", { action: "join", id: eventId }, cookie);
    const status = async (
      userId: string,
      active = true,
      patrolApproved = true,
    ) => {
      const row = await DB.prepare(
        "SELECT updated_at AS version FROM volunteer_status WHERE user_id=?",
      )
        .bind(userId)
        .first<{ version: number }>();
      return send(
        "/api/organizer/action",
        {
          action: "status",
          userId,
          version: row!.version,
          active,
          patrolApproved,
        },
        organizer.cookie,
      );
    };

    await t.test(
      "real listings have no invented events, demo code or signed-out account menu",
      async () => {
        const response = await ok(await send("/volunteer"));
        const html = await response.text();
        assert.doesNotMatch(html, /Preview · public test site/);
        assert.match(html, /Sample meeting point/);
        assert.doesNotMatch(
          html,
          /preview-event|data-account-switcher|View as|Sample Alice|PRIVATE HEALTH ANSWER|data-account-menu/,
        );
        assert.match(response.headers.get("cache-control")!, /no-store/);
        const summaries = (await (
          await ok(await send("/api/events"))
        ).json()) as { events: unknown[] };
        assert.equal(summaries.events.length, 3);
        assert.doesNotMatch(
          JSON.stringify(summaries),
          /PRIVATE HEALTH ANSWER|Sample Alice|userId|confirmed|signedUp|version/,
        );
      },
    );

    await t.test(
      "last spot is atomic across simultaneous signups without queuing email",
      async () => {
        const responses = await Promise.all([
          join(orientation.id, alice.cookie),
          join(orientation.id, bob.cookie),
        ]);
        assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
        const result = (await responses
          .find((r) => r.status === 200)!
          .json()) as {
          sent: number;
          failed: number;
          pending: number;
          localNotifications?: unknown;
          message: string;
        };
        assert.equal(result.sent, 0);
        assert.equal(result.failed, 0);
        assert.equal(result.pending, 0);
        assert.equal(result.message, "Your spot is confirmed.");
        assert.equal(result.localNotifications, undefined);
        assert.equal(
          (
            await DB.prepare(
              "SELECT count(*) AS n FROM event_notification",
            ).first()
          )?.n,
          0,
        );
        assert.equal(
          (
            await DB.prepare(
              "SELECT count(*) AS n FROM signup WHERE event_id=? AND status='confirmed'",
            )
              .bind(orientation.id)
              .first()
          )?.n,
          1,
        );
      },
    );

    await t.test(
      "approval without orientation grants patrol access, arbitrary client role does not",
      async () => {
        await ok(await join(patrol.id, alice.cookie), 403);
        await ok(await status(alice.id));
        await ok(await join(patrol.id, alice.cookie));
        await ok(
          await send(
            "/api/events/action",
            { action: "join", id: patrol.id, role: "organizer" },
            bob.cookie,
          ),
          400,
        );
        const approved = await DB.prepare(
          "SELECT approved_by FROM volunteer_status WHERE user_id=?",
        )
          .bind(alice.id)
          .first();
        assert.equal(approved?.approved_by, organizer.id);
      },
    );

    await t.test(
      "volunteer signups and cancellations preserve records and audits without emails",
      async () => {
        for (const type of ["orientation", "patrol"]) {
          const event = await createEvent(type);
          const before = await DB.prepare(
            "SELECT count(*) AS n FROM event_notification",
          ).first();
          const joined = await ok(await join(event.id, alice.cookie));
          const confirmed = await DB.prepare(
            "SELECT id, status FROM signup WHERE event_id=? AND user_id=?",
          )
            .bind(event.id, alice.id)
            .first<{ id: string; status: string }>();
          assert.equal(confirmed?.status, "confirmed");
          const cancelled = await ok(
            await send(
              "/api/events/action",
              { action: "cancel", id: event.id },
              alice.cookie,
            ),
          );
          for (const response of [joined, cancelled]) {
            const result = (await response.json()) as {
              sent: number;
              failed: number;
              pending: number;
              expired: number;
              localNotifications?: unknown;
              message: string;
            };
            assert.deepEqual(
              {
                sent: result.sent,
                failed: result.failed,
                pending: result.pending,
                expired: result.expired,
              },
              { sent: 0, failed: 0, pending: 0, expired: 0 },
            );
            assert.equal(result.localNotifications, undefined);
            assert.ok(
              [
                "Your spot is confirmed.",
                "Your signup was cancelled.",
              ].includes(result.message),
            );
          }
          assert.equal(
            (
              await DB.prepare(
                "SELECT count(*) AS n FROM event_notification",
              ).first()
            )?.n,
            before?.n,
          );
          assert.equal(
            (
              await DB.prepare("SELECT status FROM signup WHERE id=?")
                .bind(confirmed!.id)
                .first()
            )?.status,
            "cancelled",
          );
          const audits = await DB.prepare(
            "SELECT action FROM event_audit WHERE event_id=? AND action IN ('signup_joined', 'signup_cancelled') ORDER BY action",
          )
            .bind(event.id)
            .all<{ action: string }>();
          assert.deepEqual(
            audits.results.map((row) => row.action),
            ["signup_cancelled", "signup_joined"],
          );
        }
      },
    );

    await t.test(
      "organizers without two-factor can manage events and view audited profiles",
      async () => {
        const session = (await (
          await send("/api/auth/get-session", undefined, organizer.cookie)
        ).json()) as { session: { id: string } };
        assert.equal(
          (
            await DB.prepare(
              "SELECT two_factor_verified FROM session WHERE id=?",
            )
              .bind(session.session.id)
              .first()
          )?.two_factor_verified,
          0,
        );
        await ok(
          await send(
            "/api/events/action",
            { action: "save", event: eventInput() },
            organizer.cookie,
          ),
        );
        const response = await ok(
          await send(
            `/volunteer/volunteers/${alice.id}`,
            undefined,
            organizer.cookie,
          ),
        );
        assert.match(await response.text(), /PRIVATE HEALTH ANSWER/);
        const logs = await DB.prepare(
          "SELECT * FROM audit_log WHERE action='profile_viewed' AND subject_id=?",
        )
          .bind(alice.id)
          .all();
        assert.equal(logs.results.length, 1);
        assert.doesNotMatch(
          JSON.stringify(logs.results),
          /PRIVATE HEALTH ANSWER/,
        );
        assert.equal(response.headers.get("referrer-policy"), "no-referrer");
        const team = await ok(
          await send("/volunteer/volunteers", undefined, organizer.cookie),
        );
        assert.doesNotMatch(await team.text(), /PRIVATE HEALTH ANSWER/);
      },
    );

    await t.test(
      "capacity, optimistic edit conflicts, hidden and closed events are enforced",
      async () => {
        await ok(await join(patrol.id, bob.cookie), 403);
        const row = await DB.prepare(
          "SELECT updated_at AS version FROM event WHERE id=?",
        )
          .bind(patrol.id)
          .first<{ version: number }>();
        await ok(
          await send(
            "/api/events/action",
            {
              action: "save",
              id: patrol.id,
              version: row!.version,
              event: { ...patrol.data, spots: 1 },
            },
            organizer.cookie,
          ),
        );
        await ok(await status(bob.id));
        await ok(await join(patrol.id, bob.cookie), 409);
        await ok(
          await send(
            "/api/events/action",
            {
              action: "save",
              id: patrol.id,
              version: row!.version,
              event: { ...patrol.data, spots: 2 },
            },
            organizer.cookie,
          ),
          409,
        );
        const version = (await DB.prepare(
          "SELECT updated_at AS version FROM event WHERE id=?",
        )
          .bind(patrol.id)
          .first<{ version: number }>())!.version;
        await ok(
          await send(
            "/api/events/action",
            {
              action: "save",
              id: patrol.id,
              version,
              event: { ...patrol.data, spots: 2, hidden: true },
            },
            organizer.cookie,
          ),
        );
        assert.doesNotMatch(
          await (await send("/volunteer")).text(),
          new RegExp(`data-live-event="${patrol.id}"`),
        );
        assert.match(
          await (await send("/volunteer", undefined, alice.cookie)).text(),
          new RegExp(`data-live-event="${patrol.id}"`),
        );
        await ok(await join(patrol.id, bob.cookie), 403);
      },
    );

    await t.test(
      "move rollback preserves source signup when destination is full",
      async () => {
        const signedUp = await DB.prepare(
          "SELECT id,user_id AS userId FROM signup WHERE event_id=? AND status='confirmed'",
        )
          .bind(orientation.id)
          .first<{ id: string; userId: string }>();
        const other = signedUp!.userId === alice.id ? bob : alice;
        await ok(await join(destination.id, alice.cookie));
        await ok(await join(destination.id, bob.cookie));
        await ok(
          await send(
            "/api/events/action",
            {
              action: "manage-signup",
              id: signedUp!.id,
              destination: destination.id,
              reason: "Sample reason",
              notify: true,
            },
            organizer.cookie,
          ),
          409,
        );
        assert.equal(
          (
            await DB.prepare("SELECT status FROM signup WHERE id=?")
              .bind(signedUp!.id)
              .first()
          )?.status,
          "confirmed",
        );
        await ok(
          await send(
            "/api/events/action",
            { action: "cancel", id: destination.id },
            other.cookie,
          ),
        );
        // Free the original attendee's destination signup as well, then move.
        const attendee = signedUp!.userId === alice.id ? alice : bob;
        await ok(
          await send(
            "/api/events/action",
            { action: "cancel", id: destination.id },
            attendee.cookie,
          ),
        );
        await ok(
          await send(
            "/api/events/action",
            {
              action: "manage-signup",
              id: signedUp!.id,
              destination: destination.id,
              reason: "Sample reason",
              notify: true,
            },
            organizer.cookie,
          ),
        );
        assert.equal(
          (
            await DB.prepare("SELECT status FROM signup WHERE id=?")
              .bind(signedUp!.id)
              .first()
          )?.status,
          "cancelled",
        );
        assert.equal(
          (
            await DB.prepare(
              "SELECT count(*) AS n FROM event_notification WHERE body LIKE '%Sample reason%'",
            ).first()
          )?.n,
          1,
        );
      },
    );

    await t.test(
      "orientation completion requires an actual past attendance and never approves patrols",
      async () => {
        const attendee = await DB.prepare(
          "SELECT user_id AS userId FROM signup WHERE event_id=? AND status='confirmed'",
        )
          .bind(destination.id)
          .first<{ userId: string }>();
        await ok(
          await send(
            "/api/organizer/action",
            {
              action: "orientation",
              userId: attendee!.userId,
              eventId: destination.id,
            },
            organizer.cookie,
          ),
          409,
        );
        await DB.prepare("UPDATE event SET starts_at=? WHERE id=?")
          .bind(Date.now() - 1000, destination.id)
          .run();
        await ok(
          await send(
            "/api/organizer/action",
            {
              action: "orientation",
              userId: attendee!.userId,
              eventId: destination.id,
            },
            organizer.cookie,
          ),
        );
        await ok(
          await send(
            "/api/organizer/action",
            {
              action: "orientation",
              userId: attendee!.userId,
              eventId: patrol.id,
            },
            organizer.cookie,
          ),
          409,
        );
        assert.equal(
          (
            await DB.prepare(
              "SELECT count(*) AS n FROM orientation_completion WHERE user_id=?",
            )
              .bind(attendee!.userId)
              .first()
          )?.n,
          1,
        );
      },
    );

    await t.test(
      "deactivation silently cancels future spots and last organizer cannot be removed",
      async () => {
        await ok(await status(alice.id, false, false));
        const notifications = await DB.prepare(
          "SELECT count(*) AS n FROM event_notification WHERE user_id=? AND subject='Your After Hours Outreach signup was cancelled' AND body LIKE '%volunteer access changed%'",
        )
          .bind(alice.id)
          .first<{ n: number }>();
        assert.equal(notifications?.n, 0);
        assert.equal(
          (
            await DB.prepare(
              "SELECT status FROM signup WHERE event_id=? AND user_id=?",
            )
              .bind(patrol.id, alice.id)
              .first()
          )?.status,
          "cancelled",
        );
        await ok(await join(orientation.id, alice.cookie), 403);
        await ok(
          await send(
            "/api/organizer/action",
            { action: "role", userId: organizer.id, role: "volunteer" },
            organizer.cookie,
          ),
          409,
        );
        await ok(await status(organizer.id, false, false), 409);
      },
    );

    await t.test(
      "opted-in cancellation preserves records, cancels spots and queues notifications atomically",
      async () => {
        const event = await createEvent("patrol", 2);
        await ok(await join(event.id, bob.cookie));
        await ok(
          await send(
            "/api/events/action",
            {
              action: "cancel-event",
              id: event.id,
              version: event.version,
              reason: "Sample cancellation",
              notify: true,
            },
            organizer.cookie,
          ),
        );
        assert.ok(
          (
            await DB.prepare("SELECT cancelled_at FROM event WHERE id=?")
              .bind(event.id)
              .first()
          )?.cancelled_at,
        );
        assert.equal(
          (
            await DB.prepare("SELECT status FROM signup WHERE event_id=?")
              .bind(event.id)
              .first()
          )?.status,
          "cancelled",
        );
        assert.equal(
          (
            await DB.prepare(
              "SELECT count(*) AS n FROM event_notification WHERE body LIKE '%Sample cancellation%'",
            ).first()
          )?.n,
          1,
        );
        await ok(await join(event.id, bob.cookie), 403);
        await ok(
          await send(
            "/api/events/action",
            { action: "cancel-event", id: event.id, version: event.version },
            organizer.cookie,
          ),
          409,
        );
      },
    );

    await t.test(
      "organizer promotions require verified registration, not two-factor, and revoke sessions",
      async () => {
        await DB.prepare("UPDATE user SET email_verified=0 WHERE id=?")
          .bind(bob.id)
          .run();
        await ok(
          await send(
            "/api/organizer/action",
            { action: "role", userId: bob.id, role: "organizer" },
            organizer.cookie,
          ),
          409,
        );
        await DB.prepare("UPDATE user SET email_verified=1 WHERE id=?")
          .bind(bob.id)
          .run();
        assert.equal(
          (
            await DB.prepare("SELECT two_factor_enabled FROM user WHERE id=?")
              .bind(bob.id)
              .first()
          )?.two_factor_enabled,
          0,
        );
        await ok(
          await send(
            "/api/organizer/action",
            { action: "role", userId: bob.id, role: "organizer" },
            organizer.cookie,
          ),
        );
        assert.equal(
          (
            await DB.prepare(
              "SELECT count(*) AS n FROM session WHERE user_id=?",
            )
              .bind(bob.id)
              .first()
          )?.n,
          0,
        );
        bob.cookie = await signIn(bob.email);
        await ok(await send("/volunteer/volunteers", undefined, bob.cookie));
        await ok(
          await send(
            "/api/organizer/action",
            { action: "role", userId: bob.id, role: "volunteer" },
            organizer.cookie,
          ),
        );
        assert.equal(
          (
            await DB.prepare(
              "SELECT count(*) AS n FROM session WHERE user_id=?",
            )
              .bind(bob.id)
              .first()
          )?.n,
          0,
        );
        bob.cookie = await signIn(bob.email);
        await ok(
          await send("/volunteer/volunteers", undefined, bob.cookie),
          403,
        );
        const audit = await DB.prepare(
          "SELECT changed_fields FROM audit_log WHERE action='role_changed' AND subject_id=?",
        )
          .bind(bob.id)
          .all();
        assert.equal(audit.results.length, 2);
        assert.ok(
          audit.results.every((row) => row.changed_fields === '["role"]'),
        );
      },
    );

    await t.test(
      "real browser UI supports event creation and signup with nav below heading on mobile",
      async () => {
        const browser = await chromium.launch({
          executablePath:
            process.env.CHROMIUM_PATH ??
            (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined),
        });
        try {
          const page = await browser.newPage({
            viewport: { width: 375, height: 812 },
          });
          const errors: string[] = [];
          page.on("pageerror", (error) => errors.push(error.message));
          let routeCookie = organizer.cookie;
          await page.route("**/*", async (route) => {
            const request = route.request();
            if (!request.url().startsWith(origin)) return route.abort();
            const response = await worker.fetch(request.url(), {
              method: request.method(),
              headers: {
                ...(await request.allHeaders()),
                cookie: routeCookie,
              },
              ...(request.postData() ? { body: request.postData()! } : {}),
              redirect: "manual",
            });
            await route.fulfill({
              status: response.status,
              headers: Object.fromEntries(response.headers),
              body: Buffer.from(await response.arrayBuffer()),
            });
          });
          await page.goto(`${origin}/volunteer`);
          assert.equal(await page.locator("[data-action-notice]").count(), 0);
          const nav = page.getByRole("navigation", {
            name: "Volunteer account",
          });
          const account = nav.locator("[data-account-menu] > summary");
          assert.equal(
            (
              await nav.locator("[data-account-menu-name]").textContent()
            )?.trim(),
            "Sample Organizer",
          );
          await account.waitFor();
          await page.goto(`${origin}/volunteer/volunteers`);
          assert.equal(await page.locator("[data-action-notice]").count(), 0);
          await account.waitFor();
          const teamSearch = page.getByRole("searchbox", {
            name: "Find a volunteer",
          });
          await expect(
            page.getByRole("heading", { name: "Your team", exact: true }),
          ).toHaveCount(0);
          await expect(teamSearch).toHaveAttribute(
            "placeholder",
            "Search by name",
          );
          await expect(
            page.locator(".volunteer-search-field > span"),
          ).toHaveClass("sr-only");
          for (const width of [1280, 375]) {
            await page.setViewportSize({ width, height: 812 });
            await expect(page.locator(".volunteer-search-icon")).toBeVisible();
            await expect(
              page.locator(".volunteer-search-icon"),
            ).toHaveAttribute("aria-hidden", "true");
            const bounds = await teamSearch.evaluate((input) => {
              const field = input.getBoundingClientRect();
              const section = input
                .closest("[data-volunteer-browser]")!
                .getBoundingClientRect();
              return {
                widthDifference: Math.abs(field.width - section.width),
                leftDifference: Math.abs(field.left - section.left),
                paddingLeft: Number.parseFloat(
                  getComputedStyle(input).paddingLeft,
                ),
                overflow: document.documentElement.scrollWidth > innerWidth,
              };
            });
            assert.ok(bounds.widthDifference < 1);
            assert.ok(bounds.leftDifference < 1);
            assert.ok(bounds.paddingLeft >= 44);
            assert.equal(bounds.overflow, false);
          }
          await teamSearch.fill("Sample Alice");
          await page.waitForURL(
            `${origin}/volunteer/volunteers?q=Sample+Alice`,
          );
          await page
            .locator("[data-volunteer-results]")
            .getByRole("heading", { name: "Sample Alice", exact: true })
            .waitFor();
          const profileDialog = page.getByRole("dialog", {
            name: "Volunteer profile",
            exact: true,
          });
          const profilePane = profileDialog.locator(
            "[data-profile-dialog-content]",
          );
          let releaseProfile!: () => void;
          const profileGate = new Promise<void>((resolve) => {
            releaseProfile = resolve;
          });
          const profilePattern = `**/volunteer/volunteers/${alice.id}`;
          await page.route(profilePattern, async (route) => {
            await profileGate;
            await route.fallback();
          });
          const profileViewports = [
            { width: 1280, height: 900 },
            { width: 375, height: 812 },
          ];
          const loadingBounds = new Map<
            number,
            { x: number; y: number; width: number; height: number }
          >();
          await page.evaluate(() => {
            document.addEventListener("animationstart", (event) => {
              if (event.animationName === "volunteer-profile-fade-in")
                document.documentElement.dataset.testProfileFadeIn = "true";
              if (event.animationName === "volunteer-profile-fade-out")
                document.documentElement.dataset.testProfileFadeOut = "true";
            });
          });
          try {
            await page
              .getByRole("link", {
                name: "View profile and approval",
                exact: true,
              })
              .click();
            await expect(profilePane).toHaveAttribute("aria-busy", "true");
            await expect(
              profilePane.getByText("Loading", {
                exact: true,
              }),
            ).toBeVisible();
            await expect(
              profilePane.locator(".volunteer-profile-loading-icon"),
            ).toBeVisible();
            await expect(
              profilePane.locator(".volunteer-profile-loading-icon"),
            ).toHaveAttribute("aria-hidden", "true");
            await expect(
              profilePane.locator(".volunteer-profile-loading"),
            ).toHaveCSS("align-items", "center");
            await expect(
              profilePane.locator(".volunteer-profile-loading"),
            ).toHaveCSS("justify-content", "center");
            for (const viewport of profileViewports) {
              await page.setViewportSize(viewport);
              await expect
                .poll(async () =>
                  Math.abs(
                    (await profileDialog.boundingBox())!.height -
                      Math.min(800, viewport.height - 48),
                  ),
                )
                .toBeLessThan(1);
              await expect
                .poll(async () =>
                  Math.abs(
                    (await profileDialog.boundingBox())!.y -
                      (viewport.height - Math.min(800, viewport.height - 48)) /
                        2,
                  ),
                )
                .toBeLessThan(1);
              loadingBounds.set(
                viewport.width,
                (await profileDialog.boundingBox())!,
              );
              await expect(
                profileDialog.getByRole("button", {
                  name: "Close volunteer profile",
                  exact: true,
                }),
              ).toBeVisible();
            }
          } finally {
            releaseProfile();
          }
          await profileDialog
            .getByRole("heading", { name: "Sample Alice", exact: true })
            .waitFor();
          await page.unroute(profilePattern);
          await expect(profilePane).not.toHaveAttribute("aria-busy", "true");
          await expect(
            profilePane.locator(".volunteer-profile-loading"),
          ).toHaveCount(0);
          await expect(page.locator("html")).toHaveAttribute(
            "data-test-profile-fade-in",
            "true",
          );
          await expect(page.locator("html")).toHaveAttribute(
            "data-test-profile-fade-out",
            "true",
          );
          await expect(
            profilePane.locator("[data-volunteer-profile]"),
          ).not.toHaveAttribute("data-profile-entering");
          // The frame stays identical as the loader fades into a long profile.
          for (const viewport of profileViewports) {
            await page.setViewportSize(viewport);
            const before = loadingBounds.get(viewport.width)!;
            const after = (await profileDialog.boundingBox())!;
            for (const key of ["x", "y", "width", "height"] as const)
              assert.ok(
                Math.abs(before[key] - after[key]) < 1,
                JSON.stringify({ key, before, after, viewport }),
              );
            await profileDialog
              .getByLabel("Active volunteer", { exact: true })
              .focus();
            await page.keyboard.press("Tab");
            const roleSelect = profileDialog.getByLabel("Account role");
            await expect(roleSelect).toBeFocused();
            await expect(roleSelect).toHaveCSS("outline-style", "solid");
            await expect(roleSelect).toHaveCSS("outline-width", "3px");
            await expect(roleSelect).toHaveCSS("outline-offset", "4px");
            const focusFits = await roleSelect.evaluate((select) => {
              const field = select.getBoundingClientRect();
              const popup = select.closest("dialog")!.getBoundingClientRect();
              const style = getComputedStyle(select);
              const ring =
                Number.parseFloat(style.outlineOffset) +
                Number.parseFloat(style.outlineWidth);
              return (
                field.left - ring > popup.left &&
                field.right + ring < popup.right
              );
            });
            assert.equal(focusFits, true);
          }
          assert.equal(
            await profileDialog.evaluate(
              (popup) => popup.scrollHeight > popup.clientHeight,
            ),
            true,
          );
          await expect(profilePane).toHaveCSS("overflow-y", "visible");
          await expect(profileDialog).toHaveCSS("overflow-y", "auto");
          await expect(profileDialog).toHaveCSS("scrollbar-width", "thin");
          await expect(profileDialog).toHaveCSS(
            "scrollbar-color",
            "rgb(82, 82, 91) rgba(0, 0, 0, 0)",
          );
          await profileDialog.evaluate((popup) => {
            popup.scrollTop = 80;
          });
          assert.match(
            await profileDialog.innerText(),
            /PRIVATE HEALTH ANSWER/,
          );
          assert.match(page.url(), /\/volunteer\/volunteers\?q=Sample\+Alice$/);
          await inPlaceAction(page, {
            endpoint: "/api/organizer/action",
            form: profileDialog.locator(
              "[data-organizer-status]:not([data-submit-on-change])",
            ),
            notify: true,
            trigger: () =>
              profileDialog
                .getByRole("button", {
                  name: "Approve for patrols",
                  exact: true,
                })
                .click(),
            updated: () =>
              profileDialog
                .getByRole("button", {
                  name: "Revoke patrol approval",
                  exact: true,
                })
                .waitFor(),
            loadingLabel: "Saving…",
            pending: async () => {
              await expect(
                profileDialog.getByLabel("Active volunteer", { exact: true }),
              ).toBeDisabled();
              await expect(
                profileDialog.getByLabel("Account role"),
              ).toBeDisabled();
            },
          });
          await expect(profileDialog).toBeVisible();
          assert.equal(
            await profileDialog.evaluate((popup) => popup.scrollTop),
            80,
          );
          await expect(
            page
              .locator("[data-volunteer-results]")
              .getByText("Approved for patrols", { exact: true }),
          ).toBeVisible();
          assert.deepEqual(
            await DB.prepare(
              "SELECT active, patrol_approved AS approved FROM volunteer_status WHERE user_id=?",
            )
              .bind(alice.id)
              .first(),
            { active: 0, approved: 1 },
          );
          await page.goto(`${origin}/volunteer/volunteers/${alice.id}`);
          assert.equal(await page.locator("[data-action-notice]").count(), 0);
          await account.waitFor();
          await inPlaceAction(page, {
            endpoint: "/api/organizer/action",
            form: page.locator(
              "[data-organizer-status][data-submit-on-change]",
            ),
            trigger: () =>
              page.getByLabel("Active volunteer", { exact: true }).check(),
            updated: async () => {
              await expect(
                page.getByLabel("Active volunteer", { exact: true }),
              ).toBeEnabled();
              await expect(
                page.getByLabel("Active volunteer", { exact: true }),
              ).toBeChecked();
            },
            loadingLabel: "Saving…",
          });
          assert.deepEqual(
            await DB.prepare(
              "SELECT active, patrol_approved AS approved FROM volunteer_status WHERE user_id=?",
            )
              .bind(alice.id)
              .first(),
            { active: 1, approved: 1 },
          );
          await page.goto(`${origin}/volunteer/volunteers?q=Sample+Alice`);
          await page
            .getByRole("link", {
              name: "View profile and approval",
              exact: true,
            })
            .click();
          await inPlaceAction(page, {
            endpoint: "/api/organizer/action",
            form: profileDialog.locator("[data-organizer-role]"),
            trigger: () =>
              profileDialog
                .getByLabel("Account role")
                .selectOption("organizer"),
            updated: async () => {
              await expect(
                profileDialog.getByLabel("Account role"),
              ).toBeEnabled();
              await expect(
                profileDialog.getByLabel("Account role"),
              ).toHaveValue("organizer");
            },
            loadingLabel: "Saving…",
          });
          await expect(profileDialog).toBeVisible();
          await expect(page.locator("[data-volunteer-results]")).toContainText(
            "Organizer",
          );
          assert.equal(
            (
              await DB.prepare("SELECT role FROM user WHERE id=?")
                .bind(alice.id)
                .first<{ role: string }>()
            )?.role,
            "organizer",
          );
          await inPlaceAction(page, {
            endpoint: "/api/organizer/action",
            form: profileDialog.locator("[data-organizer-role]"),
            trigger: () =>
              profileDialog
                .getByLabel("Account role")
                .selectOption("volunteer"),
            updated: () =>
              expect(profileDialog.getByLabel("Account role")).toBeEnabled(),
            loadingLabel: "Saving…",
          });
          await expect(profileDialog).toBeVisible();
          const activeForm = profileDialog.locator(
            "[data-organizer-status][data-submit-on-change]",
          );
          await page.route("**/api/organizer/action", (route) =>
            route.fulfill({
              status: 409,
              json: { message: "This volunteer's status changed." },
            }),
          );
          await inPlaceAction(page, {
            endpoint: "/api/organizer/action",
            form: activeForm,
            trigger: () =>
              profileDialog
                .getByLabel("Active volunteer", { exact: true })
                .uncheck(),
            updated: () =>
              expect(activeForm.locator("[data-form-message]")).toHaveText(
                "This volunteer's status changed.",
              ),
            loadingLabel: "Saving…",
          });
          await expect(
            profileDialog.getByLabel("Active volunteer", { exact: true }),
          ).toBeChecked();
          await expect(
            profileDialog.getByLabel("Active volunteer", { exact: true }),
          ).toBeEnabled();
          await page.unroute("**/api/organizer/action");
          alice.cookie = await signIn(alice.email);
          await page.goto(`${origin}/volunteer`);
          await page
            .getByRole("button", { name: "Add an event", exact: true })
            .click();
          const dialog = page.getByRole("dialog", {
            name: "Add an event",
            exact: true,
          });
          await expect(dialog.getByRole("checkbox")).toHaveCount(0);
          await expect(
            dialog.getByRole("combobox", { name: "Event type", exact: true }),
          ).toBeEnabled();
          const expectEventLayout = async (editor: Locator, width: number) => {
            await expect(editor).toHaveCSS("scrollbar-width", "thin");
            await expect(editor).toHaveCSS(
              "scrollbar-color",
              "rgb(82, 82, 91) rgba(0, 0, 0, 0)",
            );
            await expect(
              editor.getByText(
                "Vancouver time, regardless of your device’s time zone.",
                { exact: true },
              ),
            ).toBeVisible();
            const fields = await editor
              .locator("[data-event-save] .volunteer-fields > .volunteer-field")
              .evaluateAll((items) =>
                items.map((item) => {
                  const box = item.getBoundingClientRect();
                  return {
                    name: item.querySelector("[name]")!.getAttribute("name"),
                    top: box.top,
                    bottom: box.bottom,
                    left: box.left,
                    right: box.right,
                  };
                }),
              );
            assert.deepEqual(
              fields.map((field) => field.name),
              ["type", "startsAt", "spots", "meetingPoint", "meetingPointUrl"],
            );
            const [type, date, spots, meeting, map] = fields;
            assert.ok(date.top > type.bottom);
            assert.ok(meeting.top > spots.bottom);
            for (const [first, second] of [
              [date, spots],
              [meeting, map],
            ]) {
              assert.equal(first.left, type.left);
              assert.equal(second.right, type.right);
              if (width > 640) {
                assert.equal(first.top, second.top);
                assert.ok(first.right < second.left);
              } else {
                assert.ok(first.bottom < second.top);
                assert.equal(first.left, second.left);
              }
            }
          };
          const signupChoices = dialog.getByRole("group", {
            name: "Signups",
            exact: true,
          });
          const visibilityChoices = dialog.getByRole("group", {
            name: "Public event list",
            exact: true,
          });
          const stateBox = (group: Locator) =>
            group.locator(".volunteer-state-selector").evaluate((selector) => {
              const style = getComputedStyle(selector, "::before");
              return {
                background: style.backgroundColor,
                translateX: new DOMMatrixReadOnly(style.transform).m41,
                transition: style.transitionProperty,
              };
            });
          await expect(
            signupChoices.getByRole("radio", { name: "Open", exact: true }),
          ).toBeChecked();
          await expect(
            visibilityChoices.getByRole("radio", {
              name: "Visible",
              exact: true,
            }),
          ).toBeChecked();
          for (const width of [1280, 375]) {
            await page.setViewportSize({ width, height: 812 });
            await expectEventLayout(dialog, width);
            for (const group of [signupChoices, visibilityChoices]) {
              await expect(group.getByRole("radio")).toHaveCount(2);
              await expect(group.getByRole("combobox")).toHaveCount(0);
              const options = group.locator(".volunteer-state-option span");
              await expect(options.nth(0)).toBeVisible();
              await expect(options.nth(1)).toBeVisible();
              await expect(options.nth(0)).toHaveCSS(
                "color",
                "rgb(74, 222, 128)",
              );
              await expect(options.nth(1)).toHaveCSS(
                "color",
                "rgb(161, 161, 170)",
              );
              await expect
                .poll(async () => (await stateBox(group)).background)
                .toBe("rgb(5, 46, 22)");
              const boxes = await options.evaluateAll((items) =>
                items.map((item) => {
                  const box = item.getBoundingClientRect();
                  return {
                    top: box.top,
                    right: box.right,
                    left: box.left,
                    height: box.height,
                  };
                }),
              );
              assert.equal(boxes[0].top, boxes[1].top);
              assert.ok(boxes[0].right < boxes[1].left);
              assert.ok(boxes.every((box) => box.height >= 44));
            }
          }
          // Hover must not create a second box ahead of the sliding indicator.
          const closedOption = signupChoices.getByText("Closed", {
            exact: true,
          });
          await closedOption.hover();
          await expect(closedOption).toHaveCSS(
            "background-color",
            "rgba(0, 0, 0, 0)",
          );
          // Inspect an actual sliding transition at its midpoint, not just its CSS.
          const motion = await signupChoices
            .locator(".volunteer-state-selector")
            .evaluate((selector) => {
              const from = new DOMMatrixReadOnly(
                getComputedStyle(selector, "::before").transform,
              ).m41;
              selector
                .querySelector<HTMLInputElement>('input[value="false"]')!
                .click();
              getComputedStyle(selector, "::before").transform;
              const slide = selector
                .getAnimations({ subtree: true })
                .find(
                  (animation) =>
                    animation instanceof CSSTransition &&
                    animation.transitionProperty === "transform",
                );
              if (!slide) return null;
              slide.pause();
              const duration = Number(
                slide.effect!.getComputedTiming().duration,
              );
              slide.currentTime = duration / 2;
              const middle = new DOMMatrixReadOnly(
                getComputedStyle(selector, "::before").transform,
              ).m41;
              const backgrounds = Array.from(
                selector.querySelectorAll(".volunteer-state-option span"),
                (option) => getComputedStyle(option).backgroundColor,
              );
              slide.finish();
              const to = new DOMMatrixReadOnly(
                getComputedStyle(selector, "::before").transform,
              ).m41;
              return { from, middle, to, duration, backgrounds };
            });
          assert.ok(motion);
          assert.ok(motion.duration > 0);
          assert.ok(motion.middle > motion.from && motion.middle < motion.to);
          assert.deepEqual(motion.backgrounds, [
            "rgba(0, 0, 0, 0)",
            "rgba(0, 0, 0, 0)",
          ]);
          await signupChoices.getByText("Open", { exact: true }).click();
          await expect
            .poll(async () => (await stateBox(signupChoices)).translateX)
            .toBe(0);
          await page.emulateMedia({ reducedMotion: "reduce" });
          assert.equal((await stateBox(signupChoices)).transition, "none");
          await signupChoices.getByText("Closed", { exact: true }).click();
          assert.ok((await stateBox(signupChoices)).translateX > 0);
          assert.equal(
            (await stateBox(signupChoices)).background,
            "rgb(69, 10, 10)",
          );
          await signupChoices.getByText("Open", { exact: true }).click();
          assert.equal((await stateBox(signupChoices)).translateX, 0);
          await page.emulateMedia({ reducedMotion: "no-preference" });
          // Native radio groups support keyboard selection without saving the form.
          await signupChoices
            .getByRole("radio", { name: "Open", exact: true })
            .focus();
          await page.keyboard.press("ArrowRight");
          await expect(
            signupChoices.getByRole("radio", { name: "Closed", exact: true }),
          ).toBeChecked();
          await expect
            .poll(async () => (await stateBox(signupChoices)).background)
            .toBe("rgb(69, 10, 10)");
          await page.keyboard.press("ArrowLeft");
          await expect(
            signupChoices.getByRole("radio", { name: "Open", exact: true }),
          ).toBeChecked();
          await dialog
            .getByLabel("Start date and time")
            .fill("2031-04-12T20:30");
          await dialog
            .getByLabel("Meeting point", { exact: true })
            .fill("Browser-created meeting point");
          const createdCard = page
            .locator("[data-live-event]")
            .filter({ hasText: "Browser-created meeting point" });
          await inPlaceAction(page, {
            endpoint: "/api/events/action",
            form: dialog.locator("[data-event-save]"),
            trigger: () =>
              dialog
                .getByRole("button", { name: "Save event", exact: true })
                .click(),
            updated: () => createdCard.waitFor(),
            loadingLabel: "Saving…",
          });
          await expect(dialog).toBeHidden();
          // Refreshed editor versions support another save without navigation.
          for (const spots of [9, 8]) {
            await createdCard
              .getByRole("button", { name: "Edit", exact: true })
              .click();
            const editor = page.getByRole("dialog", {
              name: "Edit event",
              exact: true,
            });
            await expect(editor.getByRole("checkbox")).toHaveCount(0);
            await expect(
              editor.getByRole("combobox", { name: "Event type", exact: true }),
            ).toHaveCount(0);
            await expect(
              editor.locator(
                "[data-event-type-readonly] .volunteer-readonly-value",
              ),
            ).toHaveText("Patrol");
            await expect(
              editor.locator('input[type="hidden"][name="type"]'),
            ).toHaveValue("patrol");
            for (const width of [1280, 375]) {
              await page.setViewportSize({ width, height: 812 });
              await expectEventLayout(editor, width);
            }
            const signupState = editor.getByRole("group", {
              name: "Signups",
              exact: true,
            });
            const visibility = editor.getByRole("group", {
              name: "Public event list",
              exact: true,
            });
            // Reopening the editor must explicitly show the saved states.
            await expect(
              signupState.getByRole("radio", {
                name: spots === 9 ? "Open" : "Closed",
                exact: true,
              }),
            ).toBeChecked();
            await expect(
              visibility.getByRole("radio", {
                name: spots === 9 ? "Visible" : "Hidden",
                exact: true,
              }),
            ).toBeChecked();
            await signupState
              .getByText(spots === 9 ? "Closed" : "Open", { exact: true })
              .click();
            await visibility
              .getByText(spots === 9 ? "Hidden" : "Visible", { exact: true })
              .click();
            for (const group of [signupState, visibility]) {
              const selected = group.locator("input:checked + span");
              await expect(
                group.locator("input:not(:checked) + span"),
              ).toHaveCSS("color", "rgb(161, 161, 170)");
              await expect(selected).toHaveCSS(
                "color",
                spots === 9 ? "rgb(248, 113, 113)" : "rgb(74, 222, 128)",
              );
              await expect
                .poll(async () => (await stateBox(group)).background)
                .toBe(spots === 9 ? "rgb(69, 10, 10)" : "rgb(5, 46, 22)");
            }
            await editor.getByLabel("Volunteer spots").fill(String(spots));
            await inPlaceAction(page, {
              endpoint: "/api/events/action",
              form: editor.locator("[data-event-save]"),
              notify: spots === 9,
              trigger: () =>
                editor
                  .getByRole("button", { name: "Save event", exact: true })
                  .click(),
              updated: () =>
                expect(createdCard.locator(".volunteer-spots")).toHaveText(
                  `${spots} spots left`,
                ),
              loadingLabel: "Saving…",
              pending: async () => {
                for (const radio of await editor.getByRole("radio").all())
                  await expect(radio).toBeDisabled();
                await expect(
                  editor.getByRole("button", {
                    name: "Cancel event",
                    exact: true,
                  }),
                ).toBeDisabled();
              },
            });
            assert.deepEqual(
              await DB.prepare("SELECT open, hidden FROM event WHERE id=?")
                .bind(await createdCard.getAttribute("data-live-event"))
                .first(),
              { open: spots === 9 ? 0 : 1, hidden: spots === 9 ? 1 : 0 },
            );
          }
          await page
            .getByRole("button", { name: "Add an event", exact: true })
            .click();
          await expect(
            dialog.getByLabel("Meeting point", { exact: true }),
          ).toHaveValue("");
          await expect(
            signupChoices.getByRole("radio", { name: "Open", exact: true }),
          ).toBeChecked();
          await expect(
            visibilityChoices.getByRole("radio", {
              name: "Visible",
              exact: true,
            }),
          ).toBeChecked();
          await dialog
            .getByLabel("Start date and time")
            .fill("2031-04-13T20:30");
          await dialog
            .getByLabel("Meeting point", { exact: true })
            .fill("Browser move destination");
          const destinationCard = page
            .locator("[data-live-event]")
            .filter({ hasText: "Browser move destination" });
          await inPlaceAction(page, {
            endpoint: "/api/events/action",
            form: dialog.locator("[data-event-save]"),
            trigger: () =>
              dialog
                .getByRole("button", { name: "Save event", exact: true })
                .click(),
            updated: () => destinationCard.waitFor(),
            loadingLabel: "Saving…",
          });
          const filters = page.getByRole("group", {
            name: "Filter events",
            exact: true,
          });
          assert.equal(await filters.getByRole("combobox").count(), 0);
          await filters
            .getByRole("button", { name: "Orientations", exact: true })
            .click();
          assert.equal(
            await page
              .locator('[data-live-event][data-event-type="patrol"]:visible')
              .count(),
            0,
          );
          await filters
            .getByRole("button", { name: "Patrols", exact: true })
            .click();
          assert.equal(
            await page
              .locator(
                '[data-live-event][data-event-type="orientation"]:visible',
              )
              .count(),
            0,
          );
          await filters
            .getByRole("button", { name: "All events", exact: true })
            .click();
          assert.equal(
            await nav
              .getByRole("link")
              .evaluateAll((links) =>
                links.every(
                  (link) =>
                    getComputedStyle(link).textDecorationLine === "none" &&
                    getComputedStyle(link).boxShadow === "none",
                ),
              ),
            true,
          );
          assert.equal(
            await page.evaluate(() => {
              const heading = document.querySelector("h1")!,
                nav = document.querySelector(
                  '[aria-label="Volunteer account"]',
                )!;
              return Boolean(
                heading.compareDocumentPosition(nav) &
                Node.DOCUMENT_POSITION_FOLLOWING,
              );
            }),
            true,
          );
          assert.equal(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth,
            ),
            true,
          );
          routeCookie = bob.cookie;
          await page.goto(`${origin}/volunteer`);
          const card = page
            .locator("[data-live-event]")
            .filter({ hasText: "Browser-created meeting point" });
          await page.route("**/api/events/action", (route) =>
            route.fulfill({
              status: 409,
              json: { message: "This event is full." },
            }),
          );
          await card
            .getByRole("button", { name: "Sign up", exact: true })
            .click();
          await card
            .getByText("This event is full.", { exact: true })
            .waitFor();
          assert.equal(
            await card.locator("[data-form-message]").isVisible(),
            true,
          );
          await page.unroute("**/api/events/action");
          await expect(
            card.getByRole("button", { name: "Sign up", exact: true }),
          ).toBeEnabled();
          await expect(
            card.locator("[data-live-signup] button"),
          ).not.toHaveAttribute("aria-busy", "true");
          const changeSpot = async (
            action: "join" | "cancel",
            updated: () => Promise<void>,
            target: Locator = card,
          ) =>
            inPlaceAction(page, {
              endpoint: "/api/events/action",
              form: target.locator("[data-live-signup]"),
              trigger: () =>
                target.locator("[data-live-signup] button").click(),
              updated,
              loadingLabel: action === "join" ? "Signing up…" : "Cancelling…",
              pending: () =>
                expect(
                  target.locator("[data-live-signup] button"),
                ).toBeDisabled(),
            });
          const volunteerFilters = page.getByRole("group", {
            name: "Filter events",
            exact: true,
          });
          await volunteerFilters
            .getByRole("button", { name: "Patrols", exact: true })
            .click();
          await changeSpot("join", () =>
            card.getByText("Signed up", { exact: true }).waitFor(),
          );
          await expect(card.locator(".volunteer-spots")).toHaveText(
            "7 spots left",
          );
          await expect(
            card.getByRole("button", { name: "Cancel my spot", exact: true }),
          ).toBeFocused();
          await expect(page).toHaveURL(/\?type=patrol$/);
          await volunteerFilters
            .getByRole("button", { name: "Orientations", exact: true })
            .click();
          await expect(card).toBeHidden();
          await volunteerFilters
            .getByRole("button", { name: "Patrols", exact: true })
            .click();
          await expect(card).toBeVisible();
          assert.equal(await page.locator("[data-action-notice]").count(), 0);
          assert.equal(
            await page
              .getByText("Your spot is confirmed.", { exact: true })
              .count(),
            0,
          );
          routeCookie = organizer.cookie;
          await page.reload();
          await card.locator("summary").click();
          await card
            .getByRole("button", { name: "Move or remove", exact: true })
            .click();
          const signupDialog = page.getByRole("dialog", {
            name: "Change a signup",
            exact: true,
          });
          await expect(signupDialog).toHaveCSS("scrollbar-width", "thin");
          await expect(signupDialog).toHaveCSS(
            "scrollbar-color",
            "rgb(82, 82, 91) rgba(0, 0, 0, 0)",
          );
          const sourceId = (await card.getAttribute("data-live-event"))!;
          const destinationId =
            (await destinationCard.getAttribute("data-live-event"))!;
          await signupDialog
            .getByLabel("Destination")
            .selectOption(destinationId);
          await inPlaceAction(page, {
            endpoint: "/api/events/action",
            form: signupDialog.locator("[data-manage-signup]"),
            notify: true,
            trigger: () =>
              signupDialog
                .getByRole("button", {
                  name: "Save change",
                  exact: true,
                })
                .click(),
            updated: async () => {
              await expect(card.locator("summary")).toHaveText(
                "Volunteers (0)",
              );
              await expect(destinationCard.locator("summary")).toHaveText(
                "Volunteers (1)",
              );
            },
            loadingLabel: "Saving…",
          });
          await expect(card.locator(".volunteer-roster")).toHaveAttribute(
            "open",
            "",
          );
          await destinationCard.locator("summary").click();
          await destinationCard
            .getByRole("button", { name: "Move or remove", exact: true })
            .click();
          await signupDialog.getByLabel("Destination").selectOption(sourceId);
          await inPlaceAction(page, {
            endpoint: "/api/events/action",
            form: signupDialog.locator("[data-manage-signup]"),
            trigger: () =>
              signupDialog
                .getByRole("button", {
                  name: "Save change",
                  exact: true,
                })
                .click(),
            updated: async () => {
              await expect(card.locator("summary")).toHaveText(
                "Volunteers (1)",
              );
              await expect(destinationCard.locator("summary")).toHaveText(
                "Volunteers (0)",
              );
            },
            loadingLabel: "Saving…",
          });
          await card
            .getByRole("button", { name: "Move or remove", exact: true })
            .click();
          await signupDialog
            .getByLabel("Reason (optional)")
            .fill("Browser-tested cancellation");
          await inPlaceAction(page, {
            endpoint: "/api/events/action",
            form: signupDialog.locator("[data-manage-signup]"),
            trigger: () =>
              signupDialog
                .getByRole("button", {
                  name: "Save change",
                  exact: true,
                })
                .click(),
            updated: () =>
              card.getByText("Volunteers (0)", { exact: true }).waitFor(),
            loadingLabel: "Saving…",
          });
          assert.equal(await signupDialog.isVisible(), false);
          routeCookie = bob.cookie;
          await page.goto(`${origin}/volunteer`);
          await changeSpot("join", () =>
            card.getByText("Signed up", { exact: true }).waitFor(),
          );
          await changeSpot("cancel", () =>
            card
              .getByRole("button", { name: "Sign up", exact: true })
              .waitFor(),
          );
          await expect(card.locator(".volunteer-spots")).toHaveText(
            "8 spots left",
          );
          await expect(
            card.getByText("Signed up", { exact: true }),
          ).toHaveCount(0);
          assert.equal(await page.locator("[data-action-notice]").count(), 0);
          assert.equal(
            await page
              .getByText("Your signup was cancelled.", { exact: true })
              .count(),
            0,
          );
          assert.equal(
            await page.evaluate(() =>
              sessionStorage.getItem("aho-volunteer-notice"),
            ),
            null,
          );
          await changeSpot("join", () =>
            card.getByText("Signed up", { exact: true }).waitFor(),
          );
          const hiddenEventId = await card.getAttribute("data-live-event");
          await DB.prepare("UPDATE event SET hidden=1 WHERE id=?")
            .bind(hiddenEventId)
            .run();
          await page.goto(`${origin}/volunteer?type=patrol`);
          await expect(
            card.getByText("Hidden from public list", { exact: true }),
          ).toBeVisible();
          await changeSpot("cancel", () => card.waitFor({ state: "detached" }));
          await expect(
            volunteerFilters.getByRole("button", {
              name: "Patrols",
              exact: true,
            }),
          ).toBeFocused();
          await account.click();
          await nav.getByRole("link", { name: "Profile", exact: true }).click();
          await page
            .getByRole("heading", { name: "Your account", exact: true })
            .waitFor();
          assert.equal(
            (
              await nav.locator("[data-account-menu-name]").textContent()
            )?.trim(),
            "Sample Bob",
          );
          routeCookie = organizer.cookie;
          const attendance = await createEvent("orientation", 2);
          await ok(await join(attendance.id, bob.cookie));
          await DB.prepare("UPDATE event SET starts_at=? WHERE id=?")
            .bind(Date.now() - 1000, attendance.id)
            .run();
          await page.goto(`${origin}/volunteer`);
          const attendanceCard = page.locator(
            `[data-live-event="${attendance.id}"]`,
          );
          await attendanceCard.locator("summary").click();
          await inPlaceAction(page, {
            endpoint: "/api/organizer/action",
            form: attendanceCard.locator("[data-organizer-orientation]"),
            trigger: () =>
              attendanceCard
                .getByRole("button", {
                  name: "Mark orientation completed",
                  exact: true,
                })
                .click(),
            updated: () =>
              attendanceCard
                .getByText("Orientation completed", { exact: true })
                .waitFor(),
            loadingLabel: "Saving…",
          });
          await expect(
            attendanceCard.locator(".volunteer-roster"),
          ).toHaveAttribute("open", "");
          await card.getByRole("button", { name: "Edit", exact: true }).click();
          const cancelEditor = page.getByRole("dialog", {
            name: "Edit event",
            exact: true,
          });
          await inPlaceAction(page, {
            endpoint: "/api/events/action",
            form: cancelEditor.locator("[data-event-cancel]"),
            trigger: () =>
              cancelEditor
                .getByRole("button", {
                  name: "Cancel event",
                  exact: true,
                })
                .click(),
            updated: () =>
              card.getByText("Cancelled", { exact: true }).waitFor(),
            loadingLabel: "Cancelling…",
          });
          await expect(cancelEditor).toBeHidden();
          // Retry only refreshes delivery status, with fresh server counts.
          await DB.prepare(
            "UPDATE event_notification SET created_at=? WHERE status IN ('pending','sending')",
          )
            .bind(Date.now() - 24 * 60 * 60 * 1000)
            .run();
          for (let attempt = 0; attempt < 2; attempt++) {
            const retryForm = page.locator("[data-retry-notifications]");
            await inPlaceAction(page, {
              endpoint: "/api/events/action",
              form: retryForm,
              trigger: () =>
                retryForm
                  .getByRole("button", {
                    name: "Retry pending notifications",
                    exact: true,
                  })
                  .click(),
              updated: () =>
                expect(
                  retryForm.getByRole("button", {
                    name: "Retry pending notifications",
                    exact: true,
                  }),
                ).toBeEnabled(),
              loadingLabel: "Retrying…",
            });
            await expect(
              page.locator("[data-event-notifications]"),
            ).toContainText("0 notifications awaiting delivery.");
            await expect(
              page.locator("[data-event-notifications]"),
            ).toContainText("notifications expired and cannot be retried.");
          }
          await page.goto(origin);
          await page
            .locator("[data-live-event-teaser]")
            .getByText("Sample meeting point", { exact: true })
            .first()
            .waitFor();
          assert.deepEqual(errors, []);
        } finally {
          await browser.close();
        }
      },
    );
  } finally {
    await server.close();
  }
});
