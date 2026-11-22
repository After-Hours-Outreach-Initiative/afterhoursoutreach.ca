import { RequestError } from "../http";
import { emailPolicy } from "./policy";

// Persistent counters are shared across requests and Worker instances.

export async function hashAuthValue(secret: string | undefined, value: string) {
  if (!secret) throw new RequestError(503, "Sign-in is not configured yet.");
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const bytes = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(value)),
  );
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

/** Each counter update is atomic across requests and Worker instances. */
export async function takeRateLimit(
  binding: Env["DB"],
  secret: string | undefined,
  subject: string,
  limit: number,
  windowMs: number,
  now = Date.now(),
) {
  const start = Math.floor(now / windowMs) * windowMs;
  const key = await hashAuthValue(
    secret,
    `rate:${subject}:${windowMs}:${start}`,
  );
  const row = await binding
    .prepare(
      `INSERT INTO auth_rate_limit (key, count, expires_at) VALUES (?, 1, ?)
       ON CONFLICT (key) DO UPDATE SET count = count + 1 WHERE count < ?
       RETURNING count`,
    )
    .bind(key, start + windowMs, limit)
    .first();
  if (!row) throw new RequestError(429, "Too many requests. Try again later.");
}

export async function limitEmailRequests(
  binding: Env["DB"],
  secret: string | undefined,
  email: string,
  ip: string,
  cooldownMs = 60_000,
  consumeProviderBudget = true,
) {
  // Internal policy only: callers cannot supply a cooldown through the auth API.
  if (cooldownMs !== 30_000 && cooldownMs !== 60_000)
    throw new RangeError("Email request cooldown must be 30 or 60 seconds.");
  // IP first: rotating recipient addresses must not bypass the sending budget.
  await takeRateLimit(binding, secret, `send-ip:${ip}`, 10, 3_600_000);
  const cooldownKey = await hashAuthValue(secret, `send-cooldown:${email}`);
  const now = Date.now();
  const cooldown = await binding
    .prepare(
      `INSERT INTO auth_rate_limit (key, count, expires_at) VALUES (?, 1, ?)
     ON CONFLICT (key) DO UPDATE SET count = 1, expires_at = excluded.expires_at
     WHERE expires_at <= ? RETURNING count`,
    )
    .bind(cooldownKey, now + cooldownMs, now)
    .first();
  if (!cooldown)
    throw new RequestError(
      429,
      cooldownMs === 30_000
        ? "Wait 30 seconds before requesting another email."
        : "Wait one minute before requesting another email.",
    );
  await takeRateLimit(binding, secret, `send-email:${email}`, 10, 3_600_000);
  if (consumeProviderBudget) await takeEmailBudget(binding, secret);
}

/** Today's counter key plus the keys of every window in the rolling cap. */
export async function emailBudgetKeys(secret: string | undefined, now: number) {
  const { budgetWindowMs, rollingWindows } = emailPolicy;
  const start = Math.floor(now / budgetWindowMs) * budgetWindowMs;
  const keys = await Promise.all(
    Array.from({ length: rollingWindows }, (_, index) =>
      hashAuthValue(
        secret,
        `rate:send-total:${budgetWindowMs}:${start - index * budgetWindowMs}`,
      ),
    ),
  );
  return {
    start,
    key: keys[0],
    recent: JSON.stringify(keys),
    // Daily counters must outlive the rolling window that sums them.
    expiresAt: start + rollingWindows * budgetWindowMs,
  };
}

/**
 * Atomically reserve `count` emails when `guard` holds and both the daily and
 * rolling caps allow it. Binds: key, count, expiresAt, ...guardBindings,
 * count, recent, rollingLimit, dailyLimit.
 */
export function emailBudgetSql(guard = "1") {
  return `INSERT INTO auth_rate_limit (key, count, expires_at)
    SELECT ?, ?, ? WHERE ${guard} AND ? + coalesce((SELECT sum(count) FROM auth_rate_limit
      WHERE key IN (SELECT value FROM json_each(?))), 0) <= ?
    ON CONFLICT (key) DO UPDATE SET count = count + excluded.count
      WHERE count + excluded.count <= ?`;
}

export async function emailBudgetRemaining(
  binding: Env["DB"],
  secret: string | undefined,
) {
  const { key, recent } = await emailBudgetKeys(secret, Date.now());
  const row = await binding
    .prepare(
      `SELECT coalesce((SELECT count FROM auth_rate_limit WHERE key = ?), 0) AS today,
        coalesce((SELECT sum(count) FROM auth_rate_limit
          WHERE key IN (SELECT value FROM json_each(?))), 0) AS recent`,
    )
    .bind(key, recent)
    .first<{ today: number; recent: number }>();
  return Math.max(
    0,
    Math.min(
      emailPolicy.dailyLimit - (row?.today ?? 0),
      emailPolicy.rollingLimit - (row?.recent ?? 0),
    ),
  );
}

export async function takeEmailBudget(
  binding: Env["DB"],
  secret: string | undefined,
  count = 1,
) {
  if (!Number.isInteger(count) || count < 1 || count > emailPolicy.dailyLimit)
    throw new RangeError("Invalid email budget count.");
  const { start, key, recent, expiresAt } = await emailBudgetKeys(
    secret,
    Date.now(),
  );
  const result = await binding
    .prepare(emailBudgetSql())
    .bind(
      key,
      count,
      expiresAt,
      count,
      recent,
      emailPolicy.rollingLimit,
      emailPolicy.dailyLimit,
    )
    .run();
  if (!result.meta.changes)
    throw new RequestError(429, "Too many requests. Try again later.");
  return start;
}

export async function cleanupAuthRecords(binding: Env["DB"], now = Date.now()) {
  await binding.batch([
    binding
      .prepare(
        `DELETE FROM auth_rate_limit WHERE key IN
         (SELECT key FROM auth_rate_limit WHERE expires_at < ? LIMIT 100)`,
      )
      .bind(now),
    binding
      .prepare(
        `DELETE FROM verification WHERE id IN
         (SELECT id FROM verification WHERE expires_at < ? LIMIT 100)`,
      )
      .bind(now),
  ]);
}

export async function limitEmailVerification(
  binding: Env["DB"],
  secret: string | undefined,
  email: string,
  ip: string,
) {
  await takeRateLimit(binding, secret, `verify-ip:${ip}`, 30, 60_000);
  // This budget survives OTP rotation, consumption, and resends.
  await takeRateLimit(binding, secret, `verify-email:${email}`, 10, 3_600_000);
}
