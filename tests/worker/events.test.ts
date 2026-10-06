import assert from "node:assert/strict";
import { test } from "node:test";
import { createTestHarness } from "wrangler";
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
      "last spot is atomic across simultaneous signups and email failure does not undo it",
      async () => {
        const responses = await Promise.all([
          join(orientation.id, alice.cookie),
          join(orientation.id, bob.cookie),
        ]);
        assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
        const result = (await responses
          .find((r) => r.status === 200)!
          .json()) as { pending: number; localNotifications?: unknown };
        assert.equal(result.pending, 1);
        assert.equal(result.localNotifications, undefined);
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

  } finally {
    await server.close();
  }
});
