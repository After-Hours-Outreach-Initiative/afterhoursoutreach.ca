import assert from "node:assert/strict";
import { test } from "vitest";
import { createTestHarness } from "wrangler";
import { createSignInOTP } from "../helpers/email-otp";

test("Discord routes enforce same-origin consent and browser/session binding without altering email sign-in", async () => {
  const origin = "https://afterhoursoutreach.ca",
    secret = "discord-route-test-auth-secret-12345678901234567890";
  const server = createTestHarness({
    workers: [
      {
        configPath: "dist/server/wrangler.json",
        vars: {
          APP_ENV: "production",
          AUTH_BASE_URL: origin,
          DISCORD_CLIENT_ID: "100000000000000001",
          DISCORD_GUILD_ID: "100000000000000002",
          DISCORD_VOLUNTEER_ROLE_ID: "100000000000000003",
          DISCORD_ORGANIZER_ROLE_ID: "100000000000000004",
          DISCORD_MEDIC_ROLE_ID: "100000000000000005",
        },
        secrets: {
          BETTER_AUTH_SECRET: secret,
          RESEND_API_KEY: "",
          DISCORD_CLIENT_SECRET: "test-only-client-secret",
          DISCORD_BOT_TOKEN: "test-only-bot-token",
          DISCORD_TOKEN_ENCRYPTION_KEY: btoa(
            "01234567890123456789012345678901",
          ),
        },
      },
    ],
  });
  try {
    await server.listen();
    const worker = server.getWorker<Env>();
    await worker.applyD1Migrations("DB");
    const { DB } = await worker.getEnv();
    for (const id of ["alice", "bob"]) {
      await DB.prepare(
        "INSERT INTO user (id,name,email,email_verified,created_at,updated_at) VALUES (?,?,?,1,1,1)",
      )
        .bind(id, id, `${id}@example.org`)
        .run();
      await DB.prepare(
        `INSERT INTO profile (user_id,preferred_name,phone,birth_date,emergency_contact_name,emergency_contact_phone,
        emergency_contact_relationship,heard_about_us,motivation,teams,medical_certification,training_experience,registered_at,updated_at,naloxone_completed_at)
        VALUES (?,?,'555','2000-01-01','Contact','555','Friend','Friend','Help','[]','None','None',1,1,1)`,
      )
        .bind(id, id)
        .run();
      await DB.prepare(
        "INSERT INTO volunteer_status (user_id,updated_at) VALUES (?,1)",
      )
        .bind(id)
        .run();
    }
    const send = (path: string, cookie: string, body?: object, site = origin) =>
      worker.fetch(origin + path, {
        method: body ? "POST" : "GET",
        redirect: "manual",
        headers: { cookie, origin: site, "Content-Type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    const login = async (id: string) => {
      const response = await send(
        "/api/v1/auth/sign-in/email-otp",
        "",
        await createSignInOTP(DB, secret, `${id}@example.org`),
      );
      assert.equal(response.status, 200);
      return response.headers
        .getSetCookie()
        .filter((value) => !value.includes("Max-Age=0"))
        .map((value) => value.split(";")[0])
        .join("; ");
    };
    const alice = await login("alice"),
      bob = await login("bob");
    assert.equal(
      (
        await send(
          "/api/v1/account/discord",
          alice,
          { userId: "alice", consent: true },
          "https://evil.example",
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await send("/api/v1/account/discord", alice, {
          userId: "bob",
          consent: true,
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await send("/api/v1/account/discord", alice, {
          userId: "alice",
          consent: false,
        })
      ).status,
      400,
    );
    const response = await send("/api/v1/account/discord", alice, {
      userId: "alice",
      consent: true,
    });
    assert.equal(response.status, 200, await response.clone().text());
    const { url } = (await response.json()) as { url: string };
    const state = new URL(url).searchParams.get("state")!;
    const browser = response.headers
      .getSetCookie()
      .find((value) => value.startsWith("aho_discord_link="))!;
    assert.match(browser, /HttpOnly/i);
    assert.match(browser, /Secure/i);
    assert.match(browser, /SameSite=Lax/i);
    assert.match(browser, /Path=\/api\/v1\/account\/discord\/callback/i);
    const cancelled = `/api/v1/account/discord/callback?state=${state}&iss=https%3A%2F%2Fdiscord.com&error=access_denied`;
    const swapped = await send(cancelled, `${bob}; ${browser.split(";")[0]}`);
    assert.equal(swapped.status, 303);
    assert.match(
      new URL(swapped.headers.get("Location")!).searchParams.get("discord")!,
      /account changed/,
    );
    assert.equal(
      await DB.prepare("SELECT count(*) AS n FROM discord_oauth").first("n"),
      1,
    );
    const denied = await send(cancelled, `${alice}; ${browser.split(";")[0]}`);
    assert.equal(denied.status, 303);
    assert.match(
      new URL(denied.headers.get("Location")!).searchParams.get("discord")!,
      /cancelled/,
    );
    assert.equal(
      await DB.prepare("SELECT count(*) AS n FROM discord_oauth").first("n"),
      0,
    );
    const replay = await send(cancelled, `${alice}; ${browser.split(";")[0]}`);
    assert.match(
      new URL(replay.headers.get("Location")!).searchParams.get("discord")!,
      /expired/,
    );
    const status = await send("/api/v1/account/discord", alice);
    assert.equal(status.headers.get("Cache-Control"), "no-store");
    assert.equal(status.headers.get("Referrer-Policy"), "no-referrer");
    const data = (await status.json()) as {
      configured: boolean;
      userId: string;
    };
    assert.equal(data.configured, true);
    assert.equal(data.userId, "alice");
    const session = await send("/api/v1/auth/get-session", alice);
    assert.equal(
      ((await session.json()) as { user: { id: string } }).user.id,
      "alice",
    );
    assert.equal(
      await DB.prepare("SELECT count(*) AS n FROM discord_link").first("n"),
      0,
    );
  } finally {
    await server.close();
  }
});
