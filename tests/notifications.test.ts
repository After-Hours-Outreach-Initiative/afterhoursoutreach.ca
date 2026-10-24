import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { env } from "cloudflare:workers";
import type { AuthBindings } from "../src/server/auth";
import { queueNotification } from "../src/server/db/notifications";
import { hashAuthValue, takeEmailBudget } from "../src/server/db/rate-limits";
import { emailPolicy } from "../src/server/db/policy";
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
const accepted: typeof fetch = async (_url, init) =>
  Response.json({
    data: JSON.parse(String(init?.body)).map((_: unknown, index: number) => ({
      id: `accepted-${index}`,
    })),
  });
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

test("a successful batch sends more than five private messages in one bounded provider request", async () => {
  const { operation } = await queued(12);
  const provider = vi.fn<typeof fetch>(async (url, init) => {
    assert.equal(url, "https://api.resend.com/emails/batch");
    const payload = JSON.parse(String(init?.body));
    assert.equal(payload.length, 12);
    for (const email of payload) {
      assert.equal(
        email.from,
        "After Hours Outreach <info@afterhoursoutreach.ca>",
      );
      assert.equal(email.to.length, 1);
      assert.equal(email.cc, undefined);
      assert.equal(email.bcc, undefined);
    }
    assert.ok(init?.signal);
    return accepted(url, init);
  });
  const timeout = vi.spyOn(AbortSignal, "timeout");
  const result = await deliverNotifications(bindings(), operation, provider);
  assert.equal(result.sent, 12);
  assert.equal(result.pending, 0);
  assert.equal(provider.mock.calls.length, 1);
  assert.equal(timeout.mock.calls[0][0], 10_000);
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
  assert.equal(provider.mock.calls.length, 1);
});

test("quota sends the available emails, counts messages rather than calls, and never drains unrelated pending mail", async () => {
  const { operation } = await queued(12);
  const old = await queued(2);
  await takeEmailBudget(env.DB, env.BETTER_AUTH_SECRET, 75);
  const provider = vi.fn(accepted);
  const result = await deliverNotifications(bindings(), operation, provider);
  assert.equal(result.sent, 5);
  assert.equal(result.pending, 7);
  assert.equal(result.limited, true);
  assert.match(notificationNotice(result), /7 emails could not be sent/);
  assert.match(notificationNotice(result), /Retry email only/);
  assert.doesNotMatch(notificationNotice(result), /accepted|inbox delivery/);
  assert.equal(await budgetCount(), 80);
  assert.equal(provider.mock.calls.length, 1);
  assert.equal(
    await env.DB.prepare(
      "SELECT sum(attempts) FROM event_notification WHERE operation_id=?",
    )
      .bind(old.operation)
      .first<number>("sum(attempts)"),
    0,
  );
  // Idempotent retry never replays accepted mail, even if no quota remains.
  await deliverNotifications(bindings(), operation, provider);
  assert.equal(provider.mock.calls.length, 1);
  // Replenish only this scratch test counter, simulating the next budget window.
  await env.DB.prepare("UPDATE auth_rate_limit SET count=0").run();
  const retry = await deliverNotifications(bindings(), operation, provider);
  assert.equal(retry.sent, 12);
  assert.equal(retry.pending, 0);
  assert.equal(notificationNotice(retry), "");
  assert.equal(JSON.parse(String(provider.mock.calls[1][1]?.body)).length, 7);
  assert.equal(await budgetCount(), 7);
});

test("atomic reservations cannot overdraw the shared sign-in budget", async () => {
  await takeEmailBudget(env.DB, env.BETTER_AUTH_SECRET, 77);
  const results = await Promise.allSettled([
    takeEmailBudget(env.DB, env.BETTER_AUTH_SECRET, 2),
    takeEmailBudget(env.DB, env.BETTER_AUTH_SECRET, 2),
  ]);
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.equal(await budgetCount(), 79);
});

test("timeouts replay the exact frozen batch/key and recipients, without charging twice or repeating accepted messages", async () => {
  const { operation, userId } = await queued(8);
  const requests: { key: string | null; body: string }[] = [];
  const capture = (init?: RequestInit) =>
    requests.push({
      key: new Headers(init?.headers).get("Idempotency-Key"),
      body: String(init?.body),
    });
  const first = await deliverNotifications(
    bindings(),
    operation,
    async (_url, init) => {
      capture(init);
      throw new DOMException("Provider may have accepted this", "TimeoutError");
    },
  );
  assert.equal(first.unconfirmed, 8);
  assert.equal(first.failed, 0);
  assert.match(notificationNotice(first), /unconfirmed delivery/);
  // A later configuration/rejection/quota failure cannot turn an earlier
  // ambiguous acceptance into a claim that the email definitely was not sent.
  const unavailable = await deliverNotifications(
    { ...bindings(), RESEND_API_KEY: "" },
    operation,
    accepted,
  );
  assert.equal(unavailable.unconfirmed, 8);
  assert.equal(unavailable.failed, 0);
  await env.DB.prepare("UPDATE user SET email='changed@example.org' WHERE id=?")
    .bind(userId)
    .run();
  await env.DB.prepare(
    "UPDATE event_notification SET subject='mutated',body='mutated' WHERE operation_id=?",
  )
    .bind(operation)
    .run();
  const provider = vi.fn<typeof fetch>(async (url, init) => {
    capture(init);
    return accepted(url, init);
  });
  await Promise.all([
    deliverNotifications(
      { ...bindings(), AUTH_BASE_URL: "https://another-preview.example.org" },
      operation,
      provider,
    ),
    deliverNotifications(bindings(), operation, provider),
  ]);
  assert.equal(provider.mock.calls.length, 1);
  assert.deepEqual(requests[0], requests[1]);
  assert.equal(await budgetCount(), 8);
  await deliverNotifications(bindings(), operation, provider);
  assert.equal(provider.mock.calls.length, 1);
});

test("provider rejection, unknown acceptance and expiration are accurately distinguished", async () => {
  const { operation } = await queued(6);
  const rejected = await deliverNotifications(
    bindings(),
    operation,
    async () => new Response("private rejection reason", { status: 422 }),
  );
  assert.equal(rejected.failed, 6);
  assert.equal(rejected.unconfirmed, 0);
  assert.doesNotMatch(JSON.stringify(rejected), /private rejection reason/);
  const malformed = await deliverNotifications(
    bindings(),
    operation,
    async () => Response.json({ data: [{ id: "only-one" }] }),
  );
  assert.equal(malformed.unconfirmed, 6);
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
  const provider = vi.fn(accepted);
  const expired = await deliverNotifications(bindings(), operation, provider);
  assert.equal(expired.expired, 6);
  assert.equal(provider.mock.calls.length, 0);
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

test("a partial multi-batch failure retries only the unsuccessful batch; local simulation uses no quota", async () => {
  // Local simulation can exceed the hosted daily budget without touching it.
  const local = await queued(205);
  const blocked = vi.fn<typeof fetch>(async () => {
    throw new Error("Real email forbidden");
  });
  const simulated = await deliverNotifications(
    { ...bindings(), APP_ENV: "local" },
    local.operation,
    blocked,
  );
  assert.equal(simulated.sent, 205);
  assert.equal(simulated.simulated, 205);
  assert.equal(notificationNotice(simulated), "");
  assert.equal(blocked.mock.calls.length, 0);
  assert.equal(await budgetCount(), 0);
  const sizes = (
    await env.DB.prepare(
      "SELECT payload FROM event_notification_batch WHERE operation_id=?",
    )
      .bind(local.operation)
      .all<{ payload: string }>()
  ).results
    .map((row) => JSON.parse(row.payload).length)
    .sort((a, b) => a - b);
  assert.deepEqual(sizes, [5, 100, 100]);

  const { operation } = await queued(4);
  await takeEmailBudget(env.DB, env.BETTER_AUTH_SECRET, 78);
  const provider = vi.fn(accepted);
  await deliverNotifications(bindings(), operation, provider); // 2 accepted, 2 quota-blocked.
  await env.DB.prepare("UPDATE auth_rate_limit SET count=0").run();
  const rejected = await deliverNotifications(
    bindings(),
    operation,
    async () => new Response("", { status: 400 }),
  );
  assert.equal(rejected.sent, 2);
  assert.equal(rejected.failed, 2);
  const retry = await deliverNotifications(bindings(), operation, provider);
  assert.equal(retry.sent, 4);
  assert.equal(provider.mock.calls.length, 2);
  assert.notEqual(
    provider.mock.calls[0][1]?.body,
    provider.mock.calls[1][1]?.body,
  );
});

test("an email/storage failure never changes a successful mutation into a save failure", async () => {
  const { operation } = await queued(1);
  const result = await actionEmailResult(
    { ...bindings(), RESEND_API_KEY: "" },
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

test("legacy pending records are retained, never regrouped under new batch idempotency", async () => {
  const { operation } = await queued(1);
  await env.DB.prepare(
    "UPDATE event_notification SET delivery_to=NULL,attempts=1,delivery_origin=? WHERE operation_id=?",
  )
    .bind("https://original.example.org", operation)
    .run();
  const provider = vi.fn(accepted);
  const result = await deliverNotifications(bindings(), operation, provider);
  assert.equal(result.expired, 1);
  assert.equal(provider.mock.calls.length, 0);
});

test("an aborted provider request reports unconfirmed delivery and stops further requests", async () => {
  const { operation } = await queued(7);
  const controller = new AbortController();
  vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
  const provider = vi.fn<typeof fetch>(async (_url, init) => {
    assert.equal(init?.signal, controller.signal);
    controller.abort(new DOMException("Timed out", "TimeoutError"));
    throw controller.signal.reason;
  });
  const result = await deliverNotifications(bindings(), operation, provider);
  assert.equal(provider.mock.calls.length, 1);
  assert.equal(result.unconfirmed, 7);
  assert.equal(result.failed, 0);
  assert.match(notificationNotice(result), /unconfirmed delivery/);
});

test("an accepted request with a failed ledger write recovers using its original batch/key", async () => {
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
  const provider = vi.fn(accepted);
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
  assert.equal(result.sent, 3);
  assert.equal(provider.mock.calls.length, 2);
  assert.equal(
    provider.mock.calls[0][1]?.body,
    provider.mock.calls[1][1]?.body,
  );
  assert.equal(
    new Headers(provider.mock.calls[0][1]?.headers).get("Idempotency-Key"),
    new Headers(provider.mock.calls[1][1]?.headers).get("Idempotency-Key"),
  );
  assert.equal(await budgetCount(), 3);
});
