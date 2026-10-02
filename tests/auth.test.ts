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
import {
  createEmailChallenge,
  consumeEmailChallenge,
} from "../src/server/auth/challenge";
import { hashAuthValue, takeRateLimit } from "../src/server/auth/abuse";
import { sendSignInEmail, type SignInEmail } from "../src/server/auth/services";
import {
  deliverNotifications,
  queueNotification,
} from "../src/server/events/notifications";
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
const origin =
  "https://feature-login-afterhoursoutreach-ca.ivanzheng9905.workers.dev";

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
    APP_ENV: "preview",
    AUTH_BASE_URL: origin,
    PREVIEW_HOST_SUFFIX: "-afterhoursoutreach-ca.ivanzheng9905.workers.dev",
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
  const sent = await request("/email/request", {
    email,
  });
  assert.equal(sent.status, 200, await sent.clone().text());
  const challenge = outbox.at(-1)!;
  const signedIn = await request("/email/verify", {
    id: challenge.id,
    code: challenge.code,
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

test("local D1 event notifications never contact a provider, even with a real-shaped key", async () => {
  const { cookie } = await signIn();
  const current = await auth.api.getSession({
    headers: new Headers({ cookie }),
  });
  assert.ok(current);
  const operation = crypto.randomUUID();
  await queueNotification(
    bindings.DB,
    operation,
    current.user.id,
    "Sample subject",
    "Sample body",
  ).run();
  const result = await deliverNotifications(
    { ...bindings, APP_ENV: "local" },
    operation,
    async () => {
      throw new Error("A local notification must not call fetch");
    },
  );
  assert.equal(result.sent, 1);
  assert.equal(result.failed, 0);
  assert.equal(result.pending, 0);
  assert.equal(
    (
      await bindings.DB.prepare(
        "SELECT status FROM event_notification WHERE operation_id=?",
      )
        .bind(operation)
        .first()
    )?.status,
    "local",
  );
});

test("event delivery retries use stable idempotency keys and atomic leases without exposing provider errors", async () => {
  const { cookie } = await signIn();
  const current = await auth.api.getSession({
    headers: new Headers({ cookie }),
  });
  assert.ok(current);
  const operation = crypto.randomUUID();
  await queueNotification(
    bindings.DB,
    operation,
    current.user.id,
    "Sample subject",
    "Sample body",
  ).run();
  const keys: string[] = [];
  const payloads: string[] = [];
  const rejected: typeof fetch = async (_url, init) => {
    keys.push(new Headers(init?.headers).get("Idempotency-Key")!);
    payloads.push(String(init?.body));
    return new Response("PRIVATE PROVIDER BODY", { status: 503 });
  };
  const failure = await deliverNotifications(bindings, operation, rejected);
  assert.equal(failure.failed, 1);
  assert.equal(failure.pending, 1);
  assert.doesNotMatch(
    JSON.stringify(failure),
    /PRIVATE PROVIDER BODY|volunteer@example.org/,
  );
  let calls = 0;
  const accepted: typeof fetch = async (_url, init) => {
    calls++;
    keys.push(new Headers(init?.headers).get("Idempotency-Key")!);
    payloads.push(String(init?.body));
    const payload = JSON.parse(String(init?.body));
    assert.match(payload.subject, /^\[Preview\]/);
    assert.match(payload.text, /public branch preview/);
    return new Response("{}", { status: 200 });
  };
  await Promise.all([
    deliverNotifications(
      {
        ...bindings,
        AUTH_BASE_URL:
          "https://another-branch-afterhoursoutreach-ca.ivanzheng9905.workers.dev",
      },
      operation,
      accepted,
    ),
    deliverNotifications(bindings, operation, accepted),
  ]);
  assert.equal(calls, 1);
  assert.equal(new Set(keys).size, 1);
  assert.equal(
    new Set(payloads).size,
    1,
    "Cross-branch retries must preserve the original sending payload",
  );
  assert.equal(
    (
      await bindings.DB.prepare(
        "SELECT status FROM event_notification WHERE operation_id=?",
      )
        .bind(operation)
        .first()
    )?.status,
    "sent",
  );
  await deliverNotifications(bindings, operation, accepted);
  assert.equal(calls, 1);
});

test("notifications share the sign-in sending budget and old pending mail is not blindly resent", async () => {
  const { cookie } = await signIn();
  const current = await auth.api.getSession({
    headers: new Headers({ cookie }),
  });
  assert.ok(current);
  const operation = crypto.randomUUID();
  await queueNotification(
    bindings.DB,
    operation,
    current.user.id,
    "Sample subject",
    "Sample body",
  ).run();
  const start = Math.floor(Date.now() / 86_400_000) * 86_400_000;
  const key = await hashAuthValue(
    bindings.BETTER_AUTH_SECRET,
    `rate:send-total:86400000:${start}`,
  );
  await bindings.DB.prepare("UPDATE auth_rate_limit SET count=80 WHERE key=?")
    .bind(key)
    .run();
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls++;
    return new Response("{}");
  };
  assert.equal(
    (await deliverNotifications(bindings, operation, fetcher)).failed,
    1,
  );
  assert.equal(calls, 0);
  await bindings.DB.prepare(
    "UPDATE event_notification SET created_at=? WHERE operation_id=?",
  )
    .bind(Date.now() - 24 * 3_600_000, operation)
    .run();
  assert.equal(
    (await deliverNotifications(bindings, operation, fetcher)).pending,
    1,
  );
  assert.equal(calls, 0);
});

test("preview auth resolves only this Worker's HTTPS hosts without mutating shared bindings", () => {
  const base = { ...bindings, AUTH_BASE_URL: "" };
  for (const name of ["feature-login", "other-branch", "abc12345"]) {
    const host = `${name}-afterhoursoutreach-ca.ivanzheng9905.workers.dev`;
    const resolved = authBindingsForRequest(
      base,
      new Request(`https://${host}/api/auth/email/request`, {
        headers: { "x-forwarded-host": "evil.example" },
      }),
    );
    assert.equal(resolved.AUTH_BASE_URL, `https://${host}`);
    assert.equal(resolved.DB, base.DB);
  }
  assert.equal(base.AUTH_BASE_URL, "");
  for (const invalid of [
    "https://afterhoursoutreach.ca",
    "https://afterhoursoutreach-ca.ivanzheng9905.workers.dev",
    "https://feature-other-worker.ivanzheng9905.workers.dev",
    "https://feature-afterhoursoutreach-ca.other-account.workers.dev",
    "https://feature-afterhoursoutreach-ca.ivanzheng9905.workers.dev.evil.example",
    "https://nested.feature-afterhoursoutreach-ca.ivanzheng9905.workers.dev",
    "http://feature-afterhoursoutreach-ca.ivanzheng9905.workers.dev",
    "https://feature-afterhoursoutreach-ca.ivanzheng9905.workers.dev:8443",
    "http://localhost:4321",
  ]) {
    assert.throws(
      () => authBindingsForRequest(base, new Request(invalid)),
      RequestError,
    );
  }
  const local = {
    ...base,
    APP_ENV: "local",
    AUTH_BASE_URL: "http://localhost:4321",
  };
  assert.equal(
    authBindingsForRequest(local, new Request("http://localhost:4321")),
    local,
  );
});

test("real passwordless sign-in creates a verified volunteer and a host-only secure session", async () => {
  const { response, cookie, challenge } = await signIn("Volunteer@Example.org");
  assert.deepEqual(await response.json(), { next: "/volunteer/register" });
  const header = response.headers.get("set-cookie")!;
  assert.match(header, /HttpOnly/i);
  assert.match(header, /Secure/i);
  assert.match(header, /SameSite=Lax/i);
  assert.match(header, /Max-Age=2592000/i);
  assert.doesNotMatch(header, /Domain=/i);
  assert.match(header, /aho-preview/);
  const current = await auth.api.getSession({
    headers: new Headers({ cookie }),
  });
  assert.equal(current?.user.email, "volunteer@example.org");
  assert.equal(current?.user.emailVerified, true);
  assert.equal(current?.user.role, "volunteer");
  assert.equal(current?.session.twoFactorVerified, false);
  const row = await bindings.DB.prepare(
    "SELECT * FROM email_challenge WHERE id = ?",
  )
    .bind(challenge.id)
    .first();
  const token = new URLSearchParams(new URL(challenge.url).hash.slice(1)).get(
    "token",
  )!;
  assert.notEqual(row?.code_hash, challenge.code);
  assert.notEqual(row?.token_hash, token);
  assert.equal(
    (await request("/email/verify", { id: challenge.id, token })).status,
    401,
  );
});

test("link and code redemption race produces exactly one successful result", async () => {
  const challenge = await createEmailChallenge(
    bindings.DB,
    bindings.BETTER_AUTH_SECRET,
    "race@example.org",
  );
  const results = await Promise.all([
    consumeEmailChallenge(
      bindings.DB,
      bindings.BETTER_AUTH_SECRET,
      challenge.id,
      { code: challenge.code },
    ),
    consumeEmailChallenge(
      bindings.DB,
      bindings.BETTER_AUTH_SECRET,
      challenge.id,
      { token: challenge.token },
    ),
  ]);
  assert.equal(results.filter(Boolean).length, 1);
});

test("ten concurrent wrong codes invalidate both code and link", async () => {
  const challenge = await createEmailChallenge(
    bindings.DB,
    bindings.BETTER_AUTH_SECRET,
    "wrong@example.org",
  );
  const wrong = challenge.code === "000000" ? "000001" : "000000";
  await Promise.all(
    Array.from({ length: 10 }, () =>
      consumeEmailChallenge(
        bindings.DB,
        bindings.BETTER_AUTH_SECRET,
        challenge.id,
        { code: wrong },
      ),
    ),
  );
  assert.equal(
    await consumeEmailChallenge(
      bindings.DB,
      bindings.BETTER_AUTH_SECRET,
      challenge.id,
      { code: challenge.code },
    ),
    null,
  );
  assert.equal(
    await consumeEmailChallenge(
      bindings.DB,
      bindings.BETTER_AUTH_SECRET,
      challenge.id,
      { token: challenge.token },
    ),
    null,
  );
  const row = await bindings.DB.prepare(
    "SELECT attempts FROM email_challenge WHERE id = ?",
  )
    .bind(challenge.id)
    .first();
  assert.equal(row?.attempts, 10);
});

test("both proofs expire at one hour; invalid tokens do not consume a valid link", async () => {
  const now = Date.now();
  const challenge = await createEmailChallenge(
    bindings.DB,
    bindings.BETTER_AUTH_SECRET,
    "expiry@example.org",
    "/volunteer/account",
    now,
  );
  assert.equal(
    await consumeEmailChallenge(
      bindings.DB,
      bindings.BETTER_AUTH_SECRET,
      challenge.id,
      { token: "wrong" },
      now + 1000,
    ),
    null,
  );
  assert.equal(
    await consumeEmailChallenge(
      bindings.DB,
      bindings.BETTER_AUTH_SECRET,
      challenge.id,
      { code: challenge.code },
      now + 3_600_000,
    ),
    null,
  );
  assert.equal(
    await consumeEmailChallenge(
      bindings.DB,
      bindings.BETTER_AUTH_SECRET,
      challenge.id,
      { token: challenge.token },
      now + 3_600_000,
    ),
    null,
  );
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
  const first = await request("/email/request", {
    email: "quota@example.org",
  });
  assert.equal(first.status, 200);
  assert.equal(
    (
      await request("/email/request", {
        email: "quota@example.org",
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
    assert.equal((await request("/email/request", { email })).status, 200);
    await bindings.DB.prepare(
      "UPDATE auth_rate_limit SET expires_at = 0 WHERE key = ?",
    )
      .bind(cooldown)
      .run();
  }
  assert.equal((await request("/email/request", { email })).status, 429);
  assert.equal(outbox.length, 3);
});

test("IP sending limits prevent cycling recipient addresses", async () => {
  for (let i = 0; i < 10; i++) {
    assert.equal(
      (await request("/email/request", { email: `ip-quota-${i}@example.org` }))
        .status,
      200,
    );
  }
  assert.equal(
    (await request("/email/request", { email: "one-more@example.org" })).status,
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
    (await request("/email/request", { email: "daily-quota@example.org" }))
      .status,
    429,
  );
  assert.equal(outbox.length, 0);
  const count = await bindings.DB.prepare(
    "SELECT count(*) AS count FROM email_challenge",
  ).first();
  assert.equal(count?.count, 0);
});

test("invalid email requests send no email and create no challenge", async () => {
  for (const email of ["", "not-an-email", "x".repeat(255) + "@example.org"]) {
    assert.equal((await request("/email/request", { email })).status, 400);
  }
  assert.equal(outbox.length, 0);
  const count = await bindings.DB.prepare(
    "SELECT count(*) AS count FROM email_challenge",
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
  const registered = await createEmailChallenge(
    bindings.DB,
    bindings.BETTER_AUTH_SECRET,
    "volunteer@example.org",
    "/volunteer/account?tab=profile",
  );
  const response = await request("/email/verify", {
    id: registered.id,
    token: registered.token,
  });
  assert.deepEqual(await response.json(), {
    next: "/volunteer/account?tab=profile",
  });
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
  const challenge = await createEmailChallenge(
    bindings.DB,
    bindings.BETTER_AUTH_SECRET,
    "volunteer@example.org",
    "/volunteer/account?tab=sample",
  );
  const pending = await request("/email/verify", {
    id: challenge.id,
    code: challenge.code,
  });
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

test("Resend receives a preview-marked message and provider errors never expose its body", async () => {
  const email = {
    email: "volunteer@example.org",
    code: "123456",
    url: `${origin}/volunteer/sign-in/complete#token=secret`,
    id: "test",
  };
  await sendSignInEmail(
    "test-only-key",
    email,
    "preview",
    async (_url, options) => {
      const body = JSON.parse(String(options?.body));
      assert.match(body.subject, /^\[Preview\]/);
      assert.match(body.text, /123456/);
      assert.equal(
        body.from,
        "After Hours Outreach <noreply@afterhoursoutreach.ca>",
      );
      return Response.json({ id: "email-id" });
    },
  );
  await assert.rejects(
    () =>
      sendSignInEmail(
        "test-only-key",
        email,
        "preview",
        async () => new Response("private recipient details", { status: 403 }),
      ),
    (error: unknown) =>
      error instanceof RequestError && !error.message.includes("private"),
  );
});

test("local email delivery never calls Resend, even with a configured key", async () => {
  const email = {
    email: "local@example.org",
    code: "123456",
    url: "http://localhost:4321/volunteer/sign-in/complete#token=local",
    id: "local-test",
  };
  for (const key of [undefined, "test-only-key"]) {
    const captured = await sendSignInEmail(key, email, "local", async () => {
      assert.fail("Local email must not make any network request");
    });
    assert.deepEqual(captured, email);
  }
});

test("email proofs are never returned in a public response, even by a capture service", async () => {
  auth = createAuth(bindings, "192.0.2.1", {
    sendEmail: async (email) => email,
  });
  const response = await request("/email/request", {
    email: "capture@example.org",
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as Record<string, unknown>;
  assert.deepEqual(Object.keys(body), ["id"]);
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
