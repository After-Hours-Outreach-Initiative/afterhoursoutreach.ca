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
import { orientationCapacityMessage, validOrientationCapacity } from "./policy";

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
    includesOrientation: z.boolean().default(false),
  })
  .refine((value) => !value.endDate || value.endDate >= value.firstDate)
  .refine(validOrientationCapacity, {
    message: orientationCapacityMessage,
    path: ["spots"],
  });

export interface PatrolSeriesRow {
  id: string;
  firstDate: string;
  localTime: string;
  intervalWeeks: number;
  endDate: string | null;
  stoppedFrom: string | null;
  timeZone: "America/Vancouver";
  meetingPoint: string;
  meetingPointUrl: string | null;
  spots: number;
  open: number;
  hidden: number;
  includesOrientation: number;
  generationUntil: number;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}
const seriesColumns = `id, first_date AS firstDate, local_time AS localTime,
  interval_weeks AS intervalWeeks, end_date AS endDate, stopped_from AS stoppedFrom, time_zone AS timeZone,
  meeting_point AS meetingPoint, meeting_point_url AS meetingPointUrl,
   spots, open, hidden, includes_orientation AS includesOrientation, generation_until AS generationUntil,
  created_by AS createdBy, created_at AS createdAt, updated_at AS updatedAt`;

export const patrolTemplateSchema = z
  .strictObject(patrolSeriesSchema.shape)
  .pick({
    localTime: true,
    meetingPoint: true,
    meetingPointUrl: true,
    spots: true,
    open: true,
    hidden: true,
    includesOrientation: true,
  })
  .extend({ dayOffset: z.number().int().min(-366).max(366).default(0) })
  .refine(validOrientationCapacity, {
    message: orientationCapacityMessage,
    path: ["spots"],
  });
export type PatrolTemplateInput = z.infer<typeof patrolTemplateSchema>;
export interface PatrolTemplate extends Omit<
  PatrolTemplateInput,
  "open" | "hidden" | "meetingPointUrl" | "includesOrientation"
> {
  effectiveDate: string;
  open: number;
  hidden: number;
  includesOrientation: number;
  meetingPointUrl: string | null;
}
export async function listPatrolTemplates(
  db: Env["DB"],
  actor: Actor,
  seriesId: string,
) {
  requireOrganizer(actor);
  return readTemplates(db, seriesId);
}
async function readTemplates(db: Env["DB"], seriesId: string) {
  return (
    await db
      .prepare(
        `SELECT effective_date AS effectiveDate, local_time AS localTime,
    day_offset AS dayOffset, meeting_point AS meetingPoint, meeting_point_url AS meetingPointUrl,
     spots, open, hidden, includes_orientation AS includesOrientation FROM patrol_series_template WHERE series_id = ? ORDER BY effective_date`,
      )
      .bind(seriesId)
      .all<PatrolTemplate>()
  ).results;
}
export function patrolTemplateFor(
  series: PatrolSeriesRow,
  templates: PatrolTemplate[],
  date: string,
): PatrolTemplate {
  return (
    templates.filter((template) => template.effectiveDate <= date).at(-1) ?? {
      ...series,
      effectiveDate: series.firstDate,
      dayOffset: 0,
    }
  );
}
function templateStart(
  date: string,
  template: Pick<PatrolTemplate, "localTime" | "dayOffset">,
) {
  return vancouverOccurrenceInstant(
    addCalendarDays(date, template.dayOffset),
    template.localTime,
  );
}

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
  > & { stoppedFrom?: string | null },
  existing: OccurrenceSnapshot[],
  now: number,
  templates: PatrolTemplate[] = [],
) {
  const today = vancouverInput(now).slice(0, 10);
  const offsets = [0, ...templates.map((template) => template.dayOffset)];
  const maxOffset = Math.max(...offsets);
  const minOffset = Math.min(...offsets);
  const days =
    (Date.parse(`${addCalendarDays(today, -maxOffset)}T00:00:00Z`) -
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
  let frontier = endOfCalendar;
  while (
    date <= "9999-12-31" &&
    (!series.endDate || date <= series.endDate) &&
    (!series.stoppedFrom || date < series.stoppedFrom)
  ) {
    const template = templates
      .filter((template) => template.effectiveDate <= date)
      .at(-1);
    const startsAt = templateStart(
      date,
      template ?? { localTime: series.localTime, dayOffset: 0 },
    );
    if (startsAt > now && !byDate.has(date)) {
      // Continue over already-materialized dates, even beyond the third slot,
      // to establish a truthful coverage frontier for direct signup writes.
      planned.push({ date, startsAt });
      future.push(startsAt);
      future.sort((a, b) => a - b);
    }
    // Later templates can shift dates backwards. Scan until even their earliest
    // possible local start is beyond the third slot before choosing the window.
    if (
      future.length >= 3 &&
      vancouverOccurrenceInstant(addCalendarDays(date, minOffset), "00:00") >
        future[2]
    ) {
      const missing = planned.filter((event) => event.startsAt > future[2]);
      if (missing.length) {
        // Unseen later templates might shift their starts earlier than these
        // missing rows. Never overstate coverage while generation is delayed.
        frontier = Math.min(
          vancouverOccurrenceInstant(addCalendarDays(date, minOffset), "00:00"),
          ...missing.map((event) => event.startsAt),
        );
        break;
      }
    }
    if (date > addCalendarDays("9999-12-31", -step)) break;
    date = addCalendarDays(date, step);
  }
  const third = future[2] ?? Infinity;
  return {
    occurrences: planned.filter((event) => event.startsAt <= third),
    generationUntil: Math.min(
      frontier,
      ...planned
        .filter((event) => event.startsAt > third)
        .map((event) => event.startsAt),
    ),
  };
}

function insertOccurrences(
  db: Env["DB"],
  series: PatrolSeriesRow,
  occurrences: PlannedOccurrence[],
  now: number,
  templates: PatrolTemplate[] = [],
) {
  const rows = occurrences.map((event) => ({
    ...event,
    ...patrolTemplateFor(series, templates, event.date),
  }));
  return db
    .prepare(
      `INSERT INTO event (
      id, type, series_id, occurrence_date, starts_at, meeting_point, meeting_point_url,
       spots, open, hidden, includes_orientation, created_by, created_at, updated_at)
    SELECT 'patrol:' || ps.id || ':' || json_extract(j.value, '$.date'), 'patrol', ps.id,
      json_extract(j.value, '$.date'), json_extract(j.value, '$.startsAt'),
       json_extract(j.value, '$.meetingPoint'), json_extract(j.value, '$.meetingPointUrl'),
        json_extract(j.value, '$.spots'), json_extract(j.value, '$.open'), json_extract(j.value, '$.hidden'), json_extract(j.value, '$.includesOrientation'), ps.created_by, ?, ?
    FROM patrol_series ps, json_each(?) j
    WHERE ps.id = ? AND ps.updated_at = ?
    ON CONFLICT(series_id, occurrence_date) DO NOTHING`,
    )
    .bind(now, now, JSON.stringify(rows), series.id, series.updatedAt);
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
    const templates = await readTemplates(db, series.id);
    const existing = (
      await db
        .prepare(
          `SELECT occurrence_date AS occurrenceDate,
      starts_at AS startsAt, cancelled_at AS cancelledAt FROM event WHERE series_id = ?`,
        )
        .bind(series.id)
        .all<OccurrenceSnapshot>()
    ).results;
    const plan = planPatrolOccurrences(series, existing, now, templates);
    // Legacy undersized defaults remain readable, but must be edited before
    // creating occurrences under the two-place/four-with-orientation minimum.
    if (
      plan.occurrences.some(
        (event) =>
          !validOrientationCapacity(
            patrolTemplateFor(series, templates, event.date),
          ),
      )
    )
      continue;
    if (
      !plan.occurrences.length &&
      plan.generationUntil <= series.generationUntil
    )
      continue;
    const results = await db.batch([
      insertOccurrences(db, series, plan.occurrences, now, templates),
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
      parsed.error.issues.find(
        (issue) => issue.message === orientationCapacityMessage,
      )?.message ??
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
    try {
      vancouverInstant(`${data.firstDate}T${data.localTime}`);
    } catch {
      throw new RequestError(
        400,
        "Choose a valid, unambiguous first date and time.",
      );
    }
  }
  id ??= crypto.randomUUID();
  const values = [
    data.meetingPoint,
    data.meetingPointUrl || null,
    data.spots,
    Number(data.open),
    Number(data.hidden),
    Number(data.includesOrientation),
  ];
  try {
    const write = old
      ? db
          .prepare(
            `UPDATE patrol_series SET meeting_point = ?, meeting_point_url = ?, spots = ?, open = ?, hidden = ?, includes_orientation = ?,
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
          meeting_point, meeting_point_url, spots, open, hidden, includes_orientation, created_by, created_at, updated_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${writePermission(true)}`,
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
  // Existing snapshots remain addressable after stopping/shortening, including
  // cancellations and past history. This path never recreates an occurrence.
  const existing = await db
    .prepare(`SELECT id FROM event WHERE series_id = ? AND occurrence_date = ?`)
    .bind(seriesId, occurrenceDate)
    .first<{ id: string }>();
  if (existing) {
    const result = await db
      .prepare(
        `UPDATE patrol_series SET generation_until = generation_until
      WHERE id = ? AND updated_at = ? AND ${writePermission(true)}`,
      )
      .bind(seriesId, series.updatedAt, ...permissionValues(actor))
      .run();
    if (!result.meta.changes)
      throw new RequestError(
        409,
        "This series or your organizer authorization changed. Reload the page.",
      );
    return existing;
  }
  requireScheduledDate(series, occurrenceDate);
  const templates = await readTemplates(db, seriesId);
  const template = patrolTemplateFor(series, templates, occurrenceDate);
  if (!validOrientationCapacity(template))
    throw new RequestError(400, orientationCapacityMessage);
  const startsAt = templateStart(occurrenceDate, template);
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
      meeting_point, meeting_point_url, spots, open, hidden, includes_orientation, created_by, created_at, updated_at)
       SELECT ?, 'patrol', id, ?, ?, ?, ?, ?, ?, ?, ?, created_by, ?, ?
      FROM patrol_series WHERE id = ? AND changes() = 1
      ON CONFLICT(series_id, occurrence_date) DO NOTHING`,
      )
      .bind(
        patrolOccurrenceId(seriesId, occurrenceDate),
        occurrenceDate,
        startsAt,
        template.meetingPoint,
        template.meetingPointUrl,
        template.spots,
        template.open,
        template.hidden,
        template.includesOrientation,
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

function requireScheduledDate(
  series: PatrolSeriesRow,
  date: string,
  allowStopped = false,
) {
  if (!z.iso.date().safeParse(date).success)
    throw new RequestError(400, "Choose a scheduled occurrence date.");
  const days =
    (Date.parse(`${date}T00:00:00Z`) -
      Date.parse(`${series.firstDate}T00:00:00Z`)) /
    86_400_000;
  if (
    days < 0 ||
    days % (7 * series.intervalWeeks) !== 0 ||
    (series.endDate && date > series.endDate) ||
    (!allowStopped && series.stoppedFrom && date >= series.stoppedFrom)
  )
    throw new RequestError(
      400,
      "Choose a scheduled occurrence date within this series.",
    );
}

/** Replace the template from a nominal date, including generated snapshots.
 * Individual edits (event_audit.updated) and cancellation tombstones always win.
 * Signups are never recreated, moved or dropped; capacity failures roll back ALL.
 */
export async function updatePatrolSeriesFrom(
  db: Env["DB"],
  actor: Actor,
  id: string,
  date: string,
  input: unknown,
  version: number,
  notify = false,
) {
  requireOrganizer(actor);
  const parsed = patrolTemplateSchema.safeParse(input);
  if (!parsed.success)
    throw new RequestError(
      400,
      parsed.error.issues.find(
        (issue) => issue.message === orientationCapacityMessage,
      )?.message ??
        "Check the recurring time, date offset, capacity, meeting point and HTTPS map link.",
    );
  const data = parsed.data;
  const series = await findPatrolSeries(db, actor, id);
  requireScheduledDate(series, date);
  if (templateStart(date, data) <= Date.now())
    throw new RequestError(400, "Choose a future recurring date and time.");
  const now = Date.now();
  const operation = crypto.randomUUID();
  const rows = (
    await db
      .prepare(
        `SELECT id, occurrence_date AS date FROM event
    WHERE series_id = ? AND occurrence_date >= ? AND cancelled_at IS NULL AND starts_at > ${nowMsSql}`,
      )
      .bind(id, date)
      .all<{ id: string; date: string }>()
  ).results;
  const updates = rows.map((row) => ({
    ...row,
    startsAt: templateStart(row.date, data),
  }));
  const values = [
    data.localTime,
    data.dayOffset,
    data.meetingPoint,
    data.meetingPointUrl || null,
    data.spots,
    Number(data.open),
    Number(data.hidden),
    Number(data.includesOrientation),
  ];
  try {
    const results = await db.batch([
      db
        .prepare(
          `UPDATE patrol_series SET generation_until = 0, updated_at = ?
        WHERE id = ? AND updated_at = ? AND ${writePermission(true)}
          AND NOT EXISTS(SELECT 1 FROM event e WHERE e.series_id = patrol_series.id AND e.occurrence_date >= ?
            AND e.cancelled_at IS NULL AND e.starts_at > ${nowMsSql}
            AND e.id NOT IN (SELECT json_extract(j.value,'$.id') FROM json_each(?) j))`,
        )
        .bind(
          Math.max(now, series.updatedAt + 1),
          id,
          version,
          ...permissionValues(actor),
          date,
          JSON.stringify(updates),
        ),
      db
        .prepare(
          `INSERT INTO patrol_series_audit (id,series_id,actor_id,action,changed_fields,created_at)
        SELECT ?,?,?,'updated_future',?,? WHERE changes() = 1`,
        )
        .bind(
          operation,
          id,
          actor.id,
          JSON.stringify(["effectiveDate", ...Object.keys(data)]),
          now,
        ),
      db
        .prepare(
          `DELETE FROM patrol_series_template WHERE series_id = ? AND effective_date >= ?
        AND EXISTS(SELECT 1 FROM patrol_series_audit WHERE id = ?)`,
        )
        .bind(id, date, operation),
      db
        .prepare(
          `INSERT INTO patrol_series_template (id,series_id,effective_date,local_time,day_offset,
         meeting_point,meeting_point_url,spots,open,hidden,includes_orientation)
         SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM patrol_series_audit WHERE id = ?)`,
        )
        .bind(operation, id, date, ...values, operation),
      db
        .prepare(
          `INSERT INTO event_audit (id,event_id,actor_id,action,changed_fields,created_at)
        SELECT ? || ':' || e.id,e.id,?,'series_updated',?,? FROM event e JOIN json_each(?) j ON e.id = json_extract(j.value,'$.id')
        WHERE e.cancelled_at IS NULL AND e.starts_at > ${nowMsSql}
          AND NOT EXISTS(SELECT 1 FROM event_audit a WHERE a.event_id = e.id AND a.action = 'updated')
           AND (e.starts_at != json_extract(j.value,'$.startsAt') OR e.meeting_point != ? OR e.meeting_point_url IS NOT ? OR e.spots != ? OR e.open != ? OR e.hidden != ? OR coalesce(e.includes_orientation, e.type = 'orientation') != ?)
          AND EXISTS(SELECT 1 FROM patrol_series_audit WHERE id = ?)`,
        )
        .bind(
          operation,
          actor.id,
          JSON.stringify(Object.keys(data)),
          now,
          JSON.stringify(updates),
          ...values.slice(2),
          operation,
        ),
      db
        .prepare(
          `UPDATE event SET starts_at = (SELECT json_extract(j.value,'$.startsAt') FROM json_each(?) j WHERE json_extract(j.value,'$.id') = event.id),
         meeting_point = ?, meeting_point_url = ?, spots = ?, open = ?, hidden = ?, includes_orientation = ?, updated_at = max(updated_at + 1, ?)
        WHERE EXISTS(SELECT 1 FROM event_audit a WHERE a.id = ? || ':' || event.id)`,
        )
        .bind(JSON.stringify(updates), ...values.slice(2), now, operation),
      seriesNotifications(
        db,
        operation,
        now,
        notify,
        "Your After Hours Outreach patrol changed",
        "An organizer changed this and future patrols. Your existing registration is still reserved. Check the volunteer page for your updated patrol date, time and meeting point.",
      ),
    ]);
    if (!results[0].meta.changes)
      throw new RequestError(
        409,
        "This patrol series or your organizer authorization changed. Reload before editing it.",
      );
    await ensurePatrolOccurrences(db, id);
    return {
      operation,
      message:
        "This and future patrols saved. Individual exceptions and existing registrations were kept.",
    };
  } catch (error) {
    return databaseWriteError(error);
  }
}

function seriesNotifications(
  db: Env["DB"],
  operation: string,
  now: number,
  notify: boolean,
  subject: string,
  body: string,
) {
  return db
    .prepare(
      `INSERT INTO event_notification (id,operation_id,user_id,subject,body,created_at,delivery_to)
    SELECT lower(hex(randomblob(16))),?,s.user_id,?,?,?,u.email FROM signup s
    JOIN user u ON u.id = s.user_id AND u.email_verified = 1 WHERE s.status = 'confirmed' AND ? = 1
      AND EXISTS(SELECT 1 FROM event_audit a WHERE a.id = ? || ':' || s.event_id)`,
    )
    .bind(operation, subject, body, now, Number(notify), operation);
}

/** Stop is exclusive and permanent, even when a later end-date edit extends a series. */
export async function stopPatrolSeries(
  db: Env["DB"],
  actor: Actor,
  id: string,
  date: string,
  version: number,
  reason = "",
  notify = false,
) {
  requireOrganizer(actor);
  if (reason.length > 1000)
    throw new RequestError(400, "Keep the reason to 1000 characters or fewer.");
  const series = await findPatrolSeries(db, actor, id);
  requireScheduledDate(series, date, true);
  const now = Date.now();
  const operation = crypto.randomUUID();
  const results = await db.batch([
    db
      .prepare(
        `UPDATE patrol_series SET stopped_from = CASE WHEN stopped_from IS NULL OR stopped_from > ? THEN ? ELSE stopped_from END,
      generation_until = 0, updated_at = ? WHERE id = ? AND updated_at = ? AND ${writePermission(true)}`,
      )
      .bind(
        date,
        date,
        Math.max(now, series.updatedAt + 1),
        id,
        version,
        ...permissionValues(actor),
      ),
    db
      .prepare(
        `INSERT INTO patrol_series_audit (id,series_id,actor_id,action,changed_fields,created_at)
      SELECT ?,?,?,'stopped','["stoppedFrom"]',? WHERE changes() = 1`,
      )
      .bind(operation, id, actor.id, now),
    db
      .prepare(
        `INSERT INTO event_audit (id,event_id,actor_id,action,changed_fields,created_at)
      SELECT ? || ':' || id,id,?,'cancelled','["cancelledAt","stoppedFrom"]',? FROM event
      WHERE series_id = ? AND occurrence_date >= ? AND cancelled_at IS NULL AND starts_at > ${nowMsSql}
        AND EXISTS(SELECT 1 FROM patrol_series_audit WHERE id = ?)`,
      )
      .bind(operation, actor.id, now, id, date, operation),
    seriesNotifications(
      db,
      operation,
      now,
      notify,
      "Your After Hours Outreach patrol was cancelled",
      `An organizer stopped this patrol series. Your registration was cancelled.${reason ? `\nReason: ${reason}` : ""}`,
    ),
    db
      .prepare(
        `UPDATE event SET cancelled_at = ?, open = 0, hidden = 1, updated_at = max(updated_at + 1, ?)
      WHERE EXISTS(SELECT 1 FROM event_audit a WHERE a.id = ? || ':' || event.id)`,
      )
      .bind(now, now, operation),
    db
      .prepare(
        `UPDATE signup SET status = 'cancelled', updated_at = ? WHERE status = 'confirmed'
      AND EXISTS(SELECT 1 FROM event_audit a WHERE a.id = ? || ':' || signup.event_id)`,
      )
      .bind(now, operation),
  ]);
  if (!results[0].meta.changes)
    throw new RequestError(
      409,
      "This patrol series or your organizer authorization changed. Reload the page.",
    );
  await ensurePatrolOccurrences(db, id);
  return {
    operation,
    message:
      "Recurrence stopped. Future occurrences and their registrations were cancelled; history was kept.",
  };
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
