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
) {
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
    .bind(cooldownKey, now + 60_000, now)
    .first();
  if (!cooldown)
    throw new RequestError(
      429,
      "Wait one minute before requesting another email.",
    );
  await takeRateLimit(binding, secret, `send-email:${email}`, 3, 3_600_000);
  await takeEmailBudget(binding, secret);
}

export function takeEmailBudget(
  binding: Env["DB"],
  secret: string | undefined,
) {
  return takeRateLimit(
    binding,
    secret,
    "send-total",
    emailPolicy.dailyLimit,
    emailPolicy.budgetWindowMs,
  );
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
