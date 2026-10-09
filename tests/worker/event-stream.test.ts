import { expect, test } from "vitest";
import { createTestHarness } from "wrangler";
import { createSignInOTP } from "../helpers/email-otp";
import { sampleAnswers } from "../helpers/local-account";

test("built Worker streams scoped versions for signups, cancellations and revoked sessions", async () => {
  const origin = "https://afterhoursoutreach.ca";
  const secret = "event-stream-worker-secret-12345678901234567890";
  const server = createTestHarness({
    workers: [
      {
        configPath: "dist/server/wrangler.json",
        vars: { APP_ENV: "production", AUTH_BASE_URL: origin },
        secrets: { BETTER_AUTH_SECRET: secret, RESEND_API_KEY: "" },
      },
    ],
  });
  const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
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
      const registered = await send(
        "/api/v1/account/profile",
        {
          ...sampleAnswers,
          codeOfConductAccepted: true,
        },
        cookie,
      );
      expect(registered.status, await registered.text()).toBe(200);
      const session = (await (
        await send("/api/v1/auth/get-session", undefined, cookie)
      ).json()) as {
        user: { id: string };
        session: { id: string };
      };
      return { cookie, id: session.user.id, sessionId: session.session.id };
    };
    const organizer = await person("stream-organizer@example.org");
    const attendee = await person("stream-attendee@example.org");
    await DB.prepare("INSERT INTO organizer_bootstrap VALUES(1,?,?)")
      .bind(organizer.id, Date.now())
      .run();
    // Bootstrap revokes sessions; the database fixture below only uses its ID.
    const now = Date.now();
    await DB.prepare(
      `INSERT INTO event
      (id,type,starts_at,meeting_point,spots,created_by,created_at,updated_at)
      VALUES ('live','orientation',?,'Stream meeting point',1,?,?,?)`,
    )
      .bind(now + 86_400_000, organizer.id, now, now)
      .run();
    const listingVersion = async (cookie = "") => {
      const html = await (await send("/volunteer", undefined, cookie)).text();
      const version = html.match(/data-event-version="([a-f0-9]{64})"/)?.[1];
      expect(version).toBeDefined();
      return version;
    };
    const stream = async (cookie = "") => {
      const response = await send("/api/v1/events/stream", undefined, cookie);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(
        "text/event-stream; charset=utf-8",
      );
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-robots-tag")).toBe(
        "noindex, nofollow, noarchive",
      );
      expect(response.headers.get("content-security-policy")).toContain(
        "connect-src 'self'",
      );
      const reader = response.body!.getReader();
      readers.push(reader);
      let buffered = "";
      return async () => {
        while (true) {
          const boundary = buffered.indexOf("\n\n");
          if (boundary !== -1) {
            const frame = buffered.slice(0, boundary);
            buffered = buffered.slice(boundary + 2);
            if (frame.startsWith("retry:")) {
              expect(frame).toBe("retry: 2000");
              continue;
            }
            expect(frame).toMatch(/^event: events\ndata: "[a-f0-9]{64}"$/);
            return JSON.parse(
              frame.slice("event: events\ndata: ".length),
            ) as string;
          }
          const next = await reader.read();
          expect(next.done).toBe(false);
          buffered += new TextDecoder().decode(next.value);
        }
      };
    };
    const publicVersion = await listingVersion();
    const publicNext = await stream();
    expect(await publicNext()).toBe(publicVersion);
    const signedInNext = await stream(attendee.cookie);
    expect(await signedInNext()).toBe(await listingVersion(attendee.cookie));

    const joined = await send(
      "/api/v1/events/action",
      { action: "join", id: "live" },
      attendee.cookie,
    );
    expect(joined.status, await joined.text()).toBe(200);
    const joinedVersion = await listingVersion();
    expect(joinedVersion).not.toBe(publicVersion);
    await expect.poll(publicNext).toBe(joinedVersion);
    await expect.poll(signedInNext).toBe(await listingVersion(attendee.cookie));

    const cancelled = await send(
      "/api/v1/events/action",
      { action: "cancel", id: "live" },
      attendee.cookie,
    );
    expect(cancelled.status, await cancelled.text()).toBe(200);
    await expect.poll(publicNext).toBe(publicVersion);
    await expect.poll(signedInNext).toBe(await listingVersion(attendee.cookie));

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
    await expect.poll(publicNext).toBe(hiddenPublicVersion);
    const hiddenPersonalVersion = await listingVersion(attendee.cookie);
    await expect.poll(signedInNext).toBe(hiddenPersonalVersion);
    await DB.prepare("UPDATE event SET spots=2 WHERE id='live'").run();
    expect(await listingVersion()).toBe(hiddenPublicVersion);
    const capacityVersion = await listingVersion(attendee.cookie);
    expect(capacityVersion).not.toBe(hiddenPersonalVersion);
    await expect.poll(signedInNext).toBe(capacityVersion);
    await expect.poll(publicNext).toBe(hiddenPublicVersion);

    await DB.prepare("DELETE FROM session WHERE id=?")
      .bind(attendee.sessionId)
      .run();
    await expect.poll(signedInNext).toBe(hiddenPublicVersion);
    const crossOrigin = await worker.fetch(
      "https://evil.example/api/v1/events/stream",
    );
    expect(crossOrigin.status).toBe(403);
  } finally {
    await Promise.all(readers.map((reader) => reader.cancel()));
    await server.close();
  }
});
