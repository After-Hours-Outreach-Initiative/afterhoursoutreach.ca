import assert from "node:assert/strict";
import { profileWriteBody } from "../helpers/profile-write";
import { existsSync } from "node:fs";
import { afterAll, beforeAll, describe, test } from "vitest";
import { createTestHarness } from "wrangler";
import { chromium, expect, type Locator, type Route } from "@playwright/test";
import { inPlaceAction } from "../helpers/in-place-action";
import { fillDateInput } from "../helpers/date-input";
import { createSignInOTP } from "../helpers/email-otp";
// Discord connection is temporarily disabled.
// import { seedVerifiedDiscordMembership } from "../helpers/discord";
import { totpFromSetupKey } from "../helpers/totp";
import { hashAuthValue } from "../../src/server/db/rate-limits";

const origin = "https://afterhoursoutreach.ca";
const secret = "worker-event-test-secret-12345678901234567890";
const answers = {
  firstName: "Sample",
  lastName: "Volunteer",
  preferredName: "Sample Volunteer",
  pronouns: "they/them",
  phone: "604-555-0100",
  birthDate: "1995-04-12",
  emergencyName: "Sample contact",
  emergencyPhone: "604-555-0101",
  emergencyRelationship: "Friend",
  heardAboutUs: "Friend",
  heardAboutUsSources: ["friend-word-of-mouth"],
  heardAboutUsOther: "",
  motivation: "Sample answer",
  teams: ["outreach"],
  certification: "None",
  experience: "None",
  training: ["none"],
  relevantExperience: ["none"],
  otherExperience: "",
  medicalConditions: "PRIVATE HEALTH ANSWER",
};
const cookies = (response: { headers: { getSetCookie(): string[] } }) =>
  response.headers
    .getSetCookie()
    .filter((cookie) => !cookie.includes("Max-Age=0"))
    .map((cookie) => cookie.split(";")[0])
    .join("; ");

// These cases intentionally share one ordered organizer/volunteer workflow.
describe(
  "real event and organizer flows in the built Worker",
  { concurrent: false, shuffle: false },
  () => {
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
    let worker: ReturnType<typeof server.getWorker<Env>>;
    let DB: Env["DB"];
    let organizer: Awaited<ReturnType<typeof person>>;
    let alice: Awaited<ReturnType<typeof person>>;
    let bob: Awaited<ReturnType<typeof person>>;
    beforeAll(async () => {
      await server.listen();
      worker = server.getWorker<Env>();
      await worker.applyD1Migrations("DB");
      DB = (await worker.getEnv()).DB;
      organizer = await person("organizer@example.org", "Sample Organizer");
      alice = await person("alice@example.org", "Sample Alice");
      bob = await person("bob@example.org", "Sample Bob");
    });
    const cookieIPs = new Map<string, string>();
    const send = async (
      path: string,
      body?: object,
      cookie?: string,
      requestOrigin = origin,
      ip = cookieIPs.get(cookie ?? "") ?? "192.0.2.1",
    ): ReturnType<typeof worker.fetch> => {
      if (path === "/api/v1/account/profile" && body)
        body = await profileWriteBody(
          (path) => send(path, undefined, cookie),
          body,
        );
      return worker.fetch(`${origin}${path}`, {
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
    };
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
          "/api/v1/auth/sign-in/email-otp?returnTo=%2Fvolunteer",
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
              "/api/v1/auth/two-factor/verify-totp",
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
        await send(
          "/api/v1/account/profile",
          { ...answers, preferredName: name, codeOfConductAccepted: true },
          cookie,
        ),
      );
      const session = (await (
        await ok(await send("/api/v1/auth/get-session", undefined, cookie))
      ).json()) as { user: { id: string }; session: { id: string } };
      return {
        cookie,
        id: session.user.id,
        sessionId: session.session.id,
        email,
      };
    };
    const eventInput = (type = "orientation", spots = 4) => ({
      type,
      startsAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      meetingPoint: "Sample meeting point",
      meetingPointUrl: "https://example.org/map",
      spots,
      open: true,
      hidden: false,
    });

    test("visitors cannot view events, including on an empty database", async () => {
      const response = await ok(await send("/volunteer"));
      assert.doesNotMatch(
        await response.text(),
        /data-live-event=|data-event-list|No upcoming events are scheduled/,
      );
      await ok(await send("/api/v1/events"), 401);
    });

    test("bootstrap requires verified application but not two-factor, is atomic and one-time", async () => {
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
          await DB.prepare("SELECT count(*) AS n FROM session WHERE user_id=?")
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
    });

    test("visitors and volunteers cannot perform organizer actions; CSRF is rejected", async () => {
      await ok(
        await send("/api/v1/events/action", {
          action: "save",
          event: eventInput(),
        }),
        401,
      );
      await ok(
        await send(
          "/api/v1/events/action",
          { action: "save", event: eventInput() },
          alice.cookie,
        ),
        403,
      );
      await ok(
        await send(
          "/api/v1/organizer/action",
          { action: "role", userId: alice.id, role: "organizer" },
          alice.cookie,
        ),
        403,
      );
      await ok(
        await send(
          "/api/v1/events/action",
          { action: "save", event: eventInput() },
          organizer.cookie,
          "https://evil.example",
        ),
        403,
      );
      await ok(
        await send(`/volunteers/${alice.id}`, undefined, alice.cookie),
        403,
      );
      await ok(await send("/volunteers"), 302);
    });

    const createEvent = async (type = "orientation", spots = 5) => {
      const data = eventInput(type, spots);
      await ok(
        await send(
          "/api/v1/events/action",
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
    describe("with scheduled events", () => {
      let orientation: Awaited<ReturnType<typeof createEvent>>;
      let patrol: Awaited<ReturnType<typeof createEvent>>;
      let destination: Awaited<ReturnType<typeof createEvent>>;
      beforeAll(async () => {
        orientation = await createEvent("orientation", 4);
        patrol = await createEvent("patrol", 5);
        destination = await createEvent("orientation", 4);
      });
      const join = (eventId: string, cookie: string) =>
        send("/api/v1/events/action", { action: "join", id: eventId }, cookie);
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
          "/api/v1/organizer/action",
          {
            action: "status",
            userId,
            version: row!.version,
            active,
            applicationApproved: true,
            patrolApproved,
          },
          organizer.cookie,
        );
      };

      test("real listings have no invented events, demo code or signed-out account menu", async () => {
        const response = await ok(await send("/volunteer"));
        const html = await response.text();
        assert.doesNotMatch(html, /Preview · public test site/);
        assert.doesNotMatch(
          html,
          /Sample meeting point|data-live-event=|data-event-list/,
        );
        assert.doesNotMatch(
          html,
          /preview-event|data-account-switcher|View as|Sample Alice|PRIVATE HEALTH ANSWER|data-account-menu/,
        );
        assert.match(response.headers.get("cache-control")!, /no-store/);
        const summaries = (await (
          await ok(await send("/api/v1/events", undefined, organizer.cookie))
        ).json()) as { events: unknown[] };
        assert.equal(summaries.events.length, 3);
        assert.doesNotMatch(
          JSON.stringify(summaries),
          /PRIVATE HEALTH ANSWER|Sample Alice|userId|confirmed|signedUp|version/,
        );
      });

      test("application approval and Naloxone gate orientations without Discord while linking is paused", async () => {
        for (const person of [alice, bob]) {
          const page = await ok(
            await send("/volunteer", undefined, person.cookie),
          );
          const html = await page.text();
          assert.match(html, /Application Form\s*<\/span>/);
          assert.match(html, /data-application-awaiting-approval="true"/);
          assert.doesNotMatch(
            html,
            /Sample meeting point|data-live-event=|data-event-list/,
          );
          await ok(await send("/api/v1/events", undefined, person.cookie), 403);
          await ok(await join(orientation.id, person.cookie), 403);
          await ok(
            await send(
              "/api/v1/organizer/action",
              {
                action: "status",
                userId: person.id,
                version: 0,
                active: true,
                applicationApproved: true,
                patrolApproved: false,
              },
              person.cookie,
            ),
            403,
          );
          await ok(
            await send(
              "/api/v1/organizer/action",
              {
                action: "role",
                userId: person.id,
                role: "organizer",
              },
              organizer.cookie,
            ),
            409,
          );
          await ok(await status(person.id, true, false), 409);
          await ok(
            await send(
              "/api/v1/account/naloxone",
              { userId: person.id, completed: true },
              person.cookie,
            ),
          );
          await ok(await send("/api/v1/events", undefined, person.cookie), 403);
          // Discord connection is temporarily disabled.
          // await ok(await status(person.id, true, false), 409);
          // await seedVerifiedDiscordMembership(DB, person.id);
          // await ok(await send("/api/v1/events", undefined, person.cookie), 403);
          await ok(await status(person.id, true, false));
          const events = await ok(
            await send("/api/v1/events", undefined, person.cookie),
          );
          assert.match(await events.text(), /Sample meeting point/);
          const listing = await (
            await ok(await send("/events", undefined, person.cookie))
          ).text();
          assert.doesNotMatch(listing, /You can(?:’t)? register/);
          const card = (id: string) =>
            listing.match(
              new RegExp(`<li[^>]*data-live-event="${id}"[\\s\\S]*?</li>`),
            )?.[0] ?? "";
          assert.match(card(orientation.id), /class="btn btn-green"/);
          assert.match(card(orientation.id), /value="join"/);
          assert.equal(card(patrol.id), "");
          await ok(await join(patrol.id, person.cookie), 403);
          const audit = await DB.prepare(
            "SELECT changed_fields FROM audit_log WHERE subject_id=? AND action='approval_changed'",
          )
            .bind(person.id)
            .first();
          assert.equal(audit?.changed_fields, '["applicationApproved"]');
        }
      });

      test("last spot is atomic across simultaneous signups without queuing email", async () => {
        await ok(await join(orientation.id, organizer.cookie));
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
        assert.equal(result.message, "Your registration is confirmed.");
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
          2,
        );
      });

      test("approval without orientation grants patrol access, arbitrary client role does not", async () => {
        await ok(await join(patrol.id, alice.cookie), 403);
        await ok(await status(alice.id));
        await ok(await join(patrol.id, alice.cookie));
        await ok(
          await send(
            "/api/v1/events/action",
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
      });

      test("volunteer signups and cancellations preserve records and audits without emails", async () => {
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
              "/api/v1/events/action",
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
                "Your registration is confirmed.",
                "Your registration was cancelled.",
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
      });

      test("organizers without two-factor can manage events and view audited profiles", async () => {
        const session = (await (
          await send("/api/v1/auth/get-session", undefined, organizer.cookie)
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
            "/api/v1/events/action",
            { action: "save", event: eventInput() },
            organizer.cookie,
          ),
        );
        const response = await ok(
          await send(`/volunteers/${alice.id}`, undefined, organizer.cookie),
        );
        const profileHtml = await response.text();
        assert.match(profileHtml, /PRIVATE HEALTH ANSWER/);
        assert.doesNotMatch(profileHtml, /code-of-conduct-heading/);
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
          await send("/volunteers", undefined, organizer.cookie),
        );
        assert.doesNotMatch(await team.text(), /PRIVATE HEALTH ANSWER/);
      });

      test("capacity, optimistic edit conflicts, hidden and closed events are enforced", async () => {
        await ok(await join(patrol.id, bob.cookie), 403);
        const row = await DB.prepare(
          "SELECT updated_at AS version FROM event WHERE id=?",
        )
          .bind(patrol.id)
          .first<{ version: number }>();
        await ok(
          await send(
            "/api/v1/events/action",
            {
              action: "save",
              id: patrol.id,
              version: row!.version,
              event: { ...patrol.data, spots: 3 },
            },
            organizer.cookie,
          ),
        );
        await ok(await status(bob.id));
        await ok(await join(patrol.id, bob.cookie), 409);
        await ok(
          await send(
            "/api/v1/events/action",
            {
              action: "save",
              id: patrol.id,
              version: row!.version,
              event: { ...patrol.data, spots: 4 },
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
            "/api/v1/events/action",
            {
              action: "save",
              id: patrol.id,
              version,
              event: { ...patrol.data, spots: 4, hidden: true },
            },
            organizer.cookie,
          ),
        );
        assert.doesNotMatch(
          await (await send("/volunteer")).text(),
          new RegExp(`data-live-event="${patrol.id}"`),
        );
        assert.match(
          await (await send("/events", undefined, alice.cookie)).text(),
          new RegExp(`data-live-event="${patrol.id}"`),
        );
        await ok(await join(patrol.id, bob.cookie), 403);
      });

      test("visibility off, including legacy mixed states, hides listings but preserves existing spots", async () => {
        const event = await createEvent("orientation");
        const listed = new RegExp(`data-live-event="${event.id}"`);
        await ok(await join(event.id, alice.cookie));
        for (const flags of [
          { open: false, hidden: true },
          { open: false, hidden: false },
          { open: true, hidden: true },
          { open: true, hidden: false },
        ]) {
          const row = await DB.prepare(
            "SELECT updated_at AS version FROM event WHERE id=?",
          )
            .bind(event.id)
            .first<{ version: number }>();
          await ok(
            await send(
              "/api/v1/events/action",
              {
                action: "save",
                id: event.id,
                version: row!.version,
                event: { ...event.data, ...flags },
              },
              organizer.cookie,
            ),
          );
          const visible = flags.open && !flags.hidden;
          const html = await (
            await ok(await send("/events", undefined, bob.cookie))
          ).text();
          assert.equal(listed.test(html), visible);
          for (const cookie of [alice.cookie, bob.cookie, organizer.cookie]) {
            const summaries = (await (
              await ok(await send("/api/v1/events", undefined, cookie))
            ).json()) as { events: { id: string }[] };
            assert.equal(
              summaries.events.some((row) => row.id === event.id),
              visible,
            );
          }
          assert.match(
            await (await send("/events", undefined, alice.cookie)).text(),
            listed,
          );
          if (!visible) await ok(await join(event.id, bob.cookie), 403);
        }
        assert.equal(
          await DB.prepare(
            "SELECT status FROM signup WHERE event_id=? AND user_id=?",
          )
            .bind(event.id, alice.id)
            .first("status"),
          "confirmed",
        );
      });

      test("move rollback preserves source signup when destination is full", async () => {
        const signedUp = await DB.prepare(
          "SELECT id,user_id AS userId FROM signup WHERE event_id=? AND user_id=? AND status='confirmed'",
        )
          .bind(orientation.id, organizer.id)
          .first<{ id: string; userId: string }>();
        // Fill the destination's four real places, respecting both manual
        // progression categories instead of treating approved volunteers as new.
        for (const [index, medic] of [true, true, false, false].entries()) {
          const id = `destination-attendee-${index}`;
          await DB.batch([
            DB.prepare(
              "INSERT INTO user (id,name,email,created_at,updated_at) VALUES (?,'Destination attendee',?,0,0)",
            ).bind(id, `${id}@example.org`),
            DB.prepare(
              `INSERT INTO profile (user_id,preferred_name,phone,birth_date,emergency_contact_name,
              emergency_contact_phone,emergency_contact_relationship,heard_about_us,motivation,teams,
              medical_certification,training_experience,registered_at,naloxone_completed_at,updated_at)
              SELECT ?,'Destination attendee',phone,birth_date,emergency_contact_name,
              emergency_contact_phone,emergency_contact_relationship,heard_about_us,motivation,?,
              medical_certification,training_experience,0,0,0 FROM profile WHERE user_id=?`,
            ).bind(id, medic ? '["medic"]' : '["outreach"]', alice.id),
            DB.prepare(
              "INSERT INTO volunteer_status (user_id,registration_approved,patrol_approved,approved_by,approved_at,updated_at) VALUES (?,1,?,?,0,0)",
            ).bind(id, Number(medic), organizer.id),
            DB.prepare(
              "INSERT INTO signup (id,event_id,user_id,created_at,updated_at) VALUES (?,?,?,0,0)",
            ).bind(id, destination.id, id),
          ]);
        }
        await ok(
          await send(
            "/api/v1/events/action",
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
            "/api/v1/events/action",
            {
              action: "manage-signup",
              id: "destination-attendee-3",
              reason: "",
              notify: false,
            },
            organizer.cookie,
          ),
        );
        await ok(
          await send(
            "/api/v1/events/action",
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
      });

      test("orientation completion requires actual past attendance and also approves patrols", async () => {
        const attendee = await DB.prepare(
          "SELECT user_id AS userId FROM signup WHERE event_id=? AND status='confirmed'",
        )
          .bind(destination.id)
          .first<{ userId: string }>();
        await ok(
          await send(
            "/api/v1/organizer/action",
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
        // The moved attendee may be the bootstrapped organizer, whose application
        // has not needed review for event access. Set up this approval prerequisite.
        await DB.prepare(
          "UPDATE volunteer_status SET registration_approved=1 WHERE user_id=?",
        )
          .bind(attendee!.userId)
          .run();
        await ok(
          await send(
            "/api/v1/organizer/action",
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
            "/api/v1/organizer/action",
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
        assert.equal(
          await DB.prepare(
            "SELECT patrol_approved FROM volunteer_status WHERE user_id=?",
          )
            .bind(attendee!.userId)
            .first("patrol_approved"),
          1,
        );
      });

      test("deactivation silently cancels future spots and last organizer cannot be removed", async () => {
        await ok(await status(alice.id, false, false));
        const notifications = await DB.prepare(
          "SELECT count(*) AS n FROM event_notification WHERE user_id=? AND subject='Your event registration was cancelled' AND body LIKE '%volunteer access changed%'",
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
            "/api/v1/organizer/action",
            { action: "role", userId: organizer.id, role: "volunteer" },
            organizer.cookie,
          ),
          409,
        );
        await ok(await status(organizer.id, false, false), 409);
      });

      test("revoking application approval cancels future orientations and patrols without changing patrol approval", async () => {
        await ok(await status(alice.id, true, true));
        const orientationEvent = await createEvent("orientation", 5);
        const patrolEvent = await createEvent("patrol");
        for (const event of [orientationEvent, patrolEvent])
          await ok(await join(event.id, alice.cookie));
        const row = await DB.prepare(
          "SELECT updated_at AS version FROM volunteer_status WHERE user_id=?",
        )
          .bind(alice.id)
          .first<{ version: number }>();
        const change = {
          action: "status",
          userId: alice.id,
          version: row!.version,
          active: true,
          applicationApproved: false,
          patrolApproved: true,
        };
        await ok(
          await send("/api/v1/organizer/action", change, organizer.cookie),
        );
        await ok(
          await send(
            "/api/v1/organizer/action",
            { ...change, applicationApproved: true },
            organizer.cookie,
          ),
          409,
        );
        const statusRow = await DB.prepare(
          "SELECT registration_approved, patrol_approved FROM volunteer_status WHERE user_id=?",
        )
          .bind(alice.id)
          .first();
        assert.equal(statusRow?.registration_approved, 0);
        assert.equal(statusRow?.patrol_approved, 1);
        for (const event of [orientationEvent, patrolEvent]) {
          assert.equal(
            (
              await DB.prepare(
                "SELECT status FROM signup WHERE event_id=? AND user_id=?",
              )
                .bind(event.id, alice.id)
                .first()
            )?.status,
            "cancelled",
          );
          await ok(await join(event.id, alice.cookie), 403);
        }
        await ok(await send("/api/v1/events", undefined, alice.cookie), 403);
        assert.doesNotMatch(
          await (await send("/events", undefined, alice.cookie)).text(),
          /data-live-event=/,
        );
        await ok(await status(alice.id, false, false));
      });

      test("opted-in cancellation preserves records, cancels spots and queues notifications atomically", async () => {
        const event = await createEvent("patrol", 4);
        await ok(await join(event.id, bob.cookie));
        await ok(
          await send(
            "/api/v1/events/action",
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
            "/api/v1/events/action",
            { action: "cancel-event", id: event.id, version: event.version },
            organizer.cookie,
          ),
          409,
        );
      });

      test("organizer promotions require verified application, not two-factor, and revoke sessions", async () => {
        await DB.prepare("UPDATE user SET email_verified=0 WHERE id=?")
          .bind(bob.id)
          .run();
        await ok(
          await send(
            "/api/v1/organizer/action",
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
            "/api/v1/organizer/action",
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
        await ok(await send("/volunteers", undefined, bob.cookie));
        await ok(
          await send(
            "/api/v1/organizer/action",
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
        await ok(await send("/volunteers", undefined, bob.cookie), 403);
        const audit = await DB.prepare(
          "SELECT changed_fields FROM audit_log WHERE action='role_changed' AND subject_id=?",
        )
          .bind(bob.id)
          .all();
        assert.equal(audit.results.length, 2);
        assert.ok(
          audit.results.every((row) => row.changed_fields === '["role"]'),
        );
      });

      test("browser organizer and volunteer workflows save in place and remain usable on mobile", async () => {
        // Alice needs actual attendance for the merged approval action.
        await DB.prepare(
          `INSERT INTO event (id,type,starts_at,meeting_point,spots,created_by,created_at,updated_at)
          VALUES ('browser-orientation','orientation',?,'Browser orientation',8,?,0,0)`,
        )
          .bind(Date.now() + 86_400_000, organizer.id)
          .run();
        await ok(await status(alice.id, true, false));
        await ok(await join("browser-orientation", alice.cookie));
        await DB.prepare(
          "UPDATE event SET starts_at=0 WHERE id='browser-orientation'",
        ).run();
        await ok(await status(alice.id, false, false));
        // Earlier API cases share this actor; give the browser its own action budget.
        const start = Math.floor(Date.now() / 60_000) * 60_000;
        const eventRateKey = await hashAuthValue(
          secret,
          `rate:events:${organizer.id}:60000:${start}`,
        );
        await DB.prepare("DELETE FROM auth_rate_limit WHERE key=?")
          .bind(eventRateKey)
          .run();
        const browser = await chromium.launch({
          executablePath:
            process.env.CHROMIUM_PATH ??
            (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined),
        });
        try {
          const page = await browser.newPage({
            viewport: { width: 375, height: 812 },
            timezoneId: "Asia/Tokyo",
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
          let releaseScripts!: () => void;
          const scriptsReady = new Promise<void>((resolve) => {
            releaseScripts = resolve;
          });
          const holdScripts = async (route: Route) => {
            await scriptsReady;
            await route.fallback();
          };
          await page.route("**/_astro/*.js", holdScripts);
          try {
            await page.goto(`${origin}/volunteers/${alice.id}`, {
              waitUntil: "commit",
            });
            await expect(page.getByLabel("Account role")).toBeDisabled();
            await expect(
              page.getByLabel("Active volunteer", { exact: true }),
            ).toBeDisabled();
            await expect(
              page.getByRole("button", {
                name: "Approve for patrols",
                exact: true,
              }),
            ).toBeDisabled();
          } finally {
            releaseScripts();
            await page.unroute("**/_astro/*.js", holdScripts);
          }
          await expect(page.getByLabel("Account role")).toBeEnabled();
          await page.goto(`${origin}/events`);
          assert.equal(await page.locator("[data-action-notice]").count(), 0);
          const nav = page.locator(".mobile-nav");
          const account = nav.locator(":scope > summary");
          assert.equal(
            (
              await nav.locator("[data-account-menu-name]").textContent()
            )?.trim(),
            "Sample Organizer",
          );
          await account.waitFor();
          await page.goto(`${origin}/volunteers`);
          assert.equal(await page.locator("[data-action-notice]").count(), 0);
          await account.waitFor();
          const teamSearch = page.getByRole("searchbox", {
            name: "Find a volunteer",
          });
          await teamSearch.fill("Sample Alice");
          await page.waitForURL(`${origin}/volunteers?q=Sample+Alice`);
          await page
            .locator("[data-volunteer-results]")
            .getByRole("link", { name: "Sample Alice V.", exact: true })
            .waitFor();
          await page
            .getByRole("link", { name: "Sample Alice V.", exact: true })
            .click();
          const profileView = page.locator("[data-volunteer-profile]");
          await profileView
            .getByRole("heading", { name: "Sample Alice V.", exact: true })
            .waitFor();
          await expect(
            profileView.getByLabel("Active volunteer", { exact: true }),
          ).toBeEnabled();
          await profileView
            .getByLabel("Active volunteer", { exact: true })
            .focus();
          await page.keyboard.press("Tab");
          await expect(profileView.getByLabel("Account role")).toBeFocused();
          assert.match(await profileView.innerText(), /PRIVATE HEALTH ANSWER/);
          await expect(
            page.getByRole("link", { name: "Back to volunteers" }),
          ).toHaveAttribute("href", "/volunteers?q=Sample+Alice");
          await inPlaceAction(page, {
            endpoint: "/api/v1/organizer/action",
            form: profileView.locator(
              '[data-organizer-status][data-access-kind="patrol"]',
            ),
            notify: true,
            trigger: () =>
              profileView
                .getByRole("button", {
                  name: "Approve for patrols",
                  exact: true,
                })
                .click(),
            updated: () =>
              profileView
                .getByRole("button", {
                  name: "Revoke patrol approval",
                  exact: true,
                })
                .waitFor(),
            loadingLabel: "Sending…",
            pending: async () => {
              await expect(
                profileView.getByLabel("Active volunteer", { exact: true }),
              ).toBeDisabled();
              await expect(
                profileView.getByLabel("Account role"),
              ).toBeDisabled();
            },
          });
          const accessEmailResult = page.getByRole("dialog", {
            name: "Volunteer access saved",
            exact: true,
          });
          await expect(accessEmailResult).toContainText(
            "Volunteer access saved.",
          );
          await expect(accessEmailResult).toContainText("could not be sent");
          await expect(
            accessEmailResult.getByRole("button", {
              name: "Retry email only",
              exact: true,
            }),
          ).toBeVisible();
          await accessEmailResult
            .getByRole("button", { name: "Close", exact: true })
            .click();
          await expect(profileView).toBeVisible();
          await page.getByRole("link", { name: "Back to volunteers" }).click();
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
          await page.goto(`${origin}/volunteers/${alice.id}`);
          assert.equal(await page.locator("[data-action-notice]").count(), 0);
          await account.waitFor();
          await inPlaceAction(page, {
            endpoint: "/api/v1/organizer/action",
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
          await page.goto(`${origin}/volunteers?q=Sample+Alice`);
          await page
            .getByRole("link", {
              name: "Sample Alice V.",
              exact: true,
            })
            .click();
          await inPlaceAction(page, {
            endpoint: "/api/v1/organizer/action",
            form: profileView.locator("[data-organizer-role]"),
            trigger: () =>
              profileView.getByLabel("Account role").selectOption("organizer"),
            updated: async () => {
              await expect(
                profileView.getByLabel("Account role"),
              ).toBeEnabled();
              await expect(profileView.getByLabel("Account role")).toHaveValue(
                "organizer",
              );
            },
            loadingLabel: "Saving…",
          });
          await expect(profileView).toBeVisible();
          assert.equal(
            (
              await DB.prepare("SELECT role FROM user WHERE id=?")
                .bind(alice.id)
                .first<{ role: string }>()
            )?.role,
            "organizer",
          );
          await inPlaceAction(page, {
            endpoint: "/api/v1/organizer/action",
            form: profileView.locator("[data-organizer-role]"),
            trigger: () =>
              profileView.getByLabel("Account role").selectOption("volunteer"),
            updated: () =>
              expect(profileView.getByLabel("Account role")).toBeEnabled(),
            loadingLabel: "Saving…",
          });
          await expect(profileView).toBeVisible();
          const activeForm = profileView.locator(
            "[data-organizer-status][data-submit-on-change]",
          );
          await page.route("**/api/v1/organizer/action", (route) =>
            route.fulfill({
              status: 409,
              json: { message: "This volunteer's status changed." },
            }),
          );
          await inPlaceAction(page, {
            endpoint: "/api/v1/organizer/action",
            form: activeForm,
            trigger: () =>
              profileView
                .getByLabel("Active volunteer", { exact: true })
                .uncheck(),
            updated: () =>
              expect(activeForm.locator("[data-form-message]")).toHaveText(
                "This volunteer's status changed.",
              ),
            loadingLabel: "Saving…",
          });
          await expect(
            profileView.getByLabel("Active volunteer", { exact: true }),
          ).toBeChecked();
          await expect(
            profileView.getByLabel("Active volunteer", { exact: true }),
          ).toBeEnabled();
          await page.unroute("**/api/v1/organizer/action");
          alice.cookie = await signIn(alice.email);
          await page.goto(`${origin}/events`);
          await page.locator('[data-show-dialog="event-editor-new"]').click();
          const dialog = page.getByRole("dialog", {
            name: "Create event",
            exact: true,
          });
          await expect(dialog.locator('[name="type"]')).toHaveCount(0);
          const includesOrientation = dialog.getByRole("checkbox", {
            name: "Includes orientation",
            exact: true,
          });
          await expect(includesOrientation).not.toBeChecked();
          await expect(includesOrientation).toBeEnabled();
          const visibilityChoices = dialog.getByRole("group", {
            name: "Public visibility",
            exact: true,
          });
          await expect(dialog.getByRole("switch")).toHaveCount(0);
          await expect(visibilityChoices.getByRole("radio")).toHaveCount(2);
          const visible = visibilityChoices.getByRole("radio", {
            name: "Visible",
            exact: true,
          });
          const hidden = visibilityChoices.getByRole("radio", {
            name: "Hidden",
            exact: true,
          });
          await expect(visible).toBeChecked();
          // The toggle supports keyboard use and does not save until submission.
          await page.emulateMedia({ reducedMotion: "reduce" });
          await hidden.focus();
          await page.keyboard.press("ArrowLeft");
          await expect(visible).toBeChecked();
          await page.keyboard.press("ArrowRight");
          await expect(hidden).toBeChecked();
          await page.keyboard.press("ArrowLeft");
          await expect(visible).toBeChecked();
          await fillDateInput(dialog, "startsAt", "2031-04-12T20:30");
          await dialog
            .getByLabel("Meeting point", { exact: true })
            .fill("Browser-created meeting point");
          const createdCard = page
            .locator("[data-live-event]")
            .filter({ hasText: "Browser-created meeting point" });
          await inPlaceAction(page, {
            endpoint: "/api/v1/events/action",
            form: dialog.locator("[data-event-save]"),
            trigger: () =>
              dialog
                .getByRole("button", { name: "Create event", exact: true })
                .click(),
            updated: () => createdCard.waitFor(),
            loadingLabel: "Creating…",
          });
          await expect(dialog).toBeHidden();
          assert.equal(
            (
              await DB.prepare("SELECT starts_at FROM event WHERE id=?")
                .bind(await createdCard.getAttribute("data-live-event"))
                .first()
            )?.starts_at,
            Date.parse("2031-04-13T03:30:00Z"),
          );
          // Refreshed editor versions support another save without navigation.
          for (const spots of [9, 8]) {
            await createdCard
              .getByRole("button", { name: "Edit", exact: true })
              .click();
            const editor = page.getByRole("dialog", {
              name: "Edit event",
              exact: true,
            });
            await expect(
              editor.locator("[data-native-date]").first(),
            ).toHaveValue("2031-04-12");
            await expect(editor.getByLabel("Start time")).toHaveValue(
              "8:30 PM",
            );
            await expect(
              editor.locator('input[type="radio"][name="type"]'),
            ).toHaveCount(0);
            await expect(editor.locator('[name="type"]')).toHaveCount(0);
            const orientationToggle = editor.getByRole("checkbox", {
              name: "Includes orientation",
              exact: true,
            });
            if (spots === 9) await expect(orientationToggle).not.toBeChecked();
            else await expect(orientationToggle).toBeChecked();
            await orientationToggle.setChecked(spots === 9);
            const visibility = editor.getByRole("group", {
              name: "Public visibility",
              exact: true,
            });
            // Reopening the editor shows the saved state of both storage flags.
            await expect(
              visibility.getByRole("radio", {
                name: spots === 9 ? "Visible" : "Hidden",
                exact: true,
              }),
            ).toBeChecked();
            await visibility
              .getByText(spots === 9 ? "Hidden" : "Visible", { exact: true })
              .click();
            await expect(
              visibility.getByRole("radio", {
                name: spots === 9 ? "Hidden" : "Visible",
                exact: true,
              }),
            ).toBeChecked();
            await editor
              .getByRole("spinbutton", { name: "Volunteer spots", exact: true })
              .fill(String(spots));
            await inPlaceAction(page, {
              endpoint: "/api/v1/events/action",
              form: editor.locator("[data-event-save]"),
              trigger: () =>
                editor
                  .getByRole("button", { name: "Save event", exact: true })
                  .click(),
              updated: () =>
                expect(
                  createdCard.locator("[data-event-availability]"),
                ).toHaveText(`0 of ${spots} spots taken`),
              loadingLabel: "Saving…",
              pending: async () => {
                for (const radio of await visibility.getByRole("radio").all())
                  await expect(radio).toBeDisabled();
                await expect(
                  editor.getByRole("button", {
                    name: "Cancel event",
                    exact: true,
                  }),
                ).toBeDisabled();
              },
            });
            // With no attendees, editing does not offer or send email.
            await expect(
              page.getByRole("dialog", { name: "Event saved", exact: true }),
            ).toHaveCount(0);
            assert.deepEqual(
              await DB.prepare("SELECT open, hidden FROM event WHERE id=?")
                .bind(await createdCard.getAttribute("data-live-event"))
                .first(),
              { open: spots === 9 ? 0 : 1, hidden: spots === 9 ? 1 : 0 },
            );
          }
          await page.locator('[data-show-dialog="event-editor-new"]').click();
          await expect(
            dialog.getByLabel("Meeting point", { exact: true }),
          ).toHaveValue("Lord Strathcona Elementary");
          await expect(visible).toBeChecked();
          await visibilityChoices.getByText("Visible", { exact: true }).click();
          await fillDateInput(dialog, "startsAt", "2031-04-13T20:30");
          await dialog
            .getByLabel("Meeting point", { exact: true })
            .fill("Browser move destination");
          const destinationCard = page
            .locator("[data-live-event]")
            .filter({ hasText: "Browser move destination" });
          await inPlaceAction(page, {
            endpoint: "/api/v1/events/action",
            form: dialog.locator("[data-event-save]"),
            trigger: () =>
              dialog
                .getByRole("button", { name: "Create event", exact: true })
                .click(),
            updated: () => destinationCard.waitFor(),
            loadingLabel: "Creating…",
          });
          const filters = page.getByRole("group", {
            name: "Filter events",
            exact: true,
          });
          await filters
            .getByRole("button", { name: /^Orientations \(\d+\)$/ })
            .click();
          assert.equal(
            await page
              .locator(
                '[data-live-event][data-includes-orientation="false"]:visible',
              )
              .count(),
            0,
          );
          await filters.getByRole("button", { name: /^All \(\d+\)$/ }).click();
          assert.equal(
            await page.locator("[data-live-event][hidden]").count(),
            0,
          );
          await filters.getByRole("button", { name: /^All \(\d+\)$/ }).click();
          assert.equal(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth,
            ),
            true,
          );
          routeCookie = bob.cookie;
          await page.goto(`${origin}/events`);
          const card = page
            .locator("[data-live-event]")
            .filter({ hasText: "Browser-created meeting point" });
          await page.route("**/api/v1/events/action", (route) =>
            route.fulfill({
              status: 409,
              json: { message: "This event is full." },
            }),
          );
          await card
            .getByRole("button", { name: "Register", exact: true })
            .click();
          await card
            .getByText("This event is full.", { exact: true })
            .waitFor();
          assert.equal(
            await card.locator("[data-form-message]").isVisible(),
            true,
          );
          await page.unroute("**/api/v1/events/action");
          await expect(
            card.getByRole("button", { name: "Register", exact: true }),
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
              endpoint: "/api/v1/events/action",
              form: target.locator("[data-live-signup]"),
              trigger: async () => {
                await target.locator("[data-live-signup] button").click();
                if (action === "cancel")
                  await page
                    .getByRole("dialog", {
                      name: "Unregister from this event?",
                      exact: true,
                    })
                    .getByRole("button", { name: "Unregister", exact: true })
                    .click();
              },
              updated,
              loadingLabel:
                action === "join" ? "Registering…" : "Unregistering…",
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
            .getByRole("button", { name: /^All \(\d+\)$/ })
            .click();
          await changeSpot("join", () =>
            card.getByText("Registered", { exact: true }).waitFor(),
          );
          await expect(card.locator(".volunteer-spots")).toHaveText(
            "Registered",
          );
          await expect(
            card.getByRole("button", { name: "Unregister", exact: true }),
          ).toBeFocused();
          await expect(page).toHaveURL(/\/events$/);
          await volunteerFilters
            .getByRole("button", { name: /^Orientations \(\d+\)$/ })
            .click();
          await expect(card).toBeHidden();
          await volunteerFilters
            .getByRole("button", { name: /^All \(\d+\)$/ })
            .click();
          await expect(card).toBeVisible();
          assert.equal(await page.locator("[data-action-notice]").count(), 0);
          assert.equal(
            await page
              .getByText("Your registration is confirmed.", { exact: true })
              .count(),
            0,
          );
          routeCookie = organizer.cookie;
          await page.goto(`${origin}/events`);
          await card.locator(".volunteer-roster > summary").click();
          await card.locator("[data-signup-menu-trigger]").click();
          await card
            .getByRole("menuitem", { name: "Move volunteer", exact: true })
            .click();
          const signupDialog = page.getByRole("dialog", {
            name: "Move volunteer",
            exact: true,
          });
          const sourceId = (await card.getAttribute("data-live-event"))!;
          const destinationId =
            (await destinationCard.getAttribute("data-live-event"))!;
          await signupDialog
            .getByLabel("Destination", { exact: true })
            .selectOption(destinationId);
          await inPlaceAction(page, {
            endpoint: "/api/v1/events/action",
            form: signupDialog.locator("[data-manage-signup]"),
            notify: true,
            trigger: () =>
              signupDialog
                .getByRole("button", {
                  name: "Move volunteer",
                  exact: true,
                })
                .click(),
            updated: async () => {
              await expect(card.locator(".volunteer-roster")).toHaveCount(0);
              await expect(
                destinationCard.locator(".volunteer-roster > summary"),
              ).toHaveText("Volunteers (1)");
            },
            loadingLabel: "Sending…",
          });
          const registrationEmailResult = page.getByRole("dialog", {
            name: "Registration changed",
            exact: true,
          });
          await expect(registrationEmailResult).toContainText(
            "Registration moved.",
          );
          await expect(registrationEmailResult).toContainText(
            "could not be sent",
          );
          const retryEmail = registrationEmailResult.getByRole("button", {
            name: "Retry email only",
            exact: true,
          });
          const retryRequest = page.waitForRequest(
            (request) =>
              request.url().endsWith("/api/v1/events/action") &&
              request.postDataJSON().action === "retry-notifications",
          );
          await retryEmail.click();
          const emailOperation = (await retryRequest).postDataJSON().operation;
          assert.ok(emailOperation);
          await expect(registrationEmailResult).toContainText(
            "change was not repeated",
          );
          await expect(retryEmail).toBeEnabled();
          // Expired records remain stored, but this action can no longer resend
          // them outside the provider's idempotency window.
          const expiredAt = Date.now() - 24 * 60 * 60 * 1000;
          await DB.batch([
            DB.prepare(
              "UPDATE event_notification SET created_at=? WHERE operation_id=?",
            ).bind(expiredAt, emailOperation),
            DB.prepare(
              "UPDATE event_notification_batch SET created_at=? WHERE operation_id=?",
            ).bind(expiredAt, emailOperation),
          ]);
          await retryEmail.click();
          await expect(registrationEmailResult).toContainText(
            "no longer safe to retry",
          );
          await expect(retryEmail).toBeHidden();
          await registrationEmailResult
            .getByRole("button", { name: "Close", exact: true })
            .click();
          await expect(card.locator(".volunteer-roster")).toHaveCount(0);
          await destinationCard.locator(".volunteer-roster > summary").click();
          await destinationCard.locator("[data-signup-menu-trigger]").click();
          await destinationCard
            .getByRole("menuitem", { name: "Move volunteer", exact: true })
            .click();
          await signupDialog
            .getByLabel("Destination", { exact: true })
            .selectOption(sourceId);
          await inPlaceAction(page, {
            endpoint: "/api/v1/events/action",
            form: signupDialog.locator("[data-manage-signup]"),
            trigger: () =>
              signupDialog
                .getByRole("button", {
                  name: "Move volunteer",
                  exact: true,
                })
                .click(),
            updated: async () => {
              await expect(
                card.locator(".volunteer-roster > summary"),
              ).toHaveText("Volunteers (1)");
              await expect(
                destinationCard.locator(".volunteer-roster"),
              ).toHaveCount(0);
            },
            loadingLabel: "Moving…",
          });
          await card.locator(".volunteer-roster > summary").click();
          await card.locator("[data-signup-menu-trigger]").click();
          await card
            .getByRole("menuitem", { name: "Remove volunteer", exact: true })
            .click();
          const removeSignupDialog = page.getByRole("dialog", {
            name: "Remove volunteer",
            exact: true,
          });
          await removeSignupDialog
            .getByLabel("Reason (optional)")
            .fill("Browser-tested cancellation");
          await inPlaceAction(page, {
            endpoint: "/api/v1/events/action",
            form: removeSignupDialog.locator("[data-manage-signup]"),
            trigger: () =>
              removeSignupDialog
                .getByRole("button", {
                  name: "Remove volunteer",
                  exact: true,
                })
                .click(),
            updated: () =>
              expect(card.locator(".volunteer-roster")).toHaveCount(0),
            loadingLabel: "Removing…",
          });
          assert.equal(await removeSignupDialog.isVisible(), false);
          routeCookie = bob.cookie;
          await page.goto(`${origin}/events`);
          await changeSpot("join", () =>
            card.getByText("Registered", { exact: true }).waitFor(),
          );
          await changeSpot("cancel", () =>
            card
              .getByRole("button", { name: "Register", exact: true })
              .waitFor(),
          );
          await expect(card.locator(".volunteer-spots")).toHaveCount(0);
          await expect(
            card.getByRole("button", { name: "Register", exact: true }),
          ).toHaveClass("btn btn-green");
          await expect(
            card.getByText("Registered", { exact: true }),
          ).toHaveCount(0);
          assert.equal(await page.locator("[data-action-notice]").count(), 0);
          assert.equal(
            await page
              .getByText("Your registration was cancelled.", { exact: true })
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
            card.getByText("Registered", { exact: true }).waitFor(),
          );
          const hiddenEventId = await card.getAttribute("data-live-event");
          await DB.prepare("UPDATE event SET hidden=1 WHERE id=?")
            .bind(hiddenEventId)
            .run();
          await page.goto(`${origin}/events?type=patrol`);
          await expect(
            card.getByText("Public visibility off", { exact: true }),
          ).toBeVisible();
          await changeSpot("cancel", () => card.waitFor({ state: "detached" }));
          await expect(
            volunteerFilters.getByRole("button", {
              name: /^All \(\d+\)$/,
            }),
          ).toBeFocused();
          await account.click();
          await nav.getByRole("link", { name: "Account", exact: true }).click();
          await page
            .getByRole("heading", { name: "Account", level: 1, exact: true })
            .waitFor();
          assert.equal(
            (
              await nav.locator("[data-account-menu-name]").textContent()
            )?.trim(),
            "Sample Bob",
          );
          routeCookie = organizer.cookie;
          const attendance = await createEvent("orientation", 5);
          await ok(await join(attendance.id, bob.cookie));
          await DB.prepare("UPDATE event SET starts_at=? WHERE id=?")
            .bind(Date.now() - 1000, attendance.id)
            .run();
          await page.goto(`${origin}/events`);
          const attendanceCard = page.locator(
            `[data-live-event="${attendance.id}"]`,
          );
          await attendanceCard.locator(".volunteer-roster > summary").click();
          await inPlaceAction(page, {
            endpoint: "/api/v1/organizer/action",
            form: attendanceCard.locator("[data-organizer-orientation]"),
            notify: false,
            trigger: () =>
              attendanceCard
                .getByRole("button", {
                  name: "Approve for patrols",
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
            endpoint: "/api/v1/events/action",
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
          await expect(
            page.locator(
              "[data-event-notifications], [data-retry-notifications]",
            ),
          ).toHaveCount(0);
          assert.deepEqual(errors, []);
        } finally {
          await browser.close();
        }
      });
    });
    afterAll(async () => {
      await server.close();
    });
  },
);
