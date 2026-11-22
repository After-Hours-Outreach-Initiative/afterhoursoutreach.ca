import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { env } from "cloudflare:workers";
import type { AuthBindings } from "../src/server/auth";
import { queueNotification } from "../src/server/db/notifications";
import {
  emailBudgetRemaining,
  hashAuthValue,
  takeEmailBudget,
} from "../src/server/db/rate-limits";
import { emailPolicy } from "../src/server/db/policy";
import { emailError, emailSender } from "./helpers/email-sender";
import {
  actionEmailResult,
  deliverNotifications,
  notificationNotice,
} from "../src/server/events/notifications";

const bindings = (): AuthBindings => ({
  ...env,
  AUTH_BASE_URL: "https://afterhoursoutreach.ca",
  APP_ENV: "production",
});
afterEach(() => vi.restoreAllMocks());

async function queued(count: number) {
  const operation = crypto.randomUUID();
  const userId = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO user (id,name,email,email_verified,created_at,updated_at) VALUES (?,'Sample',?,1,0,0)",
  )
    .bind(userId, `${userId}@example.org`)
    .run();
  await env.DB.batch(
    Array.from({ length: count }, (_, index) =>
      queueNotification(
        env.DB,
        operation,
        userId,
        `Subject ${index}`,
        `Body ${index}`,
      ),
    ),
  );
  return { operation, userId };
}
async function budgetCount() {
  const start =
    Math.floor(Date.now() / emailPolicy.budgetWindowMs) *
    emailPolicy.budgetWindowMs;
  const key = await hashAuthValue(
    env.BETTER_AUTH_SECRET,
    `rate:send-total:${emailPolicy.budgetWindowMs}:${start}`,
  );
  return (
    (await env.DB.prepare("SELECT count FROM auth_rate_limit WHERE key=?")
      .bind(key)
      .first<number>("count")) ?? 0
  );
}
const { dailyLimit } = emailPolicy;
const unavailable = {
  EMAIL: undefined as unknown as SendEmail,
};

test("each private message is its own request and a repeat delivery sends nothing", async () => {
  const { operation } = await queued(12);
  const provider = emailSender((email) => {
    assert.deepEqual(email.from, {
      name: "After Hours Outreach",
      email: "info@afterhoursoutreach.ca",
    });
    assert.equal((email.to as string[]).length, 1);
    assert.equal(email.cc, undefined);
    assert.equal(email.bcc, undefined);
    assert.ok(String(email.html).includes("<h1"));
    assert.match(
      String(email.html),
      /href="https:\/\/afterhoursoutreach\.ca\/events"/,
    );
  });
  const result = await deliverNotifications(bindings(), operation, provider);
  assert.equal(result.sent, 12);
  assert.equal(result.pending, 0);
  assert.equal(provider.messages.length, 12);
  assert.equal(await budgetCount(), 12);
  assert.equal(notificationNotice(result), "");
  const feedback = await actionEmailResult(
    bindings(),
    { operation, message: "Event saved." },
    true,
  );
  assert.equal(feedback.message, "Event saved.");
  assert.equal(feedback.retryOperation, undefined);
  const empty = await actionEmailResult(
    bindings(),
    { operation: crypto.randomUUID(), message: "Event saved." },
    true,
  );
  assert.equal(empty.message, "Event saved.");
  await deliverNotifications(bindings(), operation, provider);
  assert.equal(provider.send.mock.calls.length, 12);
});

test("quota sends the available emails, counts messages, and never drains unrelated pending mail", async () => {
  const { operation } = await queued(12);
  const old = await queued(2);
  await takeEmailBudget(env.DB, env.BETTER_AUTH_SECRET, dailyLimit - 5);
  const provider = emailSender();
  const result = await deliverNotifications(bindings(), operation, provider);
  assert.equal(result.sent, 5);
  assert.equal(result.pending, 7);
  assert.equal(result.limited, true);
  assert.match(notificationNotice(result), /7 emails could not be sent/);
  assert.match(notificationNotice(result), /Retry email only/);
  assert.doesNotMatch(notificationNotice(result), /accepted|inbox delivery/);
  assert.equal(await budgetCount(), dailyLimit);
  assert.equal(provider.send.mock.calls.length, 5);
  assert.equal(
    await env.DB.prepare(
      "SELECT sum(attempts) FROM event_notification WHERE operation_id=?",
    )
      .bind(old.operation)
      .first<number>("sum(attempts)"),
    0,
  );
  await deliverNotifications(bindings(), operation, provider);
  assert.equal(provider.send.mock.calls.length, 5);
  // Replenish only this scratch test counter, simulating the next budget window.
  await env.DB.prepare("UPDATE auth_rate_limit SET count=0").run();
  const retry = await deliverNotifications(bindings(), operation, provider);
  assert.equal(retry.sent, 12);
  assert.equal(retry.pending, 0);
  assert.equal(notificationNotice(retry), "");
  assert.equal(provider.send.mock.calls.length, 12);
  assert.equal(await budgetCount(), 7);
});

test("atomic reservations cannot overdraw the shared sign-in budget", async () => {
  await takeEmailBudget(env.DB, env.BETTER_AUTH_SECRET, dailyLimit - 3);
  const results = await Promise.allSettled([
    takeEmailBudget(env.DB, env.BETTER_AUTH_SECRET, 2),
    takeEmailBudget(env.DB, env.BETTER_AUTH_SECRET, 2),
  ]);
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.equal(await budgetCount(), dailyLimit - 1);
});

test("the rolling cap counts the previous 31 days and ignores older ones", async () => {
  const { budgetWindowMs, rollingLimit, rollingWindows } = emailPolicy;
  const today = Math.floor(Date.now() / budgetWindowMs) * budgetWindowMs;
  const counter = async (daysAgo: number, count: number) =>
    env.DB.prepare(
      "INSERT INTO auth_rate_limit (key,count,expires_at) VALUES (?,?,?)",
    )
      .bind(
        await hashAuthValue(
          env.BETTER_AUTH_SECRET,
          `rate:send-total:${budgetWindowMs}:${today - daysAgo * budgetWindowMs}`,
        ),
        count,
        today + budgetWindowMs,
      )
      .run();
  await counter(rollingWindows, rollingLimit);
  await counter(rollingWindows - 1, rollingLimit - 2);
  assert.equal(await emailBudgetRemaining(env.DB, env.BETTER_AUTH_SECRET), 2);
  await takeEmailBudget(env.DB, env.BETTER_AUTH_SECRET, 2);
  await assert.rejects(
    takeEmailBudget(env.DB, env.BETTER_AUTH_SECRET),
    /Too many requests/,
  );
  assert.equal(await budgetCount(), 2);
});

test("an email that may have been sent is cancelled for that recipient only and never resent", async () => {
  const { operation, userId } = await queued(3);
  let calls = 0;
  const first = await deliverNotifications(
    bindings(),
    operation,
    emailSender(() => {
      if (++calls === 2) throw emailError("E_INTERNAL_SERVER_ERROR");
    }),
  );
  assert.equal(first.sent, 1);
  assert.equal(first.unconfirmed, 1);
  assert.equal(first.pending, 1);
  assert.doesNotMatch(JSON.stringify(first), /PRIVATE PROVIDER BODY/);
  assert.match(notificationNotice(first), /1 email could not be sent/);
  assert.match(
    notificationNotice(first),
    /1 email may not have arrived and will not be resent/,
  );
  // A later configuration failure cannot turn the unclear send into a retry.
  const later = await deliverNotifications(
    { ...bindings(), ...unavailable },
    operation,
  );
  assert.equal(later.unconfirmed, 1);
  assert.equal(later.unavailable, true);
  await env.DB.prepare("UPDATE user SET email='changed@example.org' WHERE id=?")
    .bind(userId)
    .run();
  const provider = emailSender();
  await Promise.all([
    deliverNotifications(
      { ...bindings(), AUTH_BASE_URL: "https://another-preview.example.org" },
      operation,
      provider,
    ),
    deliverNotifications(bindings(), operation, provider),
  ]);
  assert.equal(provider.send.mock.calls.length, 1);
  assert.deepEqual(provider.messages[0].to, [`${userId}@example.org`]);
  const done = await deliverNotifications(bindings(), operation, provider);
  assert.equal(provider.send.mock.calls.length, 1);
  assert.equal(done.sent, 2);
  assert.equal(done.unconfirmed, 1);
  assert.equal(done.pending, 0);
  assert.equal(await budgetCount(), 3);
});

test("provider rejection is retryable and expiration is reported separately", async () => {
  const { operation } = await queued(6);
  const rejected = await deliverNotifications(
    bindings(),
    operation,
    emailSender(() => {
      throw emailError("E_RECIPIENT_SUPPRESSED");
    }),
  );
  assert.equal(rejected.failed, 6);
  assert.equal(rejected.unconfirmed, 0);
  assert.doesNotMatch(JSON.stringify(rejected), /PRIVATE PROVIDER BODY/);
  await env.DB.prepare(
    "UPDATE event_notification SET created_at=? WHERE operation_id=?",
  )
    .bind(Date.now() - 24 * 3_600_000, operation)
    .run();
  await env.DB.prepare(
    "UPDATE event_notification_batch SET created_at=? WHERE operation_id=?",
  )
    .bind(Date.now() - 24 * 3_600_000, operation)
    .run();
  const provider = emailSender();
  const expired = await deliverNotifications(bindings(), operation, provider);
  assert.equal(expired.expired, 6);
  assert.equal(provider.send.mock.calls.length, 0);
  assert.match(notificationNotice(expired), /no longer safe to retry/);
  assert.equal(
    await env.DB.prepare(
      "SELECT count(*) FROM event_notification WHERE operation_id=?",
    )
      .bind(operation)
      .first<number>("count(*)"),
    6,
  );
});

test("a partial failure retries only the unsent emails; local simulation uses no quota", async () => {
  // Local simulation can exceed the hosted daily budget without touching it.
  const local = await queued(dailyLimit + 5);
  const blocked = emailSender();
  const simulated = await deliverNotifications(
    { ...bindings(), APP_ENV: "local" },
    local.operation,
    blocked,
  );
  assert.equal(simulated.sent, dailyLimit + 5);
  assert.equal(simulated.simulated, dailyLimit + 5);
  assert.equal(notificationNotice(simulated), "");
  assert.equal(blocked.send.mock.calls.length, 0);
  assert.equal(await budgetCount(), 0);

  const { operation } = await queued(4);
  await takeEmailBudget(env.DB, env.BETTER_AUTH_SECRET, dailyLimit - 2);
  const provider = emailSender();
  await deliverNotifications(bindings(), operation, provider); // 2 sent, 2 quota-blocked.
  await env.DB.prepare("UPDATE auth_rate_limit SET count=0").run();
  const rejected = await deliverNotifications(
    bindings(),
    operation,
    emailSender(() => {
      throw emailError("E_VALIDATION_ERROR");
    }),
  );
  assert.equal(rejected.sent, 2);
  assert.equal(rejected.failed, 2);
  const retry = await deliverNotifications(bindings(), operation, provider);
  assert.equal(retry.sent, 4);
  assert.equal(
    new Set(provider.messages.map((email) => email.subject)).size,
    4,
  );
});

test("an email/storage failure never changes a successful mutation into a save failure", async () => {
  const { operation } = await queued(1);
  const result = await actionEmailResult(
    { ...bindings(), ...unavailable },
    { operation, message: "Event saved." },
    true,
  );
  assert.match(result.message, /^Event saved\..*could not be sent/);
  assert.equal(result.retryOperation, operation);
  vi.spyOn(env.DB, "prepare").mockImplementationOnce(() => {
    throw new Error("Database unavailable");
  });
  const failure = await actionEmailResult(
    bindings(),
    { operation, message: "Volunteer access saved." },
    true,
  );
  assert.match(
    failure.message,
    /^Volunteer access saved\..*could not be confirmed/,
  );
  assert.equal(failure.retryOperation, operation);
});

test("legacy pending records are retained, never regrouped", async () => {
  const { operation } = await queued(1);
  await env.DB.prepare(
    "UPDATE event_notification SET delivery_to=NULL,attempts=1,delivery_origin=? WHERE operation_id=?",
  )
    .bind("https://original.example.org", operation)
    .run();
  const provider = emailSender();
  const result = await deliverNotifications(bindings(), operation, provider);
  assert.equal(result.expired, 1);
  assert.equal(provider.send.mock.calls.length, 0);
});

test("a send that times out is unconfirmed and stops further sends", async () => {
  const { operation } = await queued(4);
  const timeout = emailPolicy.timeoutMs;
  emailPolicy.timeoutMs = 50;
  try {
    const provider = emailSender(() => new Promise(() => {}));
    const result = await deliverNotifications(bindings(), operation, provider);
    assert.equal(provider.send.mock.calls.length, 1);
    assert.equal(result.unconfirmed, 1);
    assert.equal(result.pending, 3);
  } finally {
    emailPolicy.timeoutMs = timeout;
  }
});

test("an accepted email whose ledger write failed is never resent", async () => {
  const { operation } = await queued(3);
  const realBatch = env.DB.batch.bind(env.DB);
  let writes = 0;
  const fault = vi
    .spyOn(env.DB, "batch")
    .mockImplementation(async (statements) => {
      if (++writes === 2)
        throw new Error("Ledger unavailable after provider acceptance");
      return realBatch(statements);
    });
  const provider = emailSender();
  await assert.rejects(
    deliverNotifications(bindings(), operation, provider),
    /Ledger unavailable/,
  );
  fault.mockRestore();
  await env.DB.prepare(
    "UPDATE event_notification_batch SET lease_until=0 WHERE operation_id=?",
  )
    .bind(operation)
    .run();
  const result = await deliverNotifications(bindings(), operation, provider);
  assert.equal(result.sent, 2);
  assert.equal(result.unconfirmed, 1);
  assert.equal(provider.send.mock.calls.length, 3);
  assert.equal(await budgetCount(), 3);
});
