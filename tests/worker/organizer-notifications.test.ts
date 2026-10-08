import assert from "node:assert/strict";
import { afterAll, beforeAll, describe, test } from "vitest";
import { createTestHarness } from "wrangler";
import { createSignInOTP } from "../helpers/email-otp";

const origin = "https://afterhoursoutreach.ca";
const secret = "organizer-email-test-secret-12345678901234567890";
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
  medicalConditions: "None",
};

// Keep the successive consent choices in the original workflow order.
describe(
  "organizer emails require explicit opt-in in the built Worker",
  { concurrent: false, shuffle: false },
  () => {
    const server = createTestHarness({
      workers: [
        {
          configPath: "dist/server/wrangler.json",
          vars: { APP_ENV: "production", AUTH_BASE_URL: "" },
          secrets: { BETTER_AUTH_SECRET: secret, RESEND_API_KEY: "" },
        },
      ],
    });
    let worker: ReturnType<typeof server.getWorker<Env>>;
    let DB: Env["DB"];
    let organizer: Awaited<ReturnType<typeof person>>;
    let volunteer: Awaited<ReturnType<typeof person>>;
    beforeAll(async () => {
      await server.listen();
      worker = server.getWorker<Env>();
      await worker.applyD1Migrations("DB");
      DB = (await worker.getEnv()).DB;
      organizer = await person("organizer@example.org", "Sample Organizer");
      volunteer = await person("volunteer@example.org", "Sample Volunteer");
      await DB.prepare("INSERT INTO organizer_bootstrap VALUES(1,?,?)")
        .bind(organizer.id, Date.now())
        .run();
      organizer.cookie = await signIn(organizer.email);
    });
    const send = async (
      path: string,
      body: object | undefined,
      cookie?: string,
    ) => {
      const response = await worker.fetch(`${origin}${path}`, {
        method: body ? "POST" : "GET",
        headers: {
          origin,
          "content-type": "application/json",
          ...(cookie ? { cookie } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      assert.equal(response.status, 200, await response.clone().text());
      return response;
    };
    const signIn = async (email: string) => {
      const response = await send(
        "/api/auth/sign-in/email-otp",
        await createSignInOTP(DB, secret, email),
      );
      return response.headers
        .getSetCookie()
        .filter((cookie) => !cookie.includes("Max-Age=0"))
        .map((cookie) => cookie.split(";")[0])
        .join("; ");
    };
    const person = async (email: string, name: string) => {
      const cookie = await signIn(email);
      await send(
        "/api/account/profile",
        { ...answers, name, codeOfConductAccepted: true },
        cookie,
      );
      const session = (await (
        await send("/api/auth/get-session", undefined, cookie)
      ).json()) as { user: { id: string } };
      return { id: session.user.id, cookie, email };
    };
    const notificationCount = async () =>
      (await DB.prepare("SELECT count(*) AS n FROM event_notification").first<{
        n: number;
      }>())!.n;
    const eventData = {
      type: "patrol",
      startsAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      meetingPoint: "Sample meeting point",
      meetingPointUrl: "",
      spots: 4,
      open: true,
      hidden: false,
    };
    const createEvent = async () => {
      await send(
        "/api/events/action",
        { action: "save", event: eventData },
        organizer.cookie,
      );
      return (await DB.prepare(
        "SELECT id,updated_at AS version FROM event ORDER BY created_at DESC LIMIT 1",
      ).first<{ id: string; version: number }>())!;
    };

    for (const notify of [undefined, false, true]) {
      test(`notify ${notify === undefined ? "omitted" : notify} applies to every organizer email`, async () => {
        const choice = notify === undefined ? {} : { notify };
        const expected = notify ? 1 : 0;
        const checkMutation = async (
          path: string,
          body: object,
          count = expected,
        ) => {
          const before = await notificationCount();
          const result = (await (
            await send(path, { ...body, ...choice }, organizer.cookie)
          ).json()) as {
            sent: number;
            failed: number;
            pending: number;
            expired: number;
          };
          assert.equal(await notificationCount(), before + count);
          assert.equal(result.sent, 0);
          assert.equal(result.pending, count);
          assert.equal(result.expired, 0);
          assert.equal(result.failed, count);
          return result;
        };
        const status = async (
          active: boolean,
          patrolApproved: boolean,
          count = expected,
        ) => {
          const row = (await DB.prepare(
            "SELECT updated_at AS version, active, patrol_approved AS patrolApproved FROM volunteer_status WHERE user_id=?",
          )
            .bind(volunteer.id)
            .first<{
              version: number;
              active: number;
              patrolApproved: number;
            }>())!;
          return checkMutation(
            "/api/organizer/action",
            {
              action: "status",
              userId: volunteer.id,
              version: row.version,
              active,
              patrolApproved,
            },
            row.active === Number(active) &&
              row.patrolApproved === Number(patrolApproved)
              ? 0
              : count,
          );
        };
        await status(true, true);
        const source = await createEvent();
        const destination = await createEvent();
        await send(
          "/api/events/action",
          { action: "join", id: source.id },
          volunteer.cookie,
        );
        await checkMutation("/api/events/action", {
          action: "save",
          id: source.id,
          version: source.version,
          event: {
            ...eventData,
            meetingPoint: "Updated sample meeting point",
          },
        });
        const signup = (await DB.prepare(
          "SELECT id FROM signup WHERE event_id=? AND status='confirmed'",
        )
          .bind(source.id)
          .first<{ id: string }>())!;
        await checkMutation("/api/events/action", {
          action: "manage-signup",
          id: signup.id,
          destination: destination.id,
          reason: "Sample move",
        });
        const moved = (await DB.prepare(
          "SELECT id FROM signup WHERE event_id=? AND status='confirmed'",
        )
          .bind(destination.id)
          .first<{ id: string }>())!;
        await checkMutation("/api/events/action", {
          action: "manage-signup",
          id: moved.id,
          reason: "Sample removal",
        });
        await send(
          "/api/events/action",
          { action: "join", id: destination.id },
          volunteer.cookie,
        );
        await checkMutation("/api/events/action", {
          action: "cancel-event",
          id: destination.id,
          version: destination.version,
          reason: "Sample cancellation",
        });
        assert.equal(
          (
            await DB.prepare(
              "SELECT status FROM signup WHERE event_id=? AND user_id=?",
            )
              .bind(destination.id, volunteer.id)
              .first()
          )?.status,
          "cancelled",
        );
        await send(
          "/api/events/action",
          { action: "join", id: source.id },
          volunteer.cookie,
        );
        // Access and its automatic spot cancellation are both silent unless opted in.
        await status(false, false, expected * 2);
        assert.equal(
          (
            await DB.prepare(
              "SELECT status FROM signup WHERE event_id=? AND user_id=?",
            )
              .bind(source.id, volunteer.id)
              .first()
          )?.status,
          "cancelled",
        );
        await status(true, true);
        await checkMutation("/api/organizer/action", {
          action: "role",
          userId: volunteer.id,
          role: "organizer",
        });
        await checkMutation("/api/organizer/action", {
          action: "role",
          userId: volunteer.id,
          role: "volunteer",
        });
        volunteer.cookie = await signIn(volunteer.email);
        if (!notify) {
          // Retrying must not resurrect emails skipped or omitted in the request.
          const retry = (await (
            await send(
              "/api/events/action",
              { action: "retry-notifications" },
              organizer.cookie,
            )
          ).json()) as { pending: number };
          assert.equal(await notificationCount(), 0);
          assert.equal(retry.pending, 0);
        }
      });
    }
    afterAll(async () => {
      await server.close();
    });
  },
);
