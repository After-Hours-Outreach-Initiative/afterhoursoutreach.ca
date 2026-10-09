import assert from "node:assert/strict";
import { totpFromSetupKey } from "./helpers/totp";
import { beforeEach, test } from "vitest";
import { env } from "cloudflare:workers";
import {
  authBindingsForRequest,
  createAuth,
  type AuthBindings,
} from "../src/server/auth";
import { createSignInOTP } from "./helpers/email-otp";
import {
  codeOfConductError,
  codeOfConductVersion,
} from "../src/data/code-of-conduct";
import { hashAuthValue, takeRateLimit } from "../src/server/db/rate-limits";
import { sendSignInEmail, type SignInEmail } from "../src/server/auth/services";
import { deliverNotifications } from "../src/server/events/notifications";
import {
  countNotifications,
  queueNotification,
} from "../src/server/db/notifications";
import {
  loadProfile,
  profileSchema,
  saveProfile,
} from "../src/server/db/profiles";
import {
  readJson,
  RequestError,
  requireSameOrigin,
  safeReturnTo,
} from "../src/server/http";

let bindings: AuthBindings;
let outbox: SignInEmail[];
let auth: ReturnType<typeof createAuth>;
const origin = "https://afterhoursoutreach.ca";

beforeEach(async () => {
  bindings = {
    DB: env.DB,
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

function request(path: string, body?: object, cookie?: string) {
  return auth.handler(
    new Request(`${origin}/api/v1/auth${path}`, {
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
    assert.equal(payload.subject, "Sample subject");
    assert.doesNotMatch(payload.text, /public branch preview/);
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
  const expired = await deliverNotifications(bindings, operation, fetcher);
  assert.equal(expired.pending, 0);
  assert.equal(expired.expired, 1);
  assert.deepEqual(await countNotifications(bindings.DB, operation), {
    pending: 0,
    expired: 1,
  });
  assert.equal(calls, 0);
});

test("auth uses the configured site origin or request URL without trusting forwarded hosts", () => {
  const base = { ...bindings, AUTH_BASE_URL: "" };
  for (const origin of [
    "https://afterhoursoutreach.ca",
    "https://test.example.org",
    "https://feature-login-afterhoursoutreach-ca.ivanzheng9905.workers.dev",
  ]) {
    const resolved = authBindingsForRequest(
      base,
      new Request(`${origin}/api/v1/auth/email-otp/send-verification-otp`, {
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

test("registration requires explicit Code of Conduct acknowledgement before any profile writes", async () => {
  const { cookie } = await signIn();
  const current = await auth.api.getSession({
    headers: new Headers({ cookie }),
  });
  assert.ok(current);
  for (const input of [
    answers,
    { ...answers, codeOfConductAccepted: false },
    { ...answers, codeOfConductAccepted: "true" },
    { ...answers, codeOfConductAccepted: 1 },
    { ...answers, codeOfConductAccepted: null },
  ]) {
    await assert.rejects(
      () => saveProfile(bindings.DB, current.user.id, input),
      (error: unknown) => error instanceof RequestError && error.status === 400,
    );
  }
  await assert.rejects(
    () => saveProfile(bindings.DB, current.user.id, answers),
    (error: unknown) =>
      error instanceof RequestError && error.message === codeOfConductError,
  );
  for (const table of ["profile", "volunteer_status", "audit_log"]) {
    const count = await bindings.DB.prepare(
      `SELECT count(*) AS n FROM ${table}`,
    ).first();
    assert.equal(count?.n, 0);
  }
  const person = await bindings.DB.prepare("SELECT name FROM user WHERE id=?")
    .bind(current.user.id)
    .first();
  assert.notEqual(person?.name, answers.name);
});

test("registration/editing persists all answers, keeps approval, and audits only changed field names", async () => {
  const { cookie } = await signIn();
  const current = await auth.api.getSession({
    headers: new Headers({ cookie }),
  });
  assert.ok(current);
  const id = current.user.id;
  const started = Date.now();
  await saveProfile(bindings.DB, id, {
    ...answers,
    codeOfConductAccepted: true,
  });
  assert.deepEqual(await loadProfile(bindings.DB, id), answers);
  const acknowledgement = await bindings.DB.prepare(
    "SELECT code_of_conduct_version, code_of_conduct_accepted_at FROM profile WHERE user_id=?",
  )
    .bind(id)
    .first<{
      code_of_conduct_version: string;
      code_of_conduct_accepted_at: number;
    }>();
  assert.equal(acknowledgement?.code_of_conduct_version, codeOfConductVersion);
  assert.ok(
    acknowledgement &&
      acknowledgement.code_of_conduct_accepted_at >= started &&
      acknowledgement.code_of_conduct_accepted_at <= Date.now(),
  );
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
  assert.deepEqual(
    await bindings.DB.prepare(
      "SELECT code_of_conduct_version, code_of_conduct_accepted_at FROM profile WHERE user_id=?",
    )
      .bind(id)
      .first(),
    acknowledgement,
  );
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

test("registration-only questions are required once and preserved through profile edits", async () => {
  const { cookie } = await signIn();
  const current = await auth.api.getSession({
    headers: new Headers({ cookie }),
  });
  assert.ok(current);
  const id = current.user.id;
  const { heardAboutUs, motivation, ...editable } = answers;
  for (const input of [
    editable,
    { ...editable, heardAboutUs },
    { ...editable, motivation },
  ]) {
    await assert.rejects(
      () =>
        saveProfile(bindings.DB, id, { ...input, codeOfConductAccepted: true }),
      (error: unknown) => error instanceof RequestError && error.status === 400,
    );
  }
  assert.equal(await loadProfile(bindings.DB, id), null);
  await saveProfile(bindings.DB, id, {
    ...answers,
    codeOfConductAccepted: true,
  });
  await saveProfile(bindings.DB, id, {
    ...editable,
    name: "Updated volunteer",
  });
  assert.deepEqual(await loadProfile(bindings.DB, id), {
    ...answers,
    name: "Updated volunteer",
  });
  // A stale client sending the old form cannot replace registration-only answers.
  await saveProfile(bindings.DB, id, {
    ...editable,
    name: "Updated again",
    heardAboutUs: "Replacement referral",
    motivation: "Replacement motivation",
  });
  assert.deepEqual(await loadProfile(bindings.DB, id), {
    ...answers,
    name: "Updated again",
  });
  const logs = await bindings.DB.prepare(
    "SELECT changed_fields FROM audit_log WHERE subject_id=?",
  )
    .bind(id)
    .all();
  const edits = logs.results
    .map((row) => JSON.parse(String(row.changed_fields)) as string[])
    .filter((fields) => fields.length === 1);
  assert.deepEqual(edits, [["name"], ["name"]]);
});

test("existing profiles can be edited without inventing Code of Conduct acknowledgement", async () => {
  const { cookie } = await signIn();
  const current = await auth.api.getSession({
    headers: new Headers({ cookie }),
  });
  assert.ok(current);
  const id = current.user.id;
  await saveProfile(bindings.DB, id, {
    ...answers,
    codeOfConductAccepted: true,
  });
  await bindings.DB.prepare(
    "UPDATE profile SET code_of_conduct_version=NULL, code_of_conduct_accepted_at=NULL WHERE user_id=?",
  )
    .bind(id)
    .run();
  await saveProfile(bindings.DB, id, {
    ...answers,
    name: "Existing volunteer",
  });
  assert.deepEqual(
    await bindings.DB.prepare(
      "SELECT code_of_conduct_version, code_of_conduct_accepted_at FROM profile WHERE user_id=?",
    )
      .bind(id)
      .first(),
    { code_of_conduct_version: null, code_of_conduct_accepted_at: null },
  );
});

test("profile validation rejects privilege fields, invalid dates, absent/duplicate teams and oversized answers", () => {
  for (const input of [
    { ...answers, role: "organizer" },
    { ...answers, patrolApproved: true },
    { ...answers, userId: "another-user" },
    { ...answers, codeOfConductVersion: "forged-version" },
    { ...answers, codeOfConductAcceptedAt: 0 },
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

test("email changes verify the new address and keep the same account, profile and approval", async () => {
  const { cookie } = await signIn();
  const current = (await auth.api.getSession({
    headers: new Headers({ cookie }),
  }))!;
  await saveProfile(bindings.DB, current.user.id, {
    ...answers,
    codeOfConductAccepted: true,
  });
  await bindings.DB.prepare("UPDATE user SET role='organizer' WHERE id=?")
    .bind(current.user.id)
    .run();
  await bindings.DB.prepare(
    "UPDATE volunteer_status SET patrol_approved=1, approved_by=?, approved_at=? WHERE user_id=?",
  )
    .bind(current.user.id, Date.now(), current.user.id)
    .run();
  const sent = await request(
    "/email-otp/request-email-change",
    { newEmail: " New@Example.org " },
    cookie,
  );
  assert.equal(sent.status, 200, await sent.clone().text());
  const challenge = outbox.at(-1)!;
  assert.equal(challenge.purpose, "change-email");
  assert.equal(challenge.email, "new@example.org");
  assert.equal(challenge.url, `${origin}/volunteer/account`);
  assert.equal(
    (await auth.api.getSession({ headers: new Headers({ cookie }) }))?.user
      .email,
    current.user.email,
  );
  const row = await bindings.DB.prepare(
    "SELECT value, expires_at FROM verification WHERE identifier=?",
  )
    .bind("change-email-otp-volunteer@example.org-new@example.org")
    .first<{ value: string; expires_at: number }>();
  assert.ok(row);
  assert.notEqual(row.value.split(":")[0], challenge.code);
  assert.ok(row.expires_at > Date.now() + 590_000);
  const confirmed = await request(
    "/email-otp/change-email",
    { newEmail: "New@Example.org", otp: challenge.code },
    cookie,
  );
  assert.equal(confirmed.status, 200, await confirmed.clone().text());
  const updated = (await auth.api.getSession({
    headers: new Headers({ cookie }),
  }))!;
  assert.equal(updated.user.id, current.user.id);
  assert.equal(updated.user.email, "new@example.org");
  assert.equal(updated.user.emailVerified, true);
  assert.equal(updated.user.role, "organizer");
  assert.deepEqual(await loadProfile(bindings.DB, current.user.id), answers);
  assert.equal(
    (
      await bindings.DB.prepare(
        "SELECT patrol_approved FROM volunteer_status WHERE user_id=?",
      )
        .bind(current.user.id)
        .first()
    )?.patrol_approved,
    1,
  );
  assert.equal(
    (
      await request(
        "/email-otp/change-email",
        { newEmail: "new@example.org", otp: challenge.code },
        cookie,
      )
    ).status,
    400,
  );
  const nextSignIn = await request(
    "/sign-in/email-otp",
    await createSignInOTP(
      bindings.DB,
      bindings.BETTER_AUTH_SECRET,
      "new@example.org",
    ),
  );
  assert.equal(nextSignIn.status, 200, await nextSignIn.clone().text());
  assert.equal(
    (
      await auth.api.getSession({
        headers: new Headers({ cookie: cookies(nextSignIn) }),
      })
    )?.user.id,
    current.user.id,
  );
  assert.equal(
    (await bindings.DB.prepare("SELECT count(*) AS n FROM user").first())?.n,
    1,
  );
});

test("email changes require a fresh verified session and validate inputs before sending", async () => {
  for (const path of [
    "/email-otp/request-email-change",
    "/email-otp/change-email",
  ])
    assert.equal(
      (
        await request(path, {
          newEmail: "new@example.org",
          ...(path.endsWith("/change-email") && { otp: "123456" }),
        })
      ).status,
      401,
    );
  const { cookie } = await signIn();
  const current = (await auth.api.getSession({
    headers: new Headers({ cookie }),
  }))!;
  for (const body of [
    { newEmail: "not-an-email" },
    { newEmail: "x".repeat(255) + "@example.org" },
    { newEmail: "Volunteer@Example.org" },
    { newEmail: "new@example.org", userId: "someone-else" },
  ])
    assert.equal(
      (await request("/email-otp/request-email-change", body, cookie)).status,
      400,
    );
  await bindings.DB.prepare("UPDATE session SET created_at=? WHERE id=?")
    .bind(Date.now() - 2 * 86_400_000, current.session.id)
    .run();
  for (const path of [
    "/email-otp/request-email-change",
    "/email-otp/change-email",
  ])
    assert.equal(
      (
        await request(
          path,
          {
            newEmail: "new@example.org",
            ...(path.endsWith("/change-email") && { otp: "123456" }),
          },
          cookie,
        )
      ).status,
      403,
    );
  assert.equal(outbox.length, 1);
  assert.equal(
    (
      await bindings.DB.prepare(
        "SELECT count(*) AS n FROM verification WHERE identifier LIKE 'change-email-otp-%'",
      ).first()
    )?.n,
    0,
  );
});

test("email-change codes cannot sign in, change another account or change a different address", async () => {
  const { cookie } = await signIn();
  const other = await signIn("other@example.org");
  assert.equal(
    (
      await request(
        "/email-otp/request-email-change",
        { newEmail: "new@example.org" },
        cookie,
      )
    ).status,
    200,
  );
  const code = outbox.at(-1)!.code;
  assert.equal(
    (
      await request("/sign-in/email-otp", {
        email: "new@example.org",
        otp: code,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request(
        "/email-otp/change-email",
        { newEmail: "new@example.org", otp: code },
        other.cookie,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await request(
        "/email-otp/change-email",
        { newEmail: "different@example.org", otp: code },
        cookie,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await request(
        "/email-otp/change-email",
        { newEmail: "new@example.org", otp: code },
        cookie,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await auth.api.getSession({
        headers: new Headers({ cookie: other.cookie }),
      })
    )?.user.email,
    "other@example.org",
  );
});

test("email-change codes expire, limit wrong attempts, and resending replaces the code", async () => {
  const { cookie } = await signIn();
  const newEmail = "new@example.org";
  assert.equal(
    (await request("/email-otp/request-email-change", { newEmail }, cookie))
      .status,
    200,
  );
  const original = outbox.at(-1)!.code;
  const wrong = original === "000000" ? "000001" : "000000";
  for (let i = 0; i < 3; i++)
    assert.equal(
      (
        await request(
          "/email-otp/change-email",
          { newEmail, otp: wrong },
          cookie,
        )
      ).status,
      400,
    );
  assert.equal(
    (
      await request(
        "/email-otp/change-email",
        { newEmail, otp: original },
        cookie,
      )
    ).status,
    403,
  );
  const cooldown = await hashAuthValue(
    bindings.BETTER_AUTH_SECRET,
    `send-cooldown:${newEmail}`,
  );
  await bindings.DB.prepare(
    "UPDATE auth_rate_limit SET expires_at=0 WHERE key=?",
  )
    .bind(cooldown)
    .run();
  assert.equal(
    (await request("/email-otp/request-email-change", { newEmail }, cookie))
      .status,
    200,
  );
  const expired = outbox.at(-1)!.code;
  await bindings.DB.prepare(
    "UPDATE verification SET expires_at=0 WHERE identifier=?",
  )
    .bind(`change-email-otp-volunteer@example.org-${newEmail}`)
    .run();
  assert.equal(
    (
      await request(
        "/email-otp/change-email",
        { newEmail, otp: expired },
        cookie,
      )
    ).status,
    400,
  );
  await bindings.DB.prepare(
    "UPDATE auth_rate_limit SET expires_at=0 WHERE key=?",
  )
    .bind(cooldown)
    .run();
  assert.equal(
    (await request("/email-otp/request-email-change", { newEmail }, cookie))
      .status,
    200,
  );
  const latest = outbox.at(-1)!.code;
  if (latest !== original)
    assert.equal(
      (
        await request(
          "/email-otp/change-email",
          { newEmail, otp: original },
          cookie,
        )
      ).status,
      400,
    );
  assert.equal(
    (
      await request(
        "/email-otp/change-email",
        { newEmail, otp: latest },
        cookie,
      )
    ).status,
    200,
  );
});

test("email-change requests share email budgets and never expose codes in hosted responses", async () => {
  const { cookie } = await signIn();
  auth = createAuth(bindings, "192.0.2.1", {
    sendEmail: async (email) => {
      outbox.push(email);
      return email;
    },
  });
  const body = { newEmail: "new@example.org" };
  const sent = await request("/email-otp/request-email-change", body, cookie);
  assert.equal(sent.status, 200);
  assert.deepEqual(await sent.json(), { success: true });
  assert.equal(
    (await request("/email-otp/request-email-change", body, cookie)).status,
    429,
  );
  assert.equal(
    (
      await request("/email-otp/send-verification-otp", {
        email: body.newEmail,
        type: "sign-in",
      })
    ).status,
    429,
  );
  assert.equal(outbox.length, 2);
});

test("resending an email-change code invalidates the previous one and concurrent confirmation succeeds once", async () => {
  const { cookie } = await signIn();
  const newEmail = "new@example.org";
  await request("/email-otp/request-email-change", { newEmail }, cookie);
  const original = outbox.at(-1)!.code;
  const cooldown = await hashAuthValue(
    bindings.BETTER_AUTH_SECRET,
    `send-cooldown:${newEmail}`,
  );
  await bindings.DB.prepare(
    "UPDATE auth_rate_limit SET expires_at=0 WHERE key=?",
  )
    .bind(cooldown)
    .run();
  await request("/email-otp/request-email-change", { newEmail }, cookie);
  const latest = outbox.at(-1)!.code;
  if (latest !== original)
    assert.equal(
      (
        await request(
          "/email-otp/change-email",
          { newEmail, otp: original },
          cookie,
        )
      ).status,
      400,
    );
  const responses = await Promise.all([
    request("/email-otp/change-email", { newEmail, otp: latest }, cookie),
    request("/email-otp/change-email", { newEmail, otp: latest }, cookie),
  ]);
  assert.equal(responses.filter((response) => response.ok).length, 1);
});

test("existing addresses cannot be taken over and failed delivery leaves no usable email-change code", async () => {
  const { cookie } = await signIn();
  const other = await signIn("taken@example.org");
  const cooldown = await hashAuthValue(
    bindings.BETTER_AUTH_SECRET,
    "send-cooldown:taken@example.org",
  );
  await bindings.DB.prepare(
    "UPDATE auth_rate_limit SET expires_at=0 WHERE key=?",
  )
    .bind(cooldown)
    .run();
  const taken = await request(
    "/email-otp/request-email-change",
    { newEmail: "Taken@Example.org" },
    cookie,
  );
  assert.equal(taken.status, 200);
  assert.deepEqual(await taken.json(), { success: true });
  assert.equal(outbox.length, 2);
  assert.equal(
    (
      await request(
        "/email-otp/change-email",
        { newEmail: "taken@example.org", otp: "123456" },
        cookie,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await auth.api.getSession({
        headers: new Headers({ cookie: other.cookie }),
      })
    )?.user.email,
    "taken@example.org",
  );
  auth = createAuth(bindings, "192.0.2.1", {
    sendEmail: async (email) => {
      outbox.push(email);
      throw new Error("private delivery details");
    },
  });
  const failure = await request(
    "/email-otp/request-email-change",
    { newEmail: "failure@example.org" },
    cookie,
  );
  assert.equal(failure.status, 503);
  assert.doesNotMatch(
    await failure.text(),
    /private delivery details|localEmail/,
  );
  assert.equal(
    (
      await bindings.DB.prepare(
        "SELECT count(*) AS n FROM verification WHERE identifier LIKE 'change-email-otp-%'",
      ).first()
    )?.n,
    0,
  );
  assert.equal(
    (
      await request(
        "/email-otp/change-email",
        { newEmail: "failure@example.org", otp: outbox.at(-1)!.code },
        cookie,
      )
    ).status,
    400,
  );
  assert.equal(
    (await auth.api.getSession({ headers: new Headers({ cookie }) }))?.user
      .email,
    "volunteer@example.org",
  );
});

test("passwordless two-factor enrollment and login cannot bypass the authenticator", async () => {
  const signedIn = await signIn();
  const initial = await auth.api.getSession({
    headers: new Headers({ cookie: signedIn.cookie }),
  });
  await saveProfile(bindings.DB, initial!.user.id, {
    ...answers,
    codeOfConductAccepted: true,
  });
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
  assert.equal(
    (
      await request(
        "/email-otp/request-email-change",
        { newEmail: "factor-new@example.org" },
        currentCookie,
      )
    ).status,
    200,
  );
  const emailChange = outbox.at(-1)!;
  await bindings.DB.prepare(
    "UPDATE session SET two_factor_verified=0 WHERE id=?",
  )
    .bind(current!.session.id)
    .run();
  assert.equal(
    (
      await request(
        "/email-otp/change-email",
        { newEmail: emailChange.email, otp: emailChange.code },
        currentCookie,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await request(
        "/email-otp/request-email-change",
        { newEmail: "factor-other@example.org" },
        currentCookie,
      )
    ).status,
    403,
  );
  await bindings.DB.prepare(
    "UPDATE session SET two_factor_verified=1 WHERE id=?",
  )
    .bind(current!.session.id)
    .run();
  assert.equal(
    (
      await request(
        "/email-otp/change-email",
        { newEmail: emailChange.email, otp: emailChange.code },
        currentCookie,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await auth.api.getSession({
        headers: new Headers({ cookie: currentCookie }),
      })
    )?.user.twoFactorEnabled,
    true,
  );
  await request("/sign-out", {}, currentCookie);
  const proof = await createSignInOTP(
    bindings.DB,
    bindings.BETTER_AUTH_SECRET!,
    "factor-new@example.org",
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

test("email-change messages contain a verification code rather than a sign-in link", async () => {
  await sendSignInEmail(
    "test-only-key",
    {
      email: "new@example.org",
      code: "123456",
      url: `${origin}/volunteer/account`,
      id: "email-change",
      purpose: "change-email",
    },
    "production",
    async (_url, options) => {
      const body = JSON.parse(String(options?.body));
      assert.equal(
        body.subject,
        "Confirm your After Hours Outreach email change",
      );
      assert.match(body.text, /account settings.*123456/);
      assert.doesNotMatch(body.text, /Sign in:|sign-in\/complete/);
      return Response.json({ id: "email-id" });
    },
  );
});

test("local email delivery never calls Resend, even with a configured key", async () => {
  const email = {
    email: "local@example.org",
    code: "123456",
    url: "http://localhost:4321/volunteer/sign-in/complete#email=local%40example.org&otp=123456",
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
    "/api/v1/auth/get-session",
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
