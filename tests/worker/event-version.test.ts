import { expect, test } from "vitest";
import { createTestHarness } from "wrangler";
import { createSignInOTP } from "../helpers/email-otp";
import { profileWriteBody } from "../helpers/profile-write";
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
    const send = async (
      path: string,
      body?: object,
      cookie = "",
    ): ReturnType<typeof worker.fetch> => {
      if (path === "/api/v1/account/profile" && body)
        body = await profileWriteBody(
          (path) => send(path, undefined, cookie),
          body,
        );
      return worker.fetch(`${origin}${path}`, {
        redirect: "manual",
        method: body ? "POST" : "GET",
        headers: { origin, "content-type": "application/json", cookie },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    };
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
       VALUES ('live','orientation',?,'Polling meeting point',4,?,?,?)`,
    )
      .bind(now + 86_400_000, organizer.id, now, now)
      .run();
    const listingVersion = async (cookie: string, manage = false) => {
      const html = await (
        await send(manage ? "/manage/events" : "/events", undefined, cookie)
      ).text();
      const version = html.match(/data-event-version="([a-f0-9]{64})"/)?.[1];
      expect(version).toBeDefined();
      return version;
    };
    const readVersion = async (cookie = "", manage = false) => {
      const response = await send(
        `/api/v1/events/version${manage ? "?view=manage" : ""}`,
        undefined,
        cookie,
      );
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
    const publicVersion = await readVersion();
    const publicNext = () => readVersion();
    const signedInNext = () => readVersion(attendee.cookie);
    expect(await publicNext()).toBe(publicVersion);
    expect(await signedInNext()).toBe(await listingVersion(attendee.cookie));
    // Pending accounts see no event activity; approval immediately changes their scoped view.
    expect(
      await (await send("/events", undefined, attendee.cookie)).text(),
    ).toContain("Application Form Submitted");
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
    const joinedVersion = await publicNext();
    expect(joinedVersion).toBe(publicVersion);
    expect(await publicNext()).toBe(joinedVersion);
    expect(await signedInNext()).not.toBe(approvedVersion);
    expect(await signedInNext()).toBe(await listingVersion(attendee.cookie));

    const organizerSignIn = await send(
      "/api/v1/auth/sign-in/email-otp",
      await createSignInOTP(DB, secret, "version-organizer@example.org"),
    );
    expect(organizerSignIn.status).toBe(200);
    const organizerCookie = organizerSignIn.headers
      .getSetCookie()
      .filter((value) => !value.includes("Max-Age=0"))
      .map((value) => value.split(";")[0])
      .join("; ");
    for (const path of [
      "/manage/events",
      "/manage/volunteers",
      `/manage/volunteers/${attendee.id}`,
    ]) {
      const anonymous = await send(path);
      expect(anonymous.status).toBe(302);
      expect(
        new URL(anonymous.headers.get("location")!, origin).searchParams.get(
          "returnTo",
        ),
      ).toBe(path);
      expect((await send(path, undefined, attendee.cookie)).status).toBe(403);
      const allowed = await send(path, undefined, organizerCookie);
      expect(allowed.status).toBe(200);
      expect(allowed.headers.get("cache-control")).toBe("no-store");
      expect(allowed.headers.get("referrer-policy")).toBe("no-referrer");
    }
    expect((await send("/api/v1/events/version?view=manage")).status).toBe(401);
    expect(
      (
        await send(
          "/api/v1/events/version?view=manage",
          undefined,
          attendee.cookie,
        )
      ).status,
    ).toBe(403);
    await DB.prepare(
      `INSERT INTO event
      (id,type,starts_at,meeting_point,spots,hidden,created_by,created_at,updated_at)
      VALUES ('hidden','patrol',?,'Private meeting point',3,1,?,?,?),
             ('past','patrol',?,'Past meeting point',3,0,?,?,?)`,
    )
      .bind(
        now + 86_400_000,
        organizer.id,
        now,
        now,
        now - 1000,
        organizer.id,
        now,
        now,
      )
      .run();
    for (const cookie of [attendee.cookie, organizerCookie]) {
      const html = await (await send("/events", undefined, cookie)).text();
      expect(html).toContain('data-live-event="live"');
      expect(html).toContain("data-live-signup");
      expect(html).toMatch(
        cookie === attendee.cookie
          ? />\s*Unregister\s*<\/button>/
          : />\s*Register\s*<\/button>/,
      );
      expect(html).not.toMatch(
        /data-live-event="(?:hidden|past)"|data-event-save|data-live-series|data-manage-signup|volunteer-roster|Renamed attendee/,
      );
    }
    const managementHtml = await (
      await send("/manage/events", undefined, organizerCookie)
    ).text();
    expect(managementHtml).toContain('data-live-event="hidden"');
    expect(managementHtml).toContain('data-live-event="past"');
    expect(managementHtml).toMatch(
      /<a\b[^>]*href="\/events"[^>]*>\s*<svg\b[^>]*aria-hidden="true"[^>]*>[\s\S]*?<\/svg>\s*<span\b[^>]*>View events<\/span>\s*<\/a>/,
    );
    expect(managementHtml).toContain("data-event-save");
    expect(managementHtml).toContain("volunteer-roster");
    expect(managementHtml).not.toMatch(/data-live-signup|Sign in to register/);
    expect(managementHtml.match(/<h1\b[^>]*>[\s\S]*?<\/h1>/g)).toEqual([
      expect.stringMatching(
        /<h1\b[^>]*id="events-heading"[^>]*>Manage events<\/h1>/,
      ),
    ]);
    expect(managementHtml).not.toMatch(/<h2\b[^>]*>\s*Events\s*<\/h2>/);
    expect(managementHtml).toMatch(
      /<button[^>]*data-show-dialog="event-editor-new"[^>]*>[\s\S]*?\bCreate\s*<\/button>/,
    );
    expect(await readVersion(organizerCookie, true)).toBe(
      await listingVersion(organizerCookie, true),
    );
    const browsingVersion = await readVersion(organizerCookie);
    const beforeRename = await readVersion(organizerCookie, true);
    await DB.prepare("UPDATE profile SET preferred_name=? WHERE user_id=?")
      .bind("Renamed attendee", attendee.id)
      .run();
    const organizerJoinedVersion = await readVersion(organizerCookie, true);
    expect(organizerJoinedVersion).not.toBe(beforeRename);
    expect(organizerJoinedVersion).toBe(
      await listingVersion(organizerCookie, true),
    );
    expect(await readVersion(organizerCookie)).toBe(browsingVersion);
    expect(browsingVersion).toBe(await listingVersion(organizerCookie));
    await DB.prepare("UPDATE profile SET first_name='Changed' WHERE user_id=?")
      .bind(attendee.id)
      .run();
    const renamedPublicVersion = await readVersion(organizerCookie);
    expect(renamedPublicVersion).not.toBe(browsingVersion);
    expect(renamedPublicVersion).toBe(await listingVersion(organizerCookie));
    const publicHtml = await (
      await send("/events", undefined, organizerCookie)
    ).text();
    expect(publicHtml).toContain("public-event-roster");
    expect(publicHtml).toContain("Changed V.");
    expect(publicHtml).not.toMatch(
      /Renamed attendee|data-volunteer-profile-link|data-manage-signup/,
    );

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
    // The count is unchanged, but the old registration ID must not stay on screen.
    expect(await readVersion(organizerCookie, true)).not.toBe(
      organizerJoinedVersion,
    );
    await DB.prepare("UPDATE event SET hidden=1 WHERE id='live'").run();
    const hiddenPublicVersion = await publicNext();
    expect(await publicNext()).toBe(hiddenPublicVersion);
    const hiddenPersonalVersion = await listingVersion(attendee.cookie);
    expect(await signedInNext()).toBe(hiddenPersonalVersion);
    await DB.prepare("UPDATE event SET spots=5 WHERE id='live'").run();
    expect(await publicNext()).toBe(hiddenPublicVersion);
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
