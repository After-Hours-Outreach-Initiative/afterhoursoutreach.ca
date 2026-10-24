import {
  certificationOptions,
  legacyCertificationValues,
} from "../../data/application";
import { vancouverInput } from "../../data/event-time";
import { notificationRetryHours } from "./notifications";

export const medicWarningDays = 30;
export const medicExpiredCatchUpDays = 7;
const retryWindowMs = notificationRetryHours * 3_600_000;
const leaseMs = 60_000;

export function medicNotificationDates(now: number) {
  const today = vancouverInput(now).slice(0, 10);
  // Arithmetic on calendar dates, not Vancouver instants (days can be 23/25h).
  const addDays = (days: number) =>
    new Date(Date.parse(`${today}T00:00:00Z`) + days * 86_400_000)
      .toISOString()
      .slice(0, 10);
  return {
    today,
    warningThrough: addDays(medicWarningDays),
    expiredSince: addDays(-medicExpiredCatchUpDays),
  };
}

// Only trusted, source-defined enum values are interpolated into SQL.
const certifications = [
  ...certificationOptions.map(({ value }) => value),
  ...legacyCertificationValues,
]
  .map((value) => `'${value}'`)
  .join(",");
const teams = "CASE WHEN json_valid(p.teams) THEN p.teams ELSE '[]' END";
const certs =
  "CASE WHEN json_valid(p.medical_certifications) THEN p.medical_certifications ELSE '[]' END";
const eligibleProfile = `s.active = 1 AND u.email_verified = 1
  AND json_type(${teams}) = 'array'
  AND EXISTS (SELECT 1 FROM json_each(${teams}) WHERE value = 'medic')
  AND json_type(${certs}) = 'array'
  AND EXISTS (SELECT 1 FROM json_each(${certs}) WHERE type = 'text' AND value IN (${certifications}))
  AND p.medical_certification_expiry GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
  AND date(p.medical_certification_expiry, '+0 days') = p.medical_certification_expiry`;

/** No historical backfill: warn within 30 days; expired mail catches up seven days. */
export async function queueMedicCertificationNotifications(
  db: Env["DB"],
  now = Date.now(),
) {
  const { today, warningThrough, expiredSince } = medicNotificationDates(now);
  const results = await db.batch([
    ...(["warning", "expired"] as const).map((kind) =>
      db
        .prepare(
          `
      INSERT INTO medic_certification_notification (id, user_id, expiry, kind, created_at)
      SELECT lower(hex(randomblob(16))), p.user_id, p.medical_certification_expiry, ?, ?
      FROM profile p JOIN user u ON u.id = p.user_id JOIN volunteer_status s ON s.user_id = p.user_id
      WHERE ${eligibleProfile} AND p.medical_certification_expiry >= ?
        AND p.medical_certification_expiry ${kind === "warning" ? "<=" : "<"} ?
      ON CONFLICT(user_id, expiry, kind) DO NOTHING
    `,
        )
        .bind(
          kind,
          now,
          kind === "warning" ? today : expiredSince,
          kind === "warning" ? warningThrough : today,
        ),
    ),
  ]);
  return results.reduce((count, result) => count + result.meta.changes, 0);
}

const currentProfile = `EXISTS (
  SELECT 1 FROM profile p JOIN user u ON u.id = p.user_id JOIN volunteer_status s ON s.user_id = p.user_id
  WHERE p.user_id = n.user_id AND p.medical_certification_expiry = n.expiry AND ${eligibleProfile}
    AND (n.delivery_payload IS NULL OR json_extract(n.delivery_payload, '$.to[0]') = u.email)
)`;
const due = `((n.kind = 'warning' AND n.expiry >= ? AND n.expiry <= ?)
  OR (n.kind = 'expired' AND n.expiry >= ? AND n.expiry < ?))`;
const available = `(n.status = 'pending' OR (n.status = 'sending' AND n.lease_until <= ?))`;
const retryable = `(n.first_attempt_at IS NULL OR n.first_attempt_at > ?)`;
const dateBindings = (now: number) => {
  const { today, warningThrough, expiredSince } = medicNotificationDates(now);
  return [today, warningThrough, expiredSince, today];
};

export interface MedicNotification {
  id: string;
  expiry: string;
  kind: "warning" | "expired";
  email: string;
}

export async function pendingMedicNotifications(
  db: Env["DB"],
  now: number,
  limit: number,
) {
  // Retire in bounded chunks; retain unique cycle keys and discard private payloads.
  await db
    .prepare(
      `
    UPDATE medic_certification_notification AS n SET
      status = CASE WHEN ${retryable} THEN 'cancelled' ELSE 'expired' END,
      delivery_payload = NULL, lease_token = NULL, lease_until = NULL
    WHERE n.id IN (SELECT n.id FROM medic_certification_notification n
      WHERE ${available} AND (NOT ${retryable} OR NOT ${currentProfile} OR NOT ${due}) LIMIT 100)
  `,
    )
    .bind(now - retryWindowMs, now, now - retryWindowMs, ...dateBindings(now))
    .run();
  const rows = await db
    .prepare(
      `
    SELECT n.id, n.expiry, n.kind, (SELECT email FROM user WHERE id = n.user_id) AS email
    FROM medic_certification_notification n
    WHERE ${available} AND ${retryable} AND ${currentProfile} AND ${due}
    ORDER BY n.created_at, n.id LIMIT ?
  `,
    )
    .bind(now, now - retryWindowMs, ...dateBindings(now), limit)
    .all<MedicNotification>();
  return rows.results;
}

/** Recheck eligibility inside the atomic claim, not just in the candidate query. */
export function claimMedicNotification(
  db: Env["DB"],
  row: MedicNotification,
  payload: string,
  token: string,
  now: number,
) {
  return db
    .prepare(
      `
    UPDATE medic_certification_notification AS n SET status = 'sending',
      lease_token = ?, lease_until = ?, attempts = attempts + 1,
      first_attempt_at = coalesce(first_attempt_at, ?), delivery_payload = coalesce(delivery_payload, ?)
    WHERE n.id = ? AND ${available} AND ${retryable} AND ${currentProfile} AND ${due}
      AND EXISTS (SELECT 1 FROM user WHERE id = n.user_id AND email = ?)
    RETURNING delivery_payload
  `,
    )
    .bind(
      token,
      now + leaseMs,
      now,
      payload,
      row.id,
      now,
      now - retryWindowMs,
      ...dateBindings(now),
      row.email,
    )
    .first<{ delivery_payload: string }>();
}

export function finishMedicNotification(
  db: Env["DB"],
  id: string,
  token: string,
  sent: boolean,
  now: number,
) {
  return db
    .prepare(
      `
    UPDATE medic_certification_notification SET status = ?, sent_at = ?,
      delivery_payload = CASE WHEN ? THEN NULL ELSE delivery_payload END,
      lease_token = NULL, lease_until = NULL
    WHERE id = ? AND status = 'sending' AND lease_token = ?
  `,
    )
    .bind(sent ? "sent" : "pending", sent ? now : null, sent ? 1 : 0, id, token)
    .run();
}

export async function countMedicNotifications(db: Env["DB"]) {
  return (await db
    .prepare(
      `SELECT
    count(CASE WHEN status IN ('pending','sending') THEN 1 END) AS pending,
    count(CASE WHEN status = 'expired' THEN 1 END) AS expired
    FROM medic_certification_notification`,
    )
    .first<{ pending: number; expired: number }>())!;
}
