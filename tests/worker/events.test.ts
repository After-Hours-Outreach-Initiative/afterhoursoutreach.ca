import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { createTestHarness } from "wrangler";
import { chromium } from "@playwright/test";
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
      "deactivation cancels future spots and last organizer cannot be removed",
      async () => {
        await ok(await status(alice.id, false, false));
        const notifications = await DB.prepare(
          "SELECT count(*) AS n FROM event_notification WHERE user_id=? AND subject='Your After Hours Outreach signup was cancelled' AND body LIKE '%volunteer access changed%'",
        )
          .bind(alice.id)
          .first<{ n: number }>();
        assert.ok(notifications && notifications.n > 0);
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
      "cancellation preserves records, cancels spots and queues notifications atomically",
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
          await account.waitFor();
          const teamSearch = page.getByRole("searchbox", {
            name: "Find a volunteer",
          });
          await teamSearch.fill("Sample Alice");
          await page.waitForURL(
            `${origin}/volunteer/volunteers?q=Sample+Alice`,
          );
          await page
            .locator("[data-volunteer-results]")
            .getByRole("heading", { name: "Sample Alice", exact: true })
            .waitFor();
          await page
            .getByRole("link", {
              name: "View profile and approval",
              exact: true,
            })
            .click();
          const profileDialog = page.getByRole("dialog", {
            name: "Volunteer profile",
            exact: true,
          });
          await profileDialog
            .getByRole("heading", { name: "Sample Alice", exact: true })
            .waitFor();
          assert.match(
            await profileDialog.innerText(),
            /PRIVATE HEALTH ANSWER/,
          );
          assert.match(page.url(), /\/volunteer\/volunteers\?q=Sample\+Alice$/);
          await profileDialog
            .getByRole("button", { name: "Approve for patrols", exact: true })
            .click();
          await page.locator("[data-action-notice]").waitFor();
          assert.equal(await profileDialog.isVisible(), false);
          assert.deepEqual(
            await DB.prepare(
              "SELECT active, patrol_approved AS approved FROM volunteer_status WHERE user_id=?",
            )
              .bind(alice.id)
              .first(),
            { active: 0, approved: 1 },
          );
          await page.goto(`${origin}/volunteer/volunteers/${alice.id}`);
          await account.waitFor();
          await page.getByLabel("Active volunteer", { exact: true }).check();
          await page.locator("[data-action-notice]").waitFor();
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
          await profileDialog
            .getByLabel("Account role")
            .selectOption("organizer");
          await page.locator("[data-action-notice]").waitFor();
          assert.equal(
            (
              await DB.prepare("SELECT role FROM user WHERE id=?")
                .bind(alice.id)
                .first<{ role: string }>()
            )?.role,
            "organizer",
          );
          await page
            .getByRole("link", {
              name: "View profile and approval",
              exact: true,
            })
            .click();
          await profileDialog
            .getByLabel("Account role")
            .selectOption("volunteer");
          await page.locator("[data-action-notice]").waitFor();
          alice.cookie = await signIn(alice.email);
          await page.goto(`${origin}/volunteer`);
          await page
            .getByRole("button", { name: "Add an event", exact: true })
            .click();
          const dialog = page.getByRole("dialog", {
            name: "Add an event",
            exact: true,
          });
          await dialog
            .getByLabel("Start date and time")
            .fill("2031-04-12T20:30");
          await dialog
            .getByLabel("Meeting point", { exact: true })
            .fill("Browser-created meeting point");
          await dialog
            .getByRole("button", { name: "Save event", exact: true })
            .click();
          await page
            .getByRole("heading", { name: /Patrol · .*2031/ })
            .waitFor();
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
          await card
            .getByRole("button", { name: "Sign up", exact: true })
            .click();
          await card.getByText("Signed up", { exact: true }).waitFor();
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
          await signupDialog
            .getByLabel("Reason (optional)")
            .fill("Browser-tested cancellation");
          await signupDialog
            .getByRole("button", {
              name: "Save change and notify",
              exact: true,
            })
            .click();
          await card.getByText("Volunteers (0)", { exact: true }).waitFor();
          assert.equal(await signupDialog.isVisible(), false);
          routeCookie = bob.cookie;
          await page.goto(`${origin}/volunteer`);
          await card
            .getByRole("button", { name: "Sign up", exact: true })
            .click();
          await card.getByText("Signed up", { exact: true }).waitFor();
          await card
            .getByRole("button", { name: "Cancel my spot", exact: true })
            .click();
          await card
            .getByRole("button", { name: "Sign up", exact: true })
            .waitFor();
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
