import { z } from "zod";
import {
  addCalendarDays,
  vancouverInput,
  vancouverInstant,
  vancouverOccurrenceInstant,
} from "../../data/event-time";
import { RequestError } from "../http";
import {
  permissionValues,
  requireOrganizer,
  writePermission,
  type Actor,
} from "./access";
import { databaseWriteError } from "./errors";
import { nowMsSql } from "./sql";

export const patrolSeriesSchema = z
  .strictObject({
    firstDate: z.iso.date(),
    localTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    intervalWeeks: z.number().int().min(1).max(52),
    endDate: z.iso.date().nullable().default(null),
    meetingPoint: z.string().trim().min(1).max(500),
    meetingPointUrl: z.union([
      z.literal(""),
      z
        .url()
        .max(2048)
        .refine((value) => new URL(value).protocol === "https:"),
    ]),
    spots: z.number().int().min(1).max(100),
    open: z.boolean(),
    hidden: z.boolean(),
  })
  .refine((value) => !value.endDate || value.endDate >= value.firstDate);

export interface PatrolSeriesRow {
  id: string;
  firstDate: string;
  localTime: string;
  intervalWeeks: number;
  endDate: string | null;
  timeZone: "America/Vancouver";
  meetingPoint: string;
  meetingPointUrl: string | null;
  spots: number;
  open: number;
  hidden: number;
  generationUntil: number;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}
const seriesColumns = `id, first_date AS firstDate, local_time AS localTime,
  interval_weeks AS intervalWeeks, end_date AS endDate, time_zone AS timeZone,
  meeting_point AS meetingPoint, meeting_point_url AS meetingPointUrl,
  spots, open, hidden, generation_until AS generationUntil,
  created_by AS createdBy, created_at AS createdAt, updated_at AS updatedAt`;

export async function findPatrolSeries(
  db: Env["DB"],
  actor: Actor,
  id: string,
) {
  requireOrganizer(actor);
  const row = await db
    .prepare(`SELECT ${seriesColumns} FROM patrol_series WHERE id = ?`)
    .bind(id)
    .first<PatrolSeriesRow>();
  if (!row) throw new RequestError(404, "Patrol series not found.");
  return row;
}

export async function listPatrolSeries(db: Env["DB"], actor: Actor) {
  requireOrganizer(actor);
  return (
    await db
      .prepare(
        `SELECT ${seriesColumns} FROM patrol_series ORDER BY first_date, id`,
      )
      .all<PatrolSeriesRow>()
  ).results;
}

/** Stable identity survives rescheduling, template edits, and cancellation. */
export function patrolOccurrenceId(seriesId: string, occurrenceDate: string) {
  return `patrol:${seriesId}:${occurrenceDate}`;
}

// Exclusive upper bound after 9999-12-31 in Vancouver (UTC−8), not UTC.
const endOfCalendar = 253402329600000;
interface OccurrenceSnapshot {
  occurrenceDate: string;
  startsAt: number;
  cancelledAt: number | null;
}
interface PlannedOccurrence {
  date: string;
  startsAt: number;
}

/** Pure planning is also exercised with a fixed clock across DST boundaries. */
export function planPatrolOccurrences(
  series: Pick<
    PatrolSeriesRow,
    "firstDate" | "localTime" | "intervalWeeks" | "endDate"
  >,
  existing: OccurrenceSnapshot[],
  now: number,
) {
  const today = vancouverInput(now).slice(0, 10);
  const days =
    (Date.parse(`${today}T00:00:00Z`) -
      Date.parse(`${series.firstDate}T00:00:00Z`)) /
    86_400_000;
  const step = series.intervalWeeks * 7;
  let date = addCalendarDays(
    series.firstDate,
    Math.max(0, Math.ceil(days / step)) * step,
  );
  const byDate = new Map(
    existing.map((event) => [event.occurrenceDate, event]),
  );
  const future = existing
    .filter((event) => event.cancelledAt === null && event.startsAt > now)
    .map((event) => event.startsAt)
    .sort((a, b) => a - b);
  const planned: PlannedOccurrence[] = [];
  while (date <= "9999-12-31" && (!series.endDate || date <= series.endDate)) {
    const startsAt = vancouverOccurrenceInstant(date, series.localTime);
    if (startsAt > now && !byDate.has(date)) {
      // Continue over already-materialized dates, even beyond the third slot,
      // to establish a truthful coverage frontier for direct signup writes.
      if (future.length >= 3 && startsAt > future[2])
        return { occurrences: planned, generationUntil: startsAt };
      planned.push({ date, startsAt });
      future.push(startsAt);
      future.sort((a, b) => a - b);
    }
    if (date > addCalendarDays("9999-12-31", -step)) break;
    date = addCalendarDays(date, step);
  }
  return { occurrences: planned, generationUntil: endOfCalendar };
}

function insertOccurrences(
  db: Env["DB"],
  series: PatrolSeriesRow,
  occurrences: PlannedOccurrence[],
  now: number,
) {
  return db
    .prepare(
      `INSERT INTO event (
      id, type, series_id, occurrence_date, starts_at, meeting_point, meeting_point_url,
      spots, open, hidden, created_by, created_at, updated_at)
    SELECT 'patrol:' || ps.id || ':' || json_extract(j.value, '$.date'), 'patrol', ps.id,
      json_extract(j.value, '$.date'), json_extract(j.value, '$.startsAt'),
      ps.meeting_point, ps.meeting_point_url, ps.spots, ps.open, ps.hidden, ps.created_by, ?, ?
    FROM patrol_series ps, json_each(?) j
    WHERE ps.id = ? AND ps.updated_at = ?
    ON CONFLICT(series_id, occurrence_date) DO NOTHING`,
    )
    .bind(now, now, JSON.stringify(occurrences), series.id, series.updatedAt);
}

/**
 * Await on reads and before signup/move writes; no cron is needed for correctness.
 * Unique nominal keys + insert-only generation preserve edits and tombstones.
 * The frontier and inserts commit together in a D1 transaction.
 */
export async function ensurePatrolOccurrences(
  db: Env["DB"],
  seriesId?: string,
  now = Date.now(),
) {
  const seriesRows = (
    await db
      .prepare(
        `SELECT ${seriesColumns} FROM patrol_series${seriesId ? " WHERE id = ?" : ""}`,
      )
      .bind(...(seriesId ? [seriesId] : []))
      .all<PatrolSeriesRow>()
  ).results;
  for (const series of seriesRows) {
    const existing = (
      await db
        .prepare(
          `SELECT occurrence_date AS occurrenceDate,
      starts_at AS startsAt, cancelled_at AS cancelledAt FROM event WHERE series_id = ?`,
        )
        .bind(series.id)
        .all<OccurrenceSnapshot>()
    ).results;
    const plan = planPatrolOccurrences(series, existing, now);
    if (
      !plan.occurrences.length &&
      plan.generationUntil <= series.generationUntil
    )
      continue;
    const results = await db.batch([
      insertOccurrences(db, series, plan.occurrences, now),
      db
        .prepare(
          `UPDATE patrol_series SET generation_until = max(generation_until, ?)
        WHERE id = ? AND updated_at = ?`,
        )
        .bind(plan.generationUntil, series.id, series.updatedAt),
    ]);
    if (!results[1].meta.changes)
      throw new RequestError(
        409,
        "This patrol series changed. Reload the page.",
      );
  }
}

/**
 * Create, or edit the defaults for as-yet unmaterialized occurrences. Existing
 * occurrences are frozen snapshots, editable individually with saveEvent.
 * Schedule identity is immutable; create a new series to change its cadence.
 * End dates are inclusive. Shortening atomically cancels generated FUTURE
 * occurrences beyond that nominal date and their bookings (optionally notifying
 * those rosters). History and cancellation tombstones are never removed.
 */
export async function savePatrolSeries(
  db: Env["DB"],
  actor: Actor,
  input: unknown,
  id?: string,
  version?: number,
  notify = false,
) {
  requireOrganizer(actor);
  const parsed = patrolSeriesSchema.safeParse(input);
  if (!parsed.success)
    throw new RequestError(
      400,
      "Check the first local date/time, weekly interval (1–52), end date, meeting point, capacity and HTTPS map link.",
    );
  const data = parsed.data;
  const now = Date.now();
  const operation = crypto.randomUUID();
  const old = id ? await findPatrolSeries(db, actor, id) : null;
  if (
    old &&
    (old.firstDate !== data.firstDate ||
      old.localTime !== data.localTime ||
      old.intervalWeeks !== data.intervalWeeks)
  )
    throw new RequestError(
      409,
      "A series' first date, local time and interval cannot change. Create a new series instead.",
    );
  if (!old) {
    let first: number;
    try {
      first = Date.parse(
        vancouverInstant(`${data.firstDate}T${data.localTime}`),
      );
    } catch {
      throw new RequestError(
        400,
        "Choose a valid, unambiguous first Vancouver date and time.",
      );
    }
    if (first <= now)
      throw new RequestError(400, "Choose a future first patrol date.");
  }
  id ??= crypto.randomUUID();
  const values = [
    data.meetingPoint,
    data.meetingPointUrl || null,
    data.spots,
    Number(data.open),
    Number(data.hidden),
  ];
  try {
    const write = old
      ? db
          .prepare(
            `UPDATE patrol_series SET meeting_point = ?, meeting_point_url = ?, spots = ?, open = ?, hidden = ?,
          end_date = ?, generation_until = CASE WHEN end_date IS ? THEN generation_until ELSE 0 END, updated_at = ?
        WHERE id = ? AND updated_at = ? AND ${writePermission(true)}`,
          )
          .bind(
            ...values,
            data.endDate,
            data.endDate,
            Math.max(now, old.updatedAt + 1),
            id,
            version ?? -1,
            ...permissionValues(actor),
          )
      : db
          .prepare(
            `INSERT INTO patrol_series (id, first_date, local_time, interval_weeks, end_date,
          meeting_point, meeting_point_url, spots, open, hidden, created_by, created_at, updated_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${writePermission(true)}`,
          )
          .bind(
            id,
            data.firstDate,
            data.localTime,
            data.intervalWeeks,
            data.endDate,
            ...values,
            actor.id,
            now,
            now,
            ...permissionValues(actor),
          );
    const statements = [
      write,
      db
        .prepare(
          `INSERT INTO patrol_series_audit (id, series_id, actor_id, action, changed_fields, created_at)
        SELECT ?, ?, ?, ?, ?, ? WHERE changes() = 1`,
        )
        .bind(
          operation,
          id,
          actor.id,
          old ? "updated" : "created",
          JSON.stringify(Object.keys(data)),
          now,
        ),
    ];
    if (old && data.endDate !== null) {
      // Capture exactly the affected rows before mutation; the series operation
      // authorizes every following audit, notification, and cancellation.
      statements.push(
        db
          .prepare(
            `INSERT INTO event_audit (id, event_id, actor_id, action, changed_fields, created_at)
          SELECT ? || ':' || id, id, ?, 'cancelled', '["cancelledAt","seriesEndDate"]', ? FROM event
          WHERE series_id = ? AND occurrence_date > ? AND cancelled_at IS NULL AND starts_at > ${nowMsSql}
            AND EXISTS(SELECT 1 FROM patrol_series_audit WHERE id = ?)`,
          )
          .bind(operation, actor.id, now, id, data.endDate, operation),
        db
          .prepare(
            `INSERT INTO event_notification (id, operation_id, user_id, subject, body, created_at, delivery_to)
          SELECT lower(hex(randomblob(16))), ?, s.user_id, 'Your After Hours Outreach event was cancelled',
            'An organizer ended this patrol series before your scheduled occurrence. Your registration was cancelled.', ?, u.email
          FROM signup s JOIN user u ON u.id = s.user_id AND u.email_verified = 1
          WHERE s.status = 'confirmed' AND ? = 1
            AND EXISTS(SELECT 1 FROM event_audit a WHERE a.id = ? || ':' || s.event_id)`,
          )
          .bind(operation, now, Number(notify), operation),
        db
          .prepare(
            `UPDATE event SET cancelled_at = ?, open = 0, hidden = 1,
            updated_at = max(updated_at + 1, ?)
          WHERE EXISTS(SELECT 1 FROM event_audit a WHERE a.id = ? || ':' || event.id)`,
          )
          .bind(now, now, operation),
        db
          .prepare(
            `UPDATE signup SET status = 'cancelled', updated_at = ?
          WHERE status = 'confirmed' AND EXISTS(
            SELECT 1 FROM event_audit a WHERE a.id = ? || ':' || signup.event_id)`,
          )
          .bind(now, operation),
      );
    }
    const result = await db.batch(statements);
    if (!result[0].meta.changes)
      throw new RequestError(
        old ? 409 : 403,
        old
          ? "This patrol series changed. Reload before editing it."
          : "Organizer authorization changed. Sign in again.",
      );
    await ensurePatrolOccurrences(db, id);
    return { id, operation, message: "Patrol series saved." };
  } catch (error) {
    return databaseWriteError(error);
  }
}

/** Materialize a scheduled date for an organizer's one-occurrence exception. */
export async function materializePatrolOccurrence(
  db: Env["DB"],
  actor: Actor,
  seriesId: string,
  occurrenceDate: string,
) {
  const series = await findPatrolSeries(db, actor, seriesId);
  if (!z.iso.date().safeParse(occurrenceDate).success)
    throw new RequestError(400, "Choose a scheduled occurrence date.");
  const days =
    (Date.parse(`${occurrenceDate}T00:00:00Z`) -
      Date.parse(`${series.firstDate}T00:00:00Z`)) /
    86_400_000;
  if (
    days < 0 ||
    days % (7 * series.intervalWeeks) !== 0 ||
    (series.endDate && occurrenceDate > series.endDate)
  )
    throw new RequestError(
      400,
      "Choose a scheduled occurrence date within this series.",
    );
  const startsAt = vancouverOccurrenceInstant(occurrenceDate, series.localTime);
  if (startsAt <= Date.now())
    throw new RequestError(409, "Past occurrences cannot be created.");
  // Recheck the live organizer session in the same transaction as generation.
  const result = await db.batch([
    db
      .prepare(
        `UPDATE patrol_series SET generation_until = generation_until
      WHERE id = ? AND updated_at = ? AND ${writePermission(true)}`,
      )
      .bind(seriesId, series.updatedAt, ...permissionValues(actor)),
    db
      .prepare(
        `INSERT INTO event (id, type, series_id, occurrence_date, starts_at,
      meeting_point, meeting_point_url, spots, open, hidden, created_by, created_at, updated_at)
      SELECT ?, 'patrol', id, ?, ?, meeting_point, meeting_point_url, spots, open, hidden, created_by, ?, ?
      FROM patrol_series WHERE id = ? AND changes() = 1
      ON CONFLICT(series_id, occurrence_date) DO NOTHING`,
      )
      .bind(
        patrolOccurrenceId(seriesId, occurrenceDate),
        occurrenceDate,
        startsAt,
        Date.now(),
        Date.now(),
        seriesId,
      ),
  ]);
  if (!result[0].meta.changes)
    throw new RequestError(
      409,
      "This series or your organizer authorization changed. Reload the page.",
    );
  await ensurePatrolOccurrences(db, seriesId);
  return { id: patrolOccurrenceId(seriesId, occurrenceDate) };
}

/** SQL alias is supplied only by backend code, never request input. */
export function recurringSignupWindowSql(alias = "e") {
  return `(${alias}.series_id IS NULL OR (
    ${alias}.cancelled_at IS NULL AND ${alias}.starts_at > ${nowMsSql}
    AND EXISTS(SELECT 1 FROM patrol_series ps WHERE ps.id = ${alias}.series_id
      AND ${alias}.starts_at < ps.generation_until)
    AND (SELECT count(*) FROM event preceding
      WHERE preceding.series_id = ${alias}.series_id AND preceding.cancelled_at IS NULL
        AND preceding.starts_at > ${nowMsSql}
        AND (preceding.starts_at < ${alias}.starts_at OR
          (preceding.starts_at = ${alias}.starts_at AND preceding.id < ${alias}.id))) < 3
  ))`;
}
