import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { totpFromSetupKey } from "./helpers/totp";
import { afterEach, beforeEach, test } from "node:test";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import {
  authBindingsForRequest,
  createAuth,
  type AuthBindings,
} from "../src/server/auth";
import { createSignInOTP } from "./helpers/email-otp";
import { hashAuthValue, takeRateLimit } from "../src/server/auth/abuse";
import { sendSignInEmail, type SignInEmail } from "../src/server/auth/services";
import {
  loadProfile,
  profileSchema,
  saveProfile,
} from "../src/server/accounts/profile";
import {
  readJson,
  RequestError,
  requireSameOrigin,
  safeReturnTo,
} from "../src/server/http";

let runtime: Miniflare;
let bindings: AuthBindings;
let outbox: SignInEmail[];
let auth: ReturnType<typeof createAuth>;
const origin = "https://afterhoursoutreach.ca";

beforeEach(async () => {
  runtime = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: "export default { fetch() { return new Response('ok'); } }",
      compatibilityDate: "2026-08-16",
      compatibilityFlags: ["nodejs_compat"],
      d1Databases: { DB: "auth-test-db" },
    }),
  );
  const DB = await runtime.getD1Database("DB");
  const migrations = new URL("../drizzle/", import.meta.url);
  for (const name of readdirSync(migrations)
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    const statements = readFileSync(new URL(name, migrations), "utf8")
      .split("--> statement-breakpoint")
      .map((value) => value.trim())
      .filter(Boolean);
    await DB.batch(statements.map((value) => DB.prepare(value)));
  }
  bindings = {
    DB,
    APP_ENV: "production",
    AUTH_BASE_URL: origin,
    BETTER_AUTH_SECRET: "test-only-auth-secret-not-a-deployed-secret-123456789",
    RESEND_API_KEY: "test-only-resend-key",
  };
  outbox = [];
  auth = createAuth(bindings, "192.0.2.1", {
    sendEmail: async (email) => {
      outbox.push(email);
    },
  });
});

afterEach(async () => {
  await runtime?.dispose();
});

function request(path: string, body?: object, cookie?: string) {
  return auth.handler(
    new Request(`${origin}/api/auth${path}`, {
      method: body ? "POST" : "GET",
      headers: {
        origin,
        "content-type": "application/json",
        ...(cookie ? { cookie } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
  );
}

function cookies(response: Response) {
  return response.headers
    .getSetCookie()
    .filter((cookie) => !cookie.includes("Max-Age=0"))
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
}

async function signIn(email = "volunteer@example.org") {
  const sent = await request("/email-otp/send-verification-otp", {
    email,
    type: "sign-in",
  });
  assert.equal(sent.status, 200, await sent.clone().text());
  const challenge = outbox.at(-1)!;
  const signedIn = await request("/sign-in/email-otp", {
    email: challenge.email,
    otp: challenge.code,
  });
  assert.equal(signedIn.status, 200, await signedIn.clone().text());
  return { response: signedIn, cookie: cookies(signedIn), challenge };
}

const answers = {
  name: "Sample Volunteer",
  pronouns: "they/them",
  phone: "604-555-0100",
  birthDate: "1995-04-12",
  emergencyName: "Sample Contact",
  emergencyPhone: "604-555-0101",
  emergencyRelationship: "Friend",
  heardAboutUs: "A friend",
  motivation: "Sample volunteering answer",
  teams: ["outreach"],
  certification: "None",
  experience: "None",
  medicalConditions: "Sample private answer",
};

test("auth uses the configured site origin or request URL without trusting forwarded hosts", () => {
  const base = { ...bindings, AUTH_BASE_URL: "" };
  for (const origin of [
    "https://afterhoursoutreach.ca",
    "https://test.example.org",
    "https://feature-login-afterhoursoutreach-ca.ivanzheng9905.workers.dev",
  ]) {
    const resolved = authBindingsForRequest(
      base,
      new Request(`${origin}/api/auth/email-otp/send-verification-otp`, {
        headers: { "x-forwarded-host": "evil.example" },
      }),
    );
    assert.equal(resolved.AUTH_BASE_URL, origin);
    assert.equal(resolved.DB, base.DB);
  }
  assert.equal(base.AUTH_BASE_URL, "");
  assert.equal(
    authBindingsForRequest(bindings, new Request(origin)).AUTH_BASE_URL,
    origin,
  );
  for (const invalid of [
    "https://other.example.org",
    "http://afterhoursoutreach.ca",
  ]) {
    assert.throws(
      () => authBindingsForRequest(bindings, new Request(invalid)),
      RequestError,
    );
  }
  const local = {
    ...base,
    APP_ENV: "local",
    AUTH_BASE_URL: "http://localhost:4321",
  };
  // Runtime variables cannot turn a deployed build into local development.
  assert.throws(
    () => authBindingsForRequest(local, new Request("http://localhost:4321")),
    RequestError,
  );
});

test("real passwordless sign-in creates a verified volunteer and a host-only secure session", async () => {
  const { response, cookie, challenge } = await signIn("Volunteer@Example.org");
  assert.equal(
    ((await response.json()) as { next: string }).next,
    "/volunteer/register",
  );
  const header = response.headers.get("set-cookie")!;
  assert.match(header, /HttpOnly/i);
  assert.match(header, /Secure/i);
  assert.match(header, /SameSite=Lax/i);
  assert.match(header, /Max-Age=2592000/i);
  assert.doesNotMatch(header, /Domain=/i);
  assert.match(header, /aho\.session_token/);
  assert.doesNotMatch(header, /aho-preview/);
  const current = await auth.api.getSession({
    headers: new Headers({ cookie }),
  });
  assert.equal(current?.user.email, "volunteer@example.org");
  assert.equal(current?.user.emailVerified, true);
  assert.equal(current?.user.role, "volunteer");
  assert.equal(current?.session.twoFactorVerified, false);
  const proof = new URLSearchParams(new URL(challenge.url).hash.slice(1));
  assert.equal(proof.get("otp"), challenge.code);
  assert.equal(proof.get("email"), challenge.email);
  assert.equal(new URL(challenge.url).search, "");
  assert.equal(
    (
      await request("/sign-in/email-otp", {
        email: proof.get("email"),
        otp: proof.get("otp"),
      })
    ).status,
    400,
  );
});

test("link and code redemption race produces exactly one successful result", async () => {
  const proof = await createSignInOTP(
    bindings.DB,
    bindings.BETTER_AUTH_SECRET!,
    "race@example.org",
  );
  const results = await Promise.all([
    request("/sign-in/email-otp", proof),
    request("/sign-in/email-otp", proof),
  ]);
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(
    (await bindings.DB.prepare("SELECT count(*) AS n FROM session").first())?.n,
    1,
  );
});

test("three wrong codes invalidate both code and link", async () => {
  const proof = await createSignInOTP(
    bindings.DB,
    bindings.BETTER_AUTH_SECRET!,
    "wrong@example.org",
  );
  const wrong = proof.otp === "000000" ? "000001" : "000000";
  for (let attempt = 0; attempt < 3; attempt++)
    assert.equal(
      (await request("/sign-in/email-otp", { ...proof, otp: wrong })).status,
      400,
    );
  assert.equal((await request("/sign-in/email-otp", proof)).status, 403);
  assert.equal((await request("/sign-in/email-otp", proof)).status, 400);
});

test("the plugin stores hashed codes with ten-minute expiry", async () => {
  const now = Date.now();
  const proof = await createSignInOTP(
    bindings.DB,
    bindings.BETTER_AUTH_SECRET!,
    "expiry@example.org",
  );
  const identifier = `sign-in-otp-${proof.email}`;
  const row = await bindings.DB.prepare(
    "SELECT value, expires_at FROM verification WHERE identifier=?",
  )
    .bind(identifier)
    .first<{ value: string; expires_at: number }>();
  assert.ok(row);
  assert.notEqual(row.value.split(":")[0], proof.otp);
  assert.ok(row.expires_at >= now + 600_000);
  assert.ok(row.expires_at <= Date.now() + 600_000);
  await bindings.DB.prepare(
    "UPDATE verification SET expires_at=0 WHERE identifier=?",
  )
    .bind(identifier)
    .run();
  assert.equal((await request("/sign-in/email-otp", proof)).status, 400);
});

test("requesting a new code invalidates the previous code", async () => {
  const old = await createSignInOTP(
    bindings.DB,
    bindings.BETTER_AUTH_SECRET!,
    "rotate@example.org",
  );
  let current = await createSignInOTP(
    bindings.DB,
    bindings.BETTER_AUTH_SECRET!,
    old.email,
  );
  while (current.otp === old.otp)
    current = await createSignInOTP(
      bindings.DB,
      bindings.BETTER_AUTH_SECRET!,
      old.email,
    );
  assert.equal((await request("/sign-in/email-otp", old)).status, 400);
  assert.equal((await request("/sign-in/email-otp", current)).status, 200);
});

test("the per-address verification budget survives code rotation", async () => {
  const email = "verification-quota@example.org";
  for (let attempt = 0; attempt < 10; attempt++) {
    const proof = await createSignInOTP(
      bindings.DB,
      bindings.BETTER_AUTH_SECRET!,
      email,
    );
    const wrong = proof.otp === "000000" ? "000001" : "000000";
    assert.equal(
      (await request("/sign-in/email-otp", { email, otp: wrong })).status,
      400,
    );
  }
  const proof = await createSignInOTP(
    bindings.DB,
    bindings.BETTER_AUTH_SECRET!,
    email,
  );
  assert.equal((await request("/sign-in/email-otp", proof)).status, 429);
});

test("rate limits are atomic, persistent, and do not store raw email/IP keys", async () => {
  const results = await Promise.allSettled(
    Array.from({ length: 12 }, () =>
      takeRateLimit(
        bindings.DB,
        bindings.BETTER_AUTH_SECRET,
        "email:private@example.org",
        3,
        60_000,
      ),
    ),
  );
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    3,
  );
  const rows = await bindings.DB.prepare(
    "SELECT key FROM auth_rate_limit",
  ).all();
  assert.doesNotMatch(JSON.stringify(rows), /private@example.org/);
  const first = await request("/email-otp/send-verification-otp", {
    email: "quota@example.org",
    type: "sign-in",
  });
  assert.equal(first.status, 200);
  assert.equal(
    (
      await request("/email-otp/send-verification-otp", {
        email: "quota@example.org",
        type: "sign-in",
      })
    ).status,
    429,
  );
  assert.equal(outbox.length, 1);
});

test("email hourly limits still apply after the resend cooldown expires", async () => {
  const email = "hourly@example.org";
  const cooldown = await hashAuthValue(
    bindings.BETTER_AUTH_SECRET,
    `send-cooldown:${email}`,
  );
  for (let i = 0; i < 3; i++) {
    assert.equal(
      (
        await request("/email-otp/send-verification-otp", {
          email,
          type: "sign-in",
        })
      ).status,
      200,
    );
    await bindings.DB.prepare(
      "UPDATE auth_rate_limit SET expires_at = 0 WHERE key = ?",
    )
      .bind(cooldown)
      .run();
  }
  assert.equal(
    (
      await request("/email-otp/send-verification-otp", {
        email,
        type: "sign-in",
      })
    ).status,
    429,
  );
  assert.equal(outbox.length, 3);
});

test("IP sending limits prevent cycling recipient addresses", async () => {
  for (let i = 0; i < 10; i++) {
    assert.equal(
      (
        await request("/email-otp/send-verification-otp", {
          email: `ip-quota-${i}@example.org`,
          type: "sign-in",
        })
      ).status,
      200,
    );
  }
  assert.equal(
    (
      await request("/email-otp/send-verification-otp", {
        email: "one-more@example.org",
        type: "sign-in",
      })
    ).status,
    429,
  );
  assert.equal(outbox.length, 10);
});

test("the global daily limit blocks email requests before creating challenges", async () => {
  for (let i = 0; i < 80; i++) {
    await takeRateLimit(
      bindings.DB,
      bindings.BETTER_AUTH_SECRET,
      "send-total",
      80,
      86_400_000,
    );
  }
  assert.equal(
    (
      await request("/email-otp/send-verification-otp", {
        email: "daily-quota@example.org",
        type: "sign-in",
      })
    ).status,
    429,
  );
  assert.equal(outbox.length, 0);
  const count = await bindings.DB.prepare(
    "SELECT count(*) AS count FROM verification",
  ).first();
  assert.equal(count?.count, 0);
});

test("invalid email requests send no email and create no challenge", async () => {
  for (const email of ["", "not-an-email", "x".repeat(255) + "@example.org"]) {
    assert.equal(
      (
        await request("/email-otp/send-verification-otp", {
          email,
          type: "sign-in",
        })
      ).status,
      400,
    );
  }
  assert.equal(outbox.length, 0);
  const count = await bindings.DB.prepare(
    "SELECT count(*) AS count FROM verification",
  ).first();
  assert.equal(count?.count, 0);
});

test("registration/editing persists all answers, keeps approval, and audits only changed field names", async () => {
  const { cookie } = await signIn();
  const current = await auth.api.getSession({
    headers: new Headers({ cookie }),
  });
  assert.ok(current);
  const id = current.user.id;
  await saveProfile(bindings.DB, id, answers);
  assert.deepEqual(await loadProfile(bindings.DB, id), answers);
  await bindings.DB.prepare(
    "INSERT INTO user (id, name, email, email_verified, role, created_at, updated_at) VALUES ('organizer', 'Organizer', 'organizer@example.org', 1, 'organizer', 0, 0)",
  ).run();
  await bindings.DB.prepare(
    "UPDATE volunteer_status SET patrol_approved = 1, approved_by = 'organizer', approved_at = ? WHERE user_id = ?",
  )
    .bind(Date.now(), id)
    .run();
  const edit = {
    ...answers,
    medicalConditions: "Changed sample private answer",
    birthDate: "1993-03-15",
  };
  await saveProfile(bindings.DB, id, edit);
  assert.deepEqual(await loadProfile(bindings.DB, id), edit);
  const status = await bindings.DB.prepare(
    "SELECT patrol_approved FROM volunteer_status WHERE user_id = ?",
  )
    .bind(id)
    .first();
  assert.equal(status?.patrol_approved, 1);
  const logs = await bindings.DB.prepare(
    "SELECT changed_fields FROM audit_log WHERE subject_id = ? ORDER BY created_at",
  )
    .bind(id)
    .all();
  assert.deepEqual(JSON.parse(String(logs.results.at(-1)?.changed_fields)), [
    "birthDate",
    "medicalConditions",
  ]);
  assert.doesNotMatch(
    JSON.stringify(logs),
    /Sample private answer|Changed sample private answer|1993-03-15/,
  );
  const registered = await createSignInOTP(
    bindings.DB,
    bindings.BETTER_AUTH_SECRET!,
    "volunteer@example.org",
  );
  const response = await request(
    "/sign-in/email-otp?returnTo=%2Fvolunteer%2Faccount%3Ftab%3Dprofile",
    registered,
  );
  assert.equal(
    ((await response.json()) as { next: string }).next,
    "/volunteer/account?tab=profile",
  );
});

test("profile validation rejects privilege fields, invalid dates, absent/duplicate teams and oversized answers", () => {
  for (const input of [
    { ...answers, role: "organizer" },
    { ...answers, patrolApproved: true },
    { ...answers, userId: "another-user" },
    { ...answers, birthDate: "1995-02-31" },
    { ...answers, birthDate: "2999-01-01" },
    { ...answers, teams: [] },
    { ...answers, teams: ["outreach", "outreach"] },
    { ...answers, medicalConditions: "x".repeat(2001) },
  ])
    assert.equal(profileSchema.safeParse(input).success, false);
});

test("sign-out revokes the session rather than just removing the browser cookie", async () => {
  const { cookie } = await signIn();
  assert.equal((await request("/sign-out", {}, cookie)).status, 200);
  assert.equal(
    await auth.api.getSession({ headers: new Headers({ cookie }) }),
    null,
  );
});

test("passwordless two-factor enrollment and login cannot bypass the authenticator", async () => {
  const signedIn = await signIn();
  const initial = await auth.api.getSession({
    headers: new Headers({ cookie: signedIn.cookie }),
  });
  await saveProfile(bindings.DB, initial!.user.id, answers);
  const enabled = await request(
    "/two-factor/enable",
    { method: "totp" },
    signedIn.cookie,
  );
  assert.equal(enabled.status, 200, await enabled.clone().text());
  const setup = (await enabled.json()) as {
    totpURI: string;
    backupCodes: string[];
  };
  assert.equal(setup.backupCodes.length, 10);
  const secret = new URL(setup.totpURI).searchParams.get("secret")!;
  const code = totpFromSetupKey(secret);
  const confirmed = await request(
    "/two-factor/verify-totp",
    { code },
    signedIn.cookie,
  );
  assert.equal(confirmed.status, 200, await confirmed.clone().text());
  const currentCookie = cookies(confirmed) || signedIn.cookie;
  const current = await auth.api.getSession({
    headers: new Headers({ cookie: currentCookie }),
  });
  assert.equal(current?.user.twoFactorEnabled, true);
  assert.equal(current?.session.twoFactorVerified, true);
  await request("/sign-out", {}, currentCookie);
  const proof = await createSignInOTP(
    bindings.DB,
    bindings.BETTER_AUTH_SECRET!,
    "volunteer@example.org",
  );
  const pending = await request(
    "/sign-in/email-otp?returnTo=%2Fvolunteer%2Faccount%3Ftab%3Dsample",
    proof,
  );
  assert.equal(
    ((await pending.json()) as { twoFactorRedirect: boolean })
      .twoFactorRedirect,
    true,
  );
  const pendingCookie = cookies(pending);
  assert.equal(
    await auth.api.getSession({
      headers: new Headers({ cookie: pendingCookie }),
    }),
    null,
  );
  const wrong = await request(
    "/two-factor/verify-totp",
    { code: "wrong" },
    pendingCookie,
  );
  assert.equal(wrong.status, 401);
  assert.equal(
    await auth.api.getSession({
      headers: new Headers({ cookie: pendingCookie }),
    }),
    null,
  );
  const verified = await request(
    "/two-factor/verify-backup-code",
    { code: setup.backupCodes[0] },
    pendingCookie,
  );
  assert.equal(verified.status, 200, await verified.clone().text());
  assert.equal(
    ((await verified.clone().json()) as { next: string }).next,
    "/volunteer/account?tab=sample",
  );
  const verifiedCookie = cookies(verified);
  const session = await auth.api.getSession({
    headers: new Headers({ cookie: verifiedCookie }),
  });
  assert.equal(session?.session.twoFactorVerified, true);
  assert.equal(
    (
      await request(
        "/two-factor/verify-backup-code",
        { code: setup.backupCodes[0] },
        verifiedCookie,
      )
    ).status,
    401,
  );
});

test("Resend receives the same sign-in message in every hosted environment and hides provider errors", async () => {
  const email = {
    email: "volunteer@example.org",
    code: "123456",
    url: `${origin}/volunteer/sign-in/complete#email=volunteer%40example.org&otp=123456`,
    id: "test",
  };
  for (const environment of ["production", "preview"]) {
    await sendSignInEmail(
      "test-only-key",
      email,
      environment,
      async (_url, options) => {
        const body = JSON.parse(String(options?.body));
        assert.equal(body.subject, "Your After Hours Outreach sign-in");
        assert.match(body.text, /123456/);
        assert.doesNotMatch(body.text, /public branch preview/);
        assert.equal(
          body.from,
          "After Hours Outreach <noreply@afterhoursoutreach.ca>",
        );
        return Response.json({ id: "email-id" });
      },
    );
  }
  await assert.rejects(
    () =>
      sendSignInEmail(
        "test-only-key",
        email,
        "production",
        async () => new Response("private recipient details", { status: 403 }),
      ),
    (error: unknown) =>
      error instanceof RequestError && !error.message.includes("private"),
  );
});

test("email proofs are never returned in a public response, even by a capture service", async () => {
  auth = createAuth(bindings, "192.0.2.1", {
    sendEmail: async (email) => email,
  });
  const response = await request("/email-otp/send-verification-otp", {
    email: "capture@example.org",
    type: "sign-in",
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as Record<string, unknown>;
  assert.deepEqual(body, { success: true });
});

test("origins and redirect targets are checked; JSON bodies are bounded even without Content-Length", async () => {
  for (const originHeader of ["https://evil.example", "null", ""])
    assert.throws(
      () =>
        requireSameOrigin(
          new Request(origin, { headers: { origin: originHeader } }),
          origin,
        ),
      /website/,
    );
  for (const value of [
    "https://evil.example",
    "//evil.example",
    "/\\evil.example",
    "/volunteer/sign-in",
    "/api/auth/get-session",
  ])
    assert.equal(safeReturnTo(value), "/volunteer/account");
  const request = new Request(origin, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ answer: "x".repeat(1000) }),
  });
  await assert.rejects(
    () => readJson(request, 100),
    (error: unknown) => error instanceof RequestError && error.status === 413,
  );
});
