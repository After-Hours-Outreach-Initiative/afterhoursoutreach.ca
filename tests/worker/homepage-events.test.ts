import { expect, test } from "vitest";
import { createTestHarness } from "wrangler";
import { formatEventDate } from "../../src/data/event-time";
import { createSignInOTP } from "../helpers/email-otp";

test("homepage exposes only the next two published dates and total confirmed counts to every visitor", async () => {
  const origin = "https://afterhoursoutreach.ca";
  const secret = "homepage-events-test-secret-12345678901234567890";
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
    const readHomepage = async (cookie = "") => {
      const response = await worker.fetch(origin, { headers: { cookie } });
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const html = await response.text();
      const section = html.match(
        /<section\b[^>]*id="upcoming-events"[\s\S]*?<\/section>/,
      )?.[0];
      expect(section).toBeDefined();
      expect(section).not.toMatch(/PRIVATE|meetingPoint|userId|eventId/);
      return section!;
    };
    expect(await readHomepage()).toContain("No upcoming events are scheduled.");

    await DB.batch([
      DB.prepare(
        `INSERT INTO user (id,name,email,email_verified,role,created_at,updated_at)
        VALUES ('homepage-organizer','PRIVATE NAME','homepage@example.org',1,'organizer',0,0)`,
      ),
      DB.prepare(
        `INSERT INTO profile (user_id,preferred_name,phone,birth_date,emergency_contact_name,
        emergency_contact_phone,emergency_contact_relationship,heard_about_us,motivation,
        teams,medical_certification,training_experience,registered_at,updated_at)
        VALUES ('homepage-organizer','PRIVATE NAME','555','2000-01-01','Contact',
        '555','Friend','Friend','Help','[]','None','None',0,0)`,
      ),
      DB.prepare(
        `INSERT INTO volunteer_status (user_id,registration_approved,patrol_approved,approved_by,approved_at,updated_at)
        VALUES ('homepage-organizer',1,1,'homepage-organizer',0,0)`,
      ),
    ]);
    const first = Date.now() + 3 * 86_400_000;
    const second = first + 86_400_000;
    const fixtures = [
      ["third", first + 2 * 86_400_000, "patrol", 10, 1, 0, null],
      ["first", first, "patrol", 8, 1, 0, null],
      ["hidden", first - 60_000, "patrol", 8, 1, 1, null],
      ["closed", first - 120_000, "patrol", 8, 0, 0, null],
      ["cancelled", first - 180_000, "patrol", 8, 1, 0, 1],
      ["deleted", first - 240_000, "patrol", 8, 1, 0, null],
      ["past", Date.now() - 86_400_000, "patrol", 8, 1, 0, null],
      ["second", second, "orientation", 6, 1, 0, null],
    ];
    await DB.batch(
      fixtures.map(([id, startsAt, type, spots, open, hidden, cancelledAt]) =>
        DB.prepare(
          `INSERT INTO event (id,starts_at,type,spots,open,hidden,cancelled_at,
          meeting_point,meeting_point_url,created_by,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,'PRIVATE LOCATION','https://example.org/PRIVATE',
          'homepage-organizer',0,0)`,
        ).bind(id, startsAt, type, spots, open, hidden, cancelledAt),
      ),
    );
    await DB.batch([
      DB.prepare(
        `INSERT INTO event_audit (id,event_id,actor_id,action,created_at)
        VALUES ('removed','deleted','homepage-organizer','deleted',0)`,
      ),
      DB.prepare(
        `INSERT INTO signup (id,event_id,user_id,status,created_at,updated_at)
        VALUES ('confirmed','first','homepage-organizer','confirmed',0,0),
        ('cancelled','first','homepage-organizer','cancelled',0,0)`,
      ),
    ]);
    const publicSection = await readHomepage();
    const entries = [
      ...publicSection.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/g),
    ].map((match) =>
      match[1]
        .replace(/<[^>]*>/g, " ")
        .replace(/\s+/g, " ")
        .trim(),
    );
    expect(entries).toEqual([
      `${formatEventDate(first)} 1 of 8 spots taken`,
      `${formatEventDate(second)} 0 of 6 spots taken`,
    ]);
    expect(publicSection).toContain(new Date(first).toISOString());
    expect(publicSection).toContain(new Date(second).toISOString());

    const signedIn = await worker.fetch(
      `${origin}/api/v1/auth/sign-in/email-otp`,
      {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify(
          await createSignInOTP(DB, secret, "homepage@example.org"),
        ),
      },
    );
    expect(signedIn.status).toBe(200);
    const cookie = signedIn.headers
      .getSetCookie()
      .filter((value) => !value.includes("Max-Age=0"))
      .map((value) => value.split(";")[0])
      .join("; ");
    expect(await readHomepage(cookie)).toBe(publicSection);
    // The summary must not relax the protected event/roster API.
    expect((await worker.fetch(`${origin}/api/v1/events`)).status).toBe(401);
  } finally {
    await server.close();
  }
});
