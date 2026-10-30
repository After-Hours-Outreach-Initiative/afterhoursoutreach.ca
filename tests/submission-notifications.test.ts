import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, test, vi } from "vitest";
import { createTestHarness } from "wrangler";
import type { AuthBindings } from "../src/server/auth";
import type { Actor } from "../src/server/db/access";
import { saveApplicationDraft } from "../src/server/db/application-drafts";
import { confirmNaloxoneCompletion } from "../src/server/db/naloxone";
import {
  loadProfile,
  loadSubmittedApplication,
  saveProfile,
} from "../src/server/db/profiles";
import { queueNotification } from "../src/server/db/notifications";
import { emailPolicy } from "../src/server/db/policy";
import { viewVolunteerProfile } from "../src/server/db/volunteers";
import { RequestError } from "../src/server/http";
import { hashAuthValue, takeEmailBudget } from "../src/server/db/rate-limits";
import {
  beginSubmissionNotificationAttempt,
  claimSubmissionNotification,
  finishSubmissionNotification,
  submissionNotificationMode,
  submissionNotificationRecipients,
  submissionNotificationStatements,
  submissionRetryWindowMs,
} from "../src/server/db/submission-notifications";
import {
  deliverSubmissionNotifications,
  runSubmissionNotificationJob,
} from "../src/server/submission-notifications";
import { sourceSchemaStatements } from "./helpers/source-schema";
import { deliverNotifications } from "../src/server/events/notifications";
import { processMedicCertificationNotifications } from "../src/server/medic-certifications";
import { addCalendarDays, vancouverInput } from "../src/data/event-time";

vi.stubEnv("DEV", false);
vi.stubEnv("PROD", true);

const harness = createTestHarness({
  workers: [
    {
      config: {
        name: "submission-notifications-test",
        compatibility_date: "2026-08-16",
        main: fileURLToPath(
          new URL("./helpers/submission-worker.mjs", import.meta.url),
        ),
        d1_databases: [
          {
            binding: "DB",
            database_name: "submission-notifications-test",
            database_id: "00000000-0000-0000-0000-000000000000",
            remote: false,
          },
        ],
      },
    },
  ],
});
let db: Env["DB"];
let actor: Actor;
const secret = "submission-notifications-test-secret-12345678901234567890";
const bindings = (APP_ENV = "production"): AuthBindings => ({
  DB: db,
  APP_ENV,
  AUTH_BASE_URL: "https://afterhoursoutreach.ca",
  BETTER_AUTH_SECRET: secret,
  RESEND_API_KEY: "test-only-key",
});
const answers = {
  firstName: "Sample",
  middleNames: "Middle",
  lastName: "Applicant",
  preferredName: "Sample Applicant",
  pronouns: "private pronouns",
  phone: "604-555-0100",
  birthDate: "1995-04-12",
  emergencyName: "Private contact",
  emergencyPhone: "604-555-0101",
  emergencyRelationship: "Private relationship",
  heardAboutUs: "Private referral",
  heardAboutUsSources: ["friend-word-of-mouth"],
  heardAboutUsOther: "",
  motivation: "Private motivation",
  teams: ["outreach"],
  certifications: [],
  certification: "",
  experience: "Private experience",
  training: ["none"],
  otherTraining: "",
  expiredFirstAidDetails: "",
  crisisInterventionDetails: "",
  relevantExperience: ["none"],
  otherExperience: "",
  certificationExpiry: "",
  medicalConditions: "Private health answer",
};
const submitForm = (input = answers) =>
  saveProfile(
    db,
    actor.id,
    { ...input, codeOfConductAccepted: true },
    {
      actor,
      intent: "submit",
    },
  );
const confirm = (config = bindings()) =>
  confirmNaloxoneCompletion(
    db,
    actor,
    { userId: actor.id, completed: true },
    { reviewStatements: submissionNotificationStatements(config) },
  );
const submit = async (config = bindings(), input = answers) => {
  const saved = await submitForm(input);
  const confirmed = await confirm(config);
  return { ...saved, operationId: confirmed.reviewOperationId };
};
interface Row {
  id: string;
  user_id: string;
  operation_id: string;
  recipient: string;
  payload: string | null;
  mode: string;
  status: string;
  outcome: string | null;
  first_attempt_at: number | null;
  next_attempt_at: number;
  attempts: number;
  budget_window: number | null;
  lease_token: string | null;
  lease_until: number | null;
}
const rows = async () =>
  (
    await db
      .prepare(
        "SELECT * FROM application_submission_notification ORDER BY recipient",
      )
      .all<Row>()
  ).results;
const count = (table: string) =>
  db.prepare(`SELECT count(*) AS n FROM ${table}`).first<number>("n");
async function budgetCount(now = Date.now()) {
  const start =
    Math.floor(now / emailPolicy.budgetWindowMs) * emailPolicy.budgetWindowMs;
  const key = await hashAuthValue(
    secret,
    `rate:send-total:${emailPolicy.budgetWindowMs}:${start}`,
  );
  return (
    (await db
      .prepare("SELECT count FROM auth_rate_limit WHERE key=?")
      .bind(key)
      .first<number>("count")) ?? 0
  );
}
const ready = () =>
  db
    .prepare(
      "UPDATE application_submission_notification SET next_attempt_at=0,lease_until=NULL WHERE status IN ('pending','sending')",
    )
    .run();
const accepted: typeof fetch = async () =>
  Response.json({ id: "accepted-provider-id" });

beforeAll(async () => {
  await harness.listen();
  db = (await harness.getWorker<Pick<Env, "DB">>().getEnv()).DB;
}, 60_000);
afterAll(async () => {
  await harness.close();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv("DEV", false);
  vi.stubEnv("PROD", true);
});
beforeEach(async () => {
  const triggers = (
    await db
      .prepare("SELECT name FROM sqlite_master WHERE type='trigger'")
      .all<{ name: string }>()
  ).results;
  const tables = (
    await db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
      )
      .all<{ name: string }>()
  ).results;
  if (triggers.length)
    await db.batch(
      triggers.map(({ name }) => db.prepare(`DROP TRIGGER "${name}"`)),
    );
  await db.batch([
    db.prepare("PRAGMA defer_foreign_keys=ON"),
    ...tables.map(({ name }) => db.prepare(`DROP TABLE "${name}"`)),
  ]);
  await db.batch(
    sourceSchemaStatements().map((statement) => db.prepare(statement)),
  );
  await db.batch([
    db.prepare(
      "INSERT INTO user (id,name,email,email_verified,created_at,updated_at) VALUES ('applicant','Original account name','private-applicant@example.org',1,0,0)",
    ),
    db
      .prepare(
        "INSERT INTO session (id,user_id,token,expires_at,created_at,updated_at) VALUES ('applicant-session','applicant','applicant-token',?,0,0)",
      )
      .bind(Date.now() + 86_400_000),
  ]);
  actor = {
    id: "applicant",
    name: "Original account name",
    role: "volunteer",
    sessionId: "applicant-session",
    twoFactorEnabled: false,
    twoFactorVerified: false,
    applicationSubmitted: false,
    applicationComplete: false,
    naloxoneCompleted: false,
    active: false,
    applicationApproved: false,
    patrolApproved: false,
  };
});

test("form submission is silent; only the winning review transition records three private fixed-mailbox intents", async () => {
  const network = vi.spyOn(globalThis, "fetch");
  await saveApplicationDraft(db, actor, {
    userId: actor.id,
    version: 1,
    revision: null,
    generation: null,
    answers: { firstName: "Unfinished draft" },
  });
  assert.equal(await count("application_submission_notification"), 0);
  const result = await Promise.all([
    submitForm({ ...answers, preferredName: "Winning name A" }),
    submitForm({ ...answers, preferredName: "Winning name B" }),
  ]);
  assert.equal(result.filter((saved) => saved.firstSubmitted).length, 1);
  assert.equal(await count("application_submission_notification"), 0);
  const provider = vi.fn(accepted);
  await deliverSubmissionNotifications(bindings(), {}, provider);
  assert.equal(provider.mock.calls.length, 0);
  const confirmations = await Promise.all([confirm(), confirm()]);
  assert.equal(confirmations.filter((row) => row.reviewOperationId).length, 1);
  const winner = confirmations.find((row) => row.reviewOperationId)!;
  assert.equal(confirmations[0].completedAt, confirmations[1].completedAt);
  const snapshot = (await loadSubmittedApplication(db, actor.id))!;
  const pending = await rows();
  assert.deepEqual(
    pending.map((row) => row.recipient).sort(),
    [...submissionNotificationRecipients].sort(),
  );
  assert.equal(await count("user"), 1); // No organizer mailbox has a site account.
  for (const row of pending) {
    assert.equal(row.operation_id, winner.reviewOperationId);
    assert.equal(row.mode, "production");
    assert.equal(row.status, "pending");
    assert.equal(row.first_attempt_at, null);
    const payload = JSON.parse(row.payload!);
    assert.deepEqual(Object.keys(payload).sort(), [
      "from",
      "subject",
      "text",
      "to",
    ]);
    assert.deepEqual(payload.to, [row.recipient]);
    assert.equal(payload.subject, "Volunteer application ready for review");
    assert.equal(
      payload.text,
      `Applicant: ${snapshot.answers.preferredName}\nSubmitted: ${snapshot.submittedAt}\nOrganizer review (authorized organizer sign-in required): https://afterhoursoutreach.ca/volunteers/applicant`,
    );
    assert.doesNotMatch(
      row.payload!,
      /Private|private-|1995|604-|motivation|birthDate|medical|emergency|teams/,
    );
  }
  assert.equal(network.mock.calls.length, 0); // No network inside the save hook.
  await submitForm(); // Lost-response retries must not write any effects.
  assert.equal((await confirm()).reviewOperationId, undefined);
  const baseline = (await loadProfile(db, actor.id))!;
  await saveProfile(
    db,
    actor.id,
    { ...baseline, phone: "604-555-0111", preferredName: "Edited name" },
    {
      actor,
      intent: "edit",
      baseline,
    },
  );
  assert.deepEqual(await rows(), pending);
  assert.equal(await count("application_draft"), 0);
  assert.equal(await count("event_notification"), 0);
  await assert.rejects(
    viewVolunteerProfile(db, actor, actor.id),
    (error: unknown) => error instanceof RequestError && error.status === 403,
  ); // The notification link grants no access to the applicant or other volunteers.
});

test("notification write failure rolls back course confirmation and its audit, leaving the submitted form intact", async () => {
  await submitForm();
  const snapshot = await loadSubmittedApplication(db, actor.id);
  const audits = await count("audit_log");
  await db
    .prepare(
      `CREATE TRIGGER fail_second_recipient BEFORE INSERT ON application_submission_notification
    WHEN NEW.recipient='info@afterhoursoutreach.ca' BEGIN SELECT RAISE(ABORT,'test outbox failure'); END`,
    )
    .run();
  await assert.rejects(confirm(), /test outbox failure/);
  assert.equal(await count("application_submission_notification"), 0);
  assert.equal(await count("audit_log"), audits);
  assert.deepEqual(await loadSubmittedApplication(db, actor.id), snapshot);
  assert.equal(
    await db
      .prepare("SELECT naloxone_completed_at FROM profile")
      .first("naloxone_completed_at"),
    null,
  );
  await db.prepare("DROP TRIGGER fail_second_recipient").run();
  assert.ok((await confirm()).reviewOperationId);
  assert.equal(await count("application_submission_notification"), 3);
});

test("guard losers, invalid consent, discarded drafts, and stale sessions cannot queue notifications", async () => {
  await assert.rejects(confirm()); // Course completion cannot precede the form.
  await assert.rejects(
    saveProfile(db, actor.id, answers, {
      actor,
      intent: "submit",
    }),
  );
  await assert.rejects(
    saveProfile(
      db,
      actor.id,
      { ...answers, codeOfConductAccepted: true },
      {
        actor,
        intent: "submit",
        draft: { revision: crypto.randomUUID(), generation: null },
      },
    ),
  );
  assert.equal(await count("profile"), 0);
  await submitForm();
  await db.prepare("DELETE FROM session").run();
  await assert.rejects(confirm());
  assert.equal(await count("application_submission_notification"), 0);
});

test("frozen metadata comes from the stored submission, not mutable account/profile values at review time", async () => {
  await submitForm({ ...answers, preferredName: "" });
  await db
    .prepare("UPDATE user SET name='Changed',email='changed@example.org'")
    .run();
  await db.prepare("UPDATE profile SET preferred_name='Changed'").run();
  await confirm();
  const original = await rows();
  assert.match(original[0].payload!, /Applicant: Sample Middle Applicant/);
  await confirm();
  assert.deepEqual(await rows(), original);
  for (const assignment of [
    "payload='changed'",
    "recipient='other@example.org'",
    "mode='local'",
    "operation_id='another'",
    "user_id='other'",
  ])
    await assert.rejects(
      db
        .prepare(`UPDATE application_submission_notification SET ${assignment}`)
        .run(),
      /application_submission_notification_immutable/,
    );
});

test("legacy initial-form intents are suppressed, never backfilled or replaced at review entry", async () => {
  const saved = await submitForm();
  for (const [index, recipient] of submissionNotificationRecipients.entries()) {
    await db
      .prepare(
        `INSERT INTO application_submission_notification
        (id,operation_id,user_id,recipient,mode,payload,status,next_attempt_at,created_at)
        VALUES (?,?,?,?,'production','{}',?,0,0)`,
      )
      .bind(
        `legacy-${index}`,
        saved.operationId,
        actor.id,
        recipient,
        ["pending", "sending", "sent"][index],
      )
      .run();
  }
  const provider = vi.fn(accepted);
  // Even direct claims cannot revive old initial-form mail.
  assert.equal(
    await claimSubmissionNotification(
      db,
      "legacy-0",
      "production",
      "owner",
      Date.now(),
    ),
    null,
  );
  await deliverSubmissionNotifications(bindings(), {}, provider);
  const legacy = await rows();
  assert.equal(legacy.filter((row) => row.status === "suppressed").length, 2);
  assert.equal(legacy.filter((row) => row.status === "sent").length, 1);
  await confirm();
  await confirm();
  await deliverSubmissionNotifications(bindings(), {}, provider);
  assert.deepEqual(await rows(), legacy);
  // Already-completed legacy applicants without any ledger are not backfilled.
  await db.prepare("DELETE FROM application_submission_notification").run();
  assert.equal((await confirm()).reviewOperationId, undefined);
  assert.deepEqual(await rows(), []);
  assert.equal(provider.mock.calls.length, 0);
  assert.equal(await budgetCount(), 0);
});

test("production acceptance is per-recipient, bounded, duplicate-safe under concurrent drains, and shares quota", async () => {
  const saved = await submit();
  await db.batch([
    queueNotification(
      db,
      "event-consent-only",
      actor.id,
      "Unrelated event",
      "Do not send",
    ),
  ]);
  const provider = vi.fn<typeof fetch>(async (url, init) => {
    assert.equal(url, "https://api.resend.com/emails");
    assert.equal(init?.method, "POST");
    assert.equal(
      JSON.parse(String(init?.body)).from,
      "After Hours Outreach <info@afterhoursoutreach.ca>",
    );
    assert.equal(
      new Headers(init?.headers).get("User-Agent"),
      "afterhoursoutreach.ca/1.0",
    );
    assert.match(
      new Headers(init?.headers).get("Idempotency-Key")!,
      /^application-submission\//,
    );
    assert.ok(init?.signal);
    return accepted(url, init);
  });
  await Promise.all([
    deliverSubmissionNotifications(
      bindings(),
      { operationId: saved.operationId },
      provider,
    ),
    deliverSubmissionNotifications(
      bindings(),
      { operationId: saved.operationId },
      provider,
    ),
  ]);
  assert.equal(provider.mock.calls.length, 3);
  assert.equal(
    new Set(
      provider.mock.calls.map(([, init]) =>
        new Headers(init?.headers).get("Idempotency-Key"),
      ),
    ).size,
    3,
  );
  assert.equal(await budgetCount(), 3);
  assert.deepEqual(
    (await rows()).map((row) => row.status),
    ["sent", "sent", "sent"],
  );
  assert.equal(
    await db
      .prepare("SELECT attempts FROM event_notification")
      .first("attempts"),
    0,
  );
  await deliverSubmissionNotifications(bindings(), {}, provider);
  assert.equal(provider.mock.calls.length, 3);
});

test("partial recipient failures replay only unfinished frozen requests/keys, without same-day quota charges", async () => {
  await submit();
  const original = await rows();
  const failedIds = new Set(original.slice(1).map((row) => row.id));
  const initial = vi.fn<typeof fetch>(async (_url, init) => {
    const id = new Headers(init?.headers).get("Idempotency-Key")!.split("/")[1];
    if (id === original[1].id)
      throw new Error("private provider timeout with private address");
    if (id === original[2].id)
      return new Response("Private provider failure", { status: 503 });
    return Response.json({ id: "accepted" });
  });
  const result = await deliverSubmissionNotifications(bindings(), {}, initial);
  assert.equal("sent" in result && result.sent, 1);
  assert.equal("failed" in result && result.failed, 2);
  assert.equal(await budgetCount(), 3);
  assert.deepEqual(
    (await rows()).map((row) => row.status),
    ["sent", "pending", "pending"],
  );
  assert.deepEqual(
    (await rows()).map((row) => row.outcome),
    [null, "unconfirmed", "unconfirmed"],
  );
  const noEarly = vi.fn(accepted);
  await deliverSubmissionNotifications(bindings(), {}, noEarly);
  assert.equal(noEarly.mock.calls.length, 0); // Backoff is durable, not a tight loop.
  await ready();
  const retry = vi.fn(accepted);
  await deliverSubmissionNotifications(
    { ...bindings(), AUTH_BASE_URL: "https://changed.example.org" },
    {},
    retry,
  );
  assert.equal(retry.mock.calls.length, 2);
  for (const [, init] of retry.mock.calls) {
    const key = new Headers(init?.headers).get("Idempotency-Key")!;
    assert.ok(failedIds.has(key.split("/")[1]));
    const first = initial.mock.calls.find(
      ([, sent]) => new Headers(sent?.headers).get("Idempotency-Key") === key,
    )!;
    assert.equal(init?.body, first[1]?.body);
  }
  assert.equal(await budgetCount(), 3);
  assert.deepEqual(
    (await rows()).map((row) => row.status),
    ["sent", "sent", "sent"],
  );
});

test("accepted mail with a failed ledger write recovers through the same leased request and stale workers cannot finish it", async () => {
  await submit();
  const provider = vi.fn(accepted);
  await db
    .prepare(
      `CREATE TRIGGER reject_sent_ledger BEFORE UPDATE OF status ON application_submission_notification
    WHEN NEW.status='sent' BEGIN SELECT RAISE(ABORT,'private ledger failure'); END`,
    )
    .run();
  await assert.rejects(
    deliverSubmissionNotifications(bindings(), { limit: 1 }, provider),
    /private ledger failure/,
  );
  await db.prepare("DROP TRIGGER reject_sent_ledger").run();
  const leased = (await rows()).find((row) => row.status === "sending")!;
  assert.ok(leased.first_attempt_at);
  await deliverSubmissionNotifications(bindings(), { limit: 3 }, provider);
  assert.equal(provider.mock.calls.length, 3); // Other two recipients may proceed, not the live lease.
  await ready();
  const claimed = await claimSubmissionNotification(
    db,
    leased.id,
    "production",
    "new-owner",
    Date.now(),
  );
  assert.ok(claimed);
  await finishSubmissionNotification(
    db,
    leased.id,
    leased.lease_token!,
    "sent",
    Date.now(),
    0,
  );
  assert.equal(
    (await rows()).find((row) => row.id === leased.id)!.lease_token,
    "new-owner",
  );
  await finishSubmissionNotification(
    db,
    leased.id,
    "new-owner",
    "unconfirmed",
    Date.now(),
    0,
  );
  await deliverSubmissionNotifications(bindings(), {}, provider);
  assert.equal(provider.mock.calls.length, 4);
  assert.equal(
    provider.mock.calls[0][1]?.body,
    provider.mock.calls[3][1]?.body,
  );
  assert.equal(
    new Headers(provider.mock.calls[0][1]?.headers).get("Idempotency-Key"),
    new Headers(provider.mock.calls[3][1]?.headers).get("Idempotency-Key"),
  );
  assert.equal(await budgetCount(), 3);
});

test("exhausted shared budget preserves unattempted intents, and concurrent reservations never overdraw", async () => {
  await submit();
  await takeEmailBudget(db, secret, emailPolicy.dailyLimit);
  const provider = vi.fn(accepted);
  const result = await deliverSubmissionNotifications(bindings(), {}, provider);
  assert.equal("limited" in result && result.limited, true);
  assert.equal(provider.mock.calls.length, 0);
  for (const row of await rows()) {
    assert.equal(row.first_attempt_at, null);
    assert.equal(row.attempts, 0);
    assert.equal(row.budget_window, null);
  }
  assert.equal(await budgetCount(), 80);
  // Scratch counter only: leave one daily email available, then race claims.
  await db.prepare("UPDATE auth_rate_limit SET count=79").run();
  await ready();
  await Promise.all([
    deliverSubmissionNotifications(bindings(), {}, provider),
    deliverSubmissionNotifications(bindings(), {}, provider),
  ]);
  assert.equal(provider.mock.calls.length, 1);
  assert.equal(await budgetCount(), 80);
  assert.equal((await rows()).filter((row) => row.status === "sent").length, 1);
});

test("submission, event and medic delivery race within the same 80-email budget; a Preview build cannot run medic delivery", async () => {
  await submit();
  await db.batch([
    queueNotification(
      db,
      "shared-budget-event",
      actor.id,
      "Sample event",
      "Sample message",
    ),
    db
      .prepare(
        'UPDATE profile SET teams=\'["outreach","medic"]\',medical_certifications=\'["advanced-first-aid"]\',medical_certification_expiry=? WHERE user_id=?',
      )
      .bind(
        addCalendarDays(vancouverInput(Date.now()).slice(0, 10), 1),
        actor.id,
      ),
  ]);
  await takeEmailBudget(db, secret, 78);
  let emails = 0;
  const provider: typeof fetch = async (_url, init) => {
    const payload = JSON.parse(String(init?.body));
    emails += Array.isArray(payload) ? payload.length : 1;
    return Array.isArray(payload)
      ? Response.json({ data: payload.map(() => ({ id: "accepted" })) })
      : Response.json({ id: "accepted" });
  };
  await Promise.all([
    deliverSubmissionNotifications(bindings(), {}, provider),
    deliverNotifications(bindings(), "shared-budget-event", provider),
    processMedicCertificationNotifications(bindings(), true, provider),
  ]);
  assert.equal(await budgetCount(), 80);
  assert.equal(emails, 2);
  vi.stubEnv("MODE", "preview");
  assert.deepEqual(
    await processMedicCertificationNotifications(bindings(), true, provider),
    { skipped: true },
  );
  assert.equal(emails, 2);
});

test("budget reservation and outbox mark are one D1 transaction; rollover reserves again but retains key/clock", async () => {
  await submit();
  const row = (await rows())[0];
  const day = emailPolicy.budgetWindowMs;
  const now = Math.floor(Date.now() / day) * day + day - 3_600_000;
  await ready(); // The fixed rollover clock can precede the real current hour.
  assert.ok(
    await claimSubmissionNotification(db, row.id, "production", "owner", now),
  );
  await db
    .prepare(
      `CREATE TRIGGER reject_budget_mark BEFORE UPDATE OF budget_window ON application_submission_notification
    BEGIN SELECT RAISE(ABORT,'test budget failure'); END`,
    )
    .run();
  await assert.rejects(
    beginSubmissionNotificationAttempt(bindings(), row.id, "owner", now),
    /test budget failure/,
  );
  assert.equal(await budgetCount(now), 0);
  assert.equal((await rows())[0].first_attempt_at, null);
  await db.prepare("DROP TRIGGER reject_budget_mark").run();
  const first = (await beginSubmissionNotificationAttempt(
    bindings(),
    row.id,
    "owner",
    now,
  ))!;
  assert.equal(first.attempts, 1);
  assert.equal(await budgetCount(now), 1);
  await finishSubmissionNotification(
    db,
    row.id,
    "owner",
    "unconfirmed",
    now,
    now,
  );
  const tomorrow = now + 2 * 3_600_000;
  assert.ok(
    await claimSubmissionNotification(
      db,
      row.id,
      "production",
      "tomorrow",
      tomorrow,
    ),
  );
  const replay = (await beginSubmissionNotificationAttempt(
    bindings(),
    row.id,
    "tomorrow",
    tomorrow,
  ))!;
  assert.equal(await budgetCount(tomorrow), 1);
  assert.equal(replay.id, first.id);
  assert.equal(replay.payload, first.payload);
  assert.equal(replay.first_attempt_at, now);
});

test("ambiguous attempts expire before Resend's key lifetime; unattempted old mail stays deliverable", async () => {
  await submit();
  const original = await rows();
  const old = Date.now() - submissionRetryWindowMs - 1;
  await db
    .prepare(
      "UPDATE application_submission_notification SET first_attempt_at=?,attempts=1,outcome='unconfirmed' WHERE id=?",
    )
    .bind(old, original[0].id)
    .run();
  const provider = vi.fn(accepted);
  await deliverSubmissionNotifications(bindings(), {}, provider);
  assert.equal(provider.mock.calls.length, 2);
  assert.equal((await rows())[0].status, "expired");
  await ready();
  await deliverSubmissionNotifications(bindings(), {}, provider);
  assert.equal(provider.mock.calls.length, 2); // Never mint a new key, even the next day.
});

test("provider 429 honors Retry-After and stops this run; 409 and 5xx remain unconfirmed", async () => {
  await submit();
  const provider = vi.fn<typeof fetch>(
    async () =>
      new Response("Private error", {
        status: 429,
        headers: { "Retry-After": "7200" },
      }),
  );
  const now = Date.now();
  await deliverSubmissionNotifications(bindings(), {}, provider);
  assert.equal(provider.mock.calls.length, 1);
  const attempted = (await rows()).find((row) => row.attempts)!;
  assert.equal(attempted.outcome, "failed");
  assert.ok(attempted.next_attempt_at >= now + 7_200_000);
  await ready();
  await deliverSubmissionNotifications(
    bindings(),
    {},
    async () => new Response("private conflict", { status: 409 }),
  );
  assert.ok((await rows()).every((row) => row.outcome === "unconfirmed"));
  await ready();
  await deliverSubmissionNotifications(
    bindings(),
    {},
    async () => new Response("private rejection", { status: 422 }),
  );
  assert.ok((await rows()).every((row) => row.outcome === "unconfirmed"));
});

test("local simulation is durable and quota-free, with no production outbox consumption", async () => {
  await submit(bindings("local"));
  const provider = vi.fn(accepted);
  const simulated = await deliverSubmissionNotifications(
    bindings("local"),
    {},
    provider,
  );
  assert.equal("simulated" in simulated && simulated.simulated, 3);
  assert.equal(provider.mock.calls.length, 0);
  assert.equal(await budgetCount(), 0);
  assert.ok((await rows()).every((row) => row.status === "local"));
  await deliverSubmissionNotifications(bindings(), {}, provider);
  assert.equal(provider.mock.calls.length, 0);
});

test("preview runtime/build gates suppress real organizer mail, even with production keys/bindings or shared DB", async () => {
  const provider = vi.fn(accepted);
  await submit(bindings("preview"));
  assert.ok(
    (await rows()).every(
      (row) =>
        row.mode === "preview" &&
        row.status === "suppressed" &&
        row.payload === null,
    ),
  );
  await deliverSubmissionNotifications(bindings("preview"), {}, provider);
  await deliverSubmissionNotifications(bindings(), {}, provider);
  assert.equal(provider.mock.calls.length, 0);
  vi.stubEnv("MODE", "preview");
  assert.equal(submissionNotificationMode(bindings()), "preview");
  await deliverSubmissionNotifications(bindings(), {}, provider);
  assert.equal(provider.mock.calls.length, 0);
  vi.stubEnv("MODE", "production");
  vi.stubEnv("DEV", true);
  assert.equal(submissionNotificationMode(bindings()), "local");
  vi.stubEnv("DEV", false);
  assert.equal(submissionNotificationMode(bindings("unrecognized")), "preview");
  assert.equal(await budgetCount(), 0);
});

test("preview and local drains never consume an existing production intent; missing secrets do not start attempts", async () => {
  await submit();
  const provider = vi.fn(accepted);
  await deliverSubmissionNotifications(bindings("preview"), {}, provider);
  await deliverSubmissionNotifications(bindings("local"), {}, provider);
  await deliverSubmissionNotifications(
    { ...bindings(), RESEND_API_KEY: "" },
    {},
    provider,
  );
  await deliverSubmissionNotifications(
    { ...bindings(), BETTER_AUTH_SECRET: "" },
    {},
    provider,
  );
  vi.stubEnv("MODE", "preview");
  await deliverSubmissionNotifications(bindings(), {}, provider);
  assert.equal(provider.mock.calls.length, 0);
  assert.ok(
    (await rows()).every(
      (row) => row.status === "pending" && row.first_attempt_at === null,
    ),
  );
  assert.equal(await budgetCount(), 0);
});

test("a preview build suppresses intent creation even with production bindings", async () => {
  vi.stubEnv("MODE", "preview");
  await submit(bindings());
  assert.ok(
    (await rows()).every(
      (row) =>
        row.mode === "preview" &&
        row.status === "suppressed" &&
        row.payload === null,
    ),
  );
  // A later production build against that same database cannot promote them.
  vi.stubEnv("MODE", "production");
  const provider = vi.fn(accepted);
  await deliverSubmissionNotifications(bindings(), {}, provider);
  assert.equal(provider.mock.calls.length, 0);
});

test("development simulates despite production binding defaults and never spends quota", async () => {
  vi.stubEnv("DEV", true);
  await submit(bindings());
  const provider = vi.fn(accepted);
  await deliverSubmissionNotifications(bindings(), {}, provider);
  assert.ok(
    (await rows()).every(
      (row) => row.mode === "local" && row.status === "local",
    ),
  );
  assert.equal(provider.mock.calls.length, 0);
  assert.equal(await budgetCount(), 0);
});

test("unattempted intents remain deliverable days after submission and start their retry clock only on sending", async () => {
  const realNow = Date.now();
  const clock = vi
    .spyOn(Date, "now")
    .mockReturnValue(realNow - 3 * emailPolicy.budgetWindowMs);
  await submit();
  clock.mockRestore();
  const provider = vi.fn(accepted);
  await deliverSubmissionNotifications(bindings(), {}, provider);
  assert.equal(provider.mock.calls.length, 3);
  assert.ok(
    (await rows()).every(
      (row) => row.status === "sent" && row.first_attempt_at! >= realNow,
    ),
  );
});

test("catch-safe automatic jobs log aggregate categories only and cannot undo a successful submission", async () => {
  const saved = await submit();
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const unavailable = new Proxy(db, {
    get(target, property) {
      if (property === "prepare")
        return () => {
          throw new Error(
            "private-applicant@example.org Private health answer",
          );
        };
      return Reflect.get(target, property);
    },
  });
  const result = await runSubmissionNotificationJob({
    ...bindings(),
    DB: unavailable,
  });
  assert.deepEqual(result, { failed: 1 });
  assert.deepEqual(log.mock.calls, [
    [
      JSON.stringify({
        event: "application_submission_notifications",
        error: "delivery_or_storage_unavailable",
      }),
    ],
  ]);
  assert.equal(saved.firstSubmitted, true);
  assert.ok(await loadSubmittedApplication(db, actor.id));
  assert.equal(await count("application_submission_notification"), 3);
});
