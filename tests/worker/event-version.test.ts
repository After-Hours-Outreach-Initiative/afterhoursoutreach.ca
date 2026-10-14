import { expect, test } from "vitest";
import { createTestHarness } from "wrangler";
import { createSignInOTP } from "../helpers/email-otp";
import { sampleAnswers } from "../helpers/local-account";

test("built Worker returns scoped versions for signups, cancellations and revoked sessions", async () => {
  const origin = "https://afterhoursoutreach.ca";
  const secret = "event-version-worker-secret-12345678901234567890";
  const server = createTestHarness({
    workers: [
      {
        configPath: "dist/server/wrangler.json",
        vars: { APP_ENV: "production", AUTH_BASE_URL: origin },
        secrets: { BETTER_AUTH_SECRET: secret, RESEND_API_KEY: "" },
      },
    ],
  });
  try {
    await server.listen();
    const worker = server.getWorker<Env>();
    await worker.applyD1Migrations("DB");
    const { DB } = await worker.getEnv();
    const send = (path: string, body?: object, cookie = "") =>
      worker.fetch(`${origin}${path}`, {
        method: body ? "POST" : "GET",
        headers: { origin, "content-type": "application/json", cookie },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    const person = async (email: string) => {
      const proof = await createSignInOTP(DB, secret, email);
      const signedIn = await send("/api/v1/auth/sign-in/email-otp", proof);
      expect(signedIn.status, await signedIn.text()).toBe(200);
      const cookie = signedIn.headers
        .getSetCookie()
        .filter((value) => !value.includes("Max-Age=0"))
        .map((value) => value.split(";")[0])
        .join("; ");
      const application = await send(
        "/api/v1/account/profile",
        {
          ...sampleAnswers,
          codeOfConductAccepted: true,
        },
        cookie,
      );
      expect(application.status, await application.text()).toBe(200);
      const session = (await (
        await send("/api/v1/auth/get-session", undefined, cookie)
      ).json()) as {
        user: { id: string };
        session: { id: string };
      };
      return { cookie, id: session.user.id, sessionId: session.session.id };
    };
    const organizer = await person("version-organizer@example.org");
    const attendee = await person("version-attendee@example.org");
    await DB.prepare("INSERT INTO organizer_bootstrap VALUES(1,?,?)")
      .bind(organizer.id, Date.now())
      .run();
    // Bootstrap revokes sessions; the database fixture below only uses its ID.
    const now = Date.now();
    await DB.prepare(
      `INSERT INTO event
      (id,type,starts_at,meeting_point,spots,created_by,created_at,updated_at)
       VALUES ('live','orientation',?,'Polling meeting point',1,?,?,?)`,
    )
      .bind(now + 86_400_000, organizer.id, now, now)
      .run();
    const listingVersion = async (cookie = "") => {
      const html = await (await send("/volunteer", undefined, cookie)).text();
      const version = html.match(/data-event-version="([a-f0-9]{64})"/)?.[1];
      expect(version).toBeDefined();
      return version;
    };
    const readVersion = async (cookie = "") => {
      const response = await send("/api/v1/events/version", undefined, cookie);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/json");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-robots-tag")).toBe(
        "noindex, nofollow, noarchive",
      );
      expect(response.headers.get("content-security-policy")).toContain(
        "connect-src 'self'",
      );
      const result = (await response.json()) as { version: string };
      expect(result).toEqual({
        version: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      return result.version;
    };
    const publicVersion = await listingVersion();
    const publicNext = () => readVersion();
    const signedInNext = () => readVersion(attendee.cookie);
    expect(await publicNext()).toBe(publicVersion);
    expect(await signedInNext()).toBe(await listingVersion(attendee.cookie));
    // Pending accounts see no event activity; approval immediately changes their scoped view.
    expect(
      await (await send("/volunteer", undefined, attendee.cookie)).text(),
    ).toContain("Application awaiting approval");
    await DB.prepare(
      "UPDATE volunteer_status SET registration_approved=1 WHERE user_id=?",
    )
      .bind(attendee.id)
      .run();
    const approvedVersion = await listingVersion(attendee.cookie);
    expect(await signedInNext()).toBe(approvedVersion);

    const joined = await send(
      "/api/v1/events/action",
      { action: "join", id: "live" },
      attendee.cookie,
    );
    expect(joined.status, await joined.text()).toBe(200);
    const joinedVersion = await listingVersion();
    expect(joinedVersion).toBe(publicVersion);
    expect(await publicNext()).toBe(joinedVersion);
    expect(await signedInNext()).not.toBe(approvedVersion);
    expect(await signedInNext()).toBe(await listingVersion(attendee.cookie));

    const cancelled = await send(
      "/api/v1/events/action",
      { action: "cancel", id: "live" },
      attendee.cookie,
    );
    expect(cancelled.status, await cancelled.text()).toBe(200);
    expect(await publicNext()).toBe(publicVersion);
    expect(await signedInNext()).toBe(await listingVersion(attendee.cookie));

    // A hidden event never changes a visitor's version, but an existing
    // attendee can still see its availability through their scoped view.
    const joinedAgain = await send(
      "/api/v1/events/action",
      { action: "join", id: "live" },
      attendee.cookie,
    );
    expect(joinedAgain.status, await joinedAgain.text()).toBe(200);
    await DB.prepare("UPDATE event SET hidden=1 WHERE id='live'").run();
    const hiddenPublicVersion = await listingVersion();
    expect(await publicNext()).toBe(hiddenPublicVersion);
    const hiddenPersonalVersion = await listingVersion(attendee.cookie);
    expect(await signedInNext()).toBe(hiddenPersonalVersion);
    await DB.prepare("UPDATE event SET spots=2 WHERE id='live'").run();
    expect(await listingVersion()).toBe(hiddenPublicVersion);
    const capacityVersion = await listingVersion(attendee.cookie);
    expect(capacityVersion).not.toBe(hiddenPersonalVersion);
    expect(await signedInNext()).toBe(capacityVersion);
    expect(await publicNext()).toBe(hiddenPublicVersion);

    await DB.prepare("DELETE FROM session WHERE id=?")
      .bind(attendee.sessionId)
      .run();
    expect(await signedInNext()).toBe(hiddenPublicVersion);
    const crossOrigin = await worker.fetch(
      "https://evil.example/api/v1/events/version",
    );
    expect(crossOrigin.status).toBe(403);
  } finally {
    await server.close();
  }
});
