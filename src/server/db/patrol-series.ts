import { assertOrientationKept } from "./orientation-check";
import { z } from "zod";
import {
  patrolSeriesChangedEmail,
  patrolSeriesRescheduledEmail,
  patrolSeriesShortenedEmail,
  patrolSeriesStoppedEmail,
  type EmailContent,
} from "../../data/email-templates";
import {
  addCalendarDays,
  addCalendarMonths,
  vancouverInput,
  vancouverInstant,
  vancouverOccurrenceInstant,
} from "../../data/event-time";
import { maxIntervalWeeks } from "../../data/event-series";
import { RequestError } from "../http";
import {
  permissionValues,
  requireOrganizer,
  writePermission,
  type Actor,
} from "./access";
import { databaseWriteError } from "./errors";
import { includesOrientationSql, nowMsSql } from "./sql";
import { orientationCapacityMessage, validOrientationCapacity } from "./policy";
import {
  eventSettingFields,
  eventSettingInputFields,
  withEventSettings,
} from "./event-settings";
import type { EventLimits } from "../../data/event-limits";

export const patrolSeriesSchema = z
  .strictObject({
    firstDate: z.iso.date(),
    localTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    intervalWeeks: z.number().int().min(1).max(maxIntervalWeeks),
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
    ...eventSettingFields,
    open: z.boolean(),
    hidden: z.boolean(),
    includesOrientation: z.boolean().default(false),
  })
  .refine((value) => !value.endDate || value.endDate >= value.firstDate)
  .refine(validOrientationCapacity, {
    message: orientationCapacityMessage,
    path: ["spots"],
  });

export const patrolSeriesRequestSchema = z
  .strictObject(patrolSeriesSchema.shape)
  .extend(eventSettingInputFields);

export interface PatrolSeriesRow extends EventLimits {
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
  unregisterMinutes: number;
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
   spots, min_medic_spots AS minMedicSpots, min_new_volunteer_spots AS minNewVolunteerSpots,
   max_new_volunteers AS maxNewVolunteers, unregister_minutes AS unregisterMinutes,
   open, hidden, includes_orientation AS includesOrientation, generation_until AS generationUntil,
  created_by AS createdBy, created_at AS createdAt, updated_at AS updatedAt`;

export const patrolTemplateSchema = z
  .strictObject(patrolSeriesSchema.shape)
  .pick({
    localTime: true,
    meetingPoint: true,
    meetingPointUrl: true,
    spots: true,
    minMedicSpots: true,
    minNewVolunteerSpots: true,
    maxNewVolunteers: true,
    unregisterMinutes: true,
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
export const patrolTemplateRequestSchema = z
  .strictObject(patrolTemplateSchema.shape)
  .extend(eventSettingInputFields)
  .extend({
    dayOffset: z.number().int().min(-366).max(366),
    intervalWeeks: z.number().int().min(1).max(maxIntervalWeeks),
    endDate: z.iso.date().nullable(),
  })
  // Series edits send only what changed; the rest keeps the series values.
  .partial();
export interface PatrolTemplate extends Omit<
  PatrolTemplateInput,
  "open" | "hidden" | "meetingPointUrl" | "includesOrientation"
> {
  effectiveDate: string;
  /** Null keeps the earlier cadence; a value restarts it from effectiveDate. */
  intervalWeeks?: number | null;
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
    day_offset AS dayOffset, interval_weeks AS intervalWeeks, meeting_point AS meetingPoint, meeting_point_url AS meetingPointUrl,
     spots, min_medic_spots AS minMedicSpots, min_new_volunteer_spots AS minNewVolunteerSpots,
     max_new_volunteers AS maxNewVolunteers, unregister_minutes AS unregisterMinutes,
     open, hidden, includes_orientation AS includesOrientation FROM patrol_series_template WHERE series_id = ? ORDER BY effective_date`,
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
      intervalWeeks: null,
    }
  );
}

interface Cadence {
  from: string;
  intervalWeeks: number;
}
/** Cadence segments in date order: the first date, then each interval change. */
function cadences(
  series: Pick<PatrolSeriesRow, "firstDate" | "intervalWeeks">,
  templates: Pick<PatrolTemplate, "effectiveDate" | "intervalWeeks">[],
): Cadence[] {
  return [
    { from: series.firstDate, intervalWeeks: series.intervalWeeks },
    ...templates.flatMap((template) =>
      template.intervalWeeks
        ? [
            {
              from: template.effectiveDate,
              intervalWeeks: template.intervalWeeks,
            },
          ]
        : [],
    ),
  ];
}
const dayNumber = (date: string) =>
  Date.parse(`${date}T00:00:00Z`) / 86_400_000;
export function seriesCadenceAt(
  series: Pick<PatrolSeriesRow, "firstDate" | "intervalWeeks">,
  templates: Pick<PatrolTemplate, "effectiveDate" | "intervalWeeks">[],
  date: string,
) {
  return cadences(series, templates)
    .filter((cadence) => cadence.from <= date)
    .at(-1)!;
}
function onCadence(
  series: Pick<PatrolSeriesRow, "firstDate" | "intervalWeeks">,
  templates: Pick<PatrolTemplate, "effectiveDate" | "intervalWeeks">[],
  date: string,
) {
  const cadence = seriesCadenceAt(series, templates, date);
  const days = dayNumber(date) - dayNumber(cadence.from);
  return days >= 0 && days % (7 * cadence.intervalWeeks) === 0;
}
/** SQL twin of onCadence for a series row alias and a date expression. */
export function onCadenceSql(series: string, date: string) {
  const latest = (
    column: string,
  ) => `(SELECT t.${column} FROM patrol_series_template t
    WHERE t.series_id = ${series}.id AND t.effective_date <= ${date} AND t.interval_weeks IS NOT NULL
    ORDER BY t.effective_date DESC LIMIT 1)`;
  return `(CAST(julianday(${date}) - julianday(coalesce(${latest("effective_date")}, ${series}.first_date)) AS INTEGER)
    % (7 * coalesce(${latest("interval_weeks")}, ${series}.interval_weeks)) = 0)`;
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
    .prepare(
      `SELECT ${seriesColumns} FROM patrol_series WHERE id = ?
      AND NOT EXISTS(SELECT 1 FROM patrol_series_audit a WHERE a.series_id = patrol_series.id AND a.action = 'deleted')`,
    )
    .bind(id)
    .first<PatrolSeriesRow>();
  if (!row) throw new RequestError(404, "Recurring event not found.");
  return row;
}

export async function listPatrolSeries(db: Env["DB"], actor: Actor) {
  requireOrganizer(actor);
  return (
    await db
      .prepare(
        `SELECT ${seriesColumns} FROM patrol_series
        WHERE NOT EXISTS(SELECT 1 FROM patrol_series_audit a WHERE a.series_id = patrol_series.id AND a.action = 'deleted')
        ORDER BY first_date, id`,
      )
      .all<PatrolSeriesRow>()
  ).results;
}

/** Stable identity survives rescheduling, template edits, and cancellation. */
export function patrolOccurrenceId(seriesId: string, occurrenceDate: string) {
  return `patrol:${seriesId}:${occurrenceDate}`;
}

interface OccurrenceSnapshot {
  occurrenceDate: string;
  startsAt: number;
  cancelledAt: number | null;
}
interface PlannedOccurrence {
  date: string;
  startsAt: number;
}

/** Series dates are generated and open for signup up to two months ahead. */
export const recurringWindowMonths = 2;

/** Exclusive: Vancouver midnight on the same day of the month, two months out. */
export function recurringHorizon(now: number) {
  return vancouverOccurrenceInstant(
    addCalendarMonths(vancouverInput(now).slice(0, 10), recurringWindowMonths),
    "00:00",
  );
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
  const horizon = recurringHorizon(now);
  const offsets = [0, ...templates.map((template) => template.dayOffset)];
  const maxOffset = Math.max(...offsets);
  const minOffset = Math.min(...offsets);
  const byDate = new Set(existing.map((event) => event.occurrenceDate));
  const occurrences: PlannedOccurrence[] = [];
  const segments = cadences(series, templates);
  for (const [index, cadence] of segments.entries()) {
    const until = segments[index + 1]?.from;
    const step = cadence.intervalWeeks * 7;
    const days =
      dayNumber(addCalendarDays(today, -maxOffset)) - dayNumber(cadence.from);
    let date = addCalendarDays(
      cadence.from,
      Math.max(0, Math.ceil(days / step)) * step,
    );
    while (
      date <= "9999-12-31" &&
      (!until || date < until) &&
      (!series.endDate || date <= series.endDate) &&
      (!series.stoppedFrom || date < series.stoppedFrom) &&
      // Templates can shift a date earlier; stop once even the earliest shift is past.
      vancouverOccurrenceInstant(addCalendarDays(date, minOffset), "00:00") <
        horizon
    ) {
      const template = templates
        .filter((template) => template.effectiveDate <= date)
        .at(-1);
      const startsAt = templateStart(
        date,
        template ?? { localTime: series.localTime, dayOffset: 0 },
      );
      if (startsAt > now && startsAt < horizon && !byDate.has(date))
        occurrences.push({ date, startsAt });
      if (date > addCalendarDays("9999-12-31", -step)) break;
      date = addCalendarDays(date, step);
    }
  }
  return { occurrences, generationUntil: horizon };
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
       spots, min_medic_spots, min_new_volunteer_spots, max_new_volunteers, unregister_minutes,
       open, hidden, includes_orientation, created_by, created_at, updated_at)
    SELECT 'patrol:' || ps.id || ':' || json_extract(j.value, '$.date'), 'patrol', ps.id,
      json_extract(j.value, '$.date'), json_extract(j.value, '$.startsAt'),
       json_extract(j.value, '$.meetingPoint'), json_extract(j.value, '$.meetingPointUrl'),
        json_extract(j.value, '$.spots'), json_extract(j.value, '$.minMedicSpots'),
        json_extract(j.value, '$.minNewVolunteerSpots'), json_extract(j.value, '$.maxNewVolunteers'), json_extract(j.value, '$.unregisterMinutes'),
        json_extract(j.value, '$.open'), json_extract(j.value, '$.hidden'), json_extract(j.value, '$.includesOrientation'), ps.created_by, ?, ?
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
        `SELECT ${seriesColumns} FROM patrol_series WHERE
        NOT EXISTS(SELECT 1 FROM patrol_series_audit a WHERE a.series_id = patrol_series.id AND a.action = 'deleted')
        ${seriesId ? " AND id = ?" : ""}`,
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
    // creating occurrences under their reserved-place minimum.
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
      plan.generationUntil === series.generationUntil
    )
      continue;
    const results = await db.batch([
      insertOccurrences(db, series, plan.occurrences, now, templates),
      db
        .prepare(
          `UPDATE patrol_series SET generation_until = ?
        WHERE id = ? AND updated_at = ?`,
        )
        .bind(plan.generationUntil, series.id, series.updatedAt),
    ]);
    if (!results[1].meta.changes)
      throw new RequestError(
        409,
        "This recurring event changed. Reload the page.",
      );
  }
}

/**
 * Create, or edit the defaults for as-yet unmaterialized occurrences. Existing
 * occurrences are frozen snapshots, editable individually with saveEvent.
 * The first date/time zone remain fixed. Time and interval edits affect only
 * missing future snapshots; the cadence stays anchored to the first date.
 * Effective templates still override defaults, and off-cadence snapshots survive.
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
  const old = id ? await findPatrolSeries(db, actor, id) : null;
  const parsed = patrolSeriesSchema.safeParse(
    withEventSettings(input, old ?? undefined),
  );
  if (!parsed.success)
    throw new RequestError(
      400,
      parsed.error.issues.find(
        (issue) => issue.message === orientationCapacityMessage,
      )?.message ??
        "Check the first local date/time, weekly interval (1–8), end date, meeting point, capacity and HTTPS map link.",
    );
  const data = parsed.data;
  const now = Date.now();
  const operation = crypto.randomUUID();
  if (old && old.firstDate !== data.firstDate)
    throw new RequestError(
      409,
      "A series' first date cannot change. Create a new series instead.",
    );
  if (!old || old.localTime !== data.localTime) {
    try {
      vancouverInstant(`${data.firstDate}T${data.localTime}`);
    } catch {
      throw new RequestError(
        400,
        "Choose a valid, unambiguous first date and time.",
      );
    }
  }
  // A later first date would leave the series with no date to show or edit.
  if (
    !old &&
    vancouverOccurrenceInstant(data.firstDate, data.localTime) >=
      recurringHorizon(now)
  )
    throw new RequestError(
      400,
      "Choose a first date within the next two months.",
    );
  id ??= crypto.randomUUID();
  const values = [
    data.meetingPoint,
    data.meetingPointUrl || null,
    data.spots,
    data.minMedicSpots,
    data.minNewVolunteerSpots,
    data.maxNewVolunteers,
    data.unregisterMinutes,
    Number(data.open),
    Number(data.hidden),
    Number(data.includesOrientation),
  ];
  try {
    const write = old
      ? db
          .prepare(
            `UPDATE patrol_series SET meeting_point = ?, meeting_point_url = ?, spots = ?,
           min_medic_spots = ?, min_new_volunteer_spots = ?, max_new_volunteers = ?, unregister_minutes = ?,
           open = ?, hidden = ?, includes_orientation = ?,
          local_time = ?, interval_weeks = ?, end_date = ?,
          generation_until = CASE WHEN local_time IS ? AND interval_weeks IS ? AND end_date IS ? THEN generation_until ELSE 0 END, updated_at = ?
        WHERE id = ? AND updated_at = ? AND ${writePermission(true)}`,
          )
          .bind(
            ...values,
            data.localTime,
            data.intervalWeeks,
            data.endDate,
            data.localTime,
            data.intervalWeeks,
            data.endDate,
            Math.max(now, old.updatedAt + 1),
            id,
            version ?? -1,
            ...permissionValues(actor),
          )
      : db
          .prepare(
            `INSERT INTO patrol_series (id, first_date, local_time, interval_weeks, end_date,
          meeting_point, meeting_point_url, spots, min_medic_spots, min_new_volunteer_spots, max_new_volunteers, unregister_minutes,
          open, hidden, includes_orientation, created_by, created_at, updated_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${writePermission(true)}`,
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
      const dated = await datedSeriesEmails(
        db,
        id,
        data.endDate,
        false,
        (event) => patrolSeriesShortenedEmail(event),
      );
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
        seriesNotifications(
          db,
          operation,
          now,
          notify,
          patrolSeriesShortenedEmail(),
          dated,
        ),
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
          ? "This recurring event changed. Reload before editing it."
          : "Organizer authorization changed. Sign in again.",
      );
    await ensurePatrolOccurrences(db, id);
    return { id, operation, message: "Recurring event saved." };
  } catch (error) {
    return databaseWriteError(error);
  }
}

async function requireScheduledDate(
  db: Env["DB"],
  series: PatrolSeriesRow,
  templates: PatrolTemplate[],
  date: string,
  allowStopped = false,
) {
  if (!z.iso.date().safeParse(date).success)
    throw new RequestError(400, "Choose a scheduled occurrence date.");
  const scheduled =
    date >= series.firstDate && onCadence(series, templates, date);
  // Interval edits never re-key existing snapshots. They remain valid
  // boundaries for this-and-future edits/stops even off the new cadence.
  const existing =
    !scheduled &&
    (await db
      .prepare(
        "SELECT 1 FROM event WHERE series_id = ? AND occurrence_date = ?",
      )
      .bind(series.id, date)
      .first());
  if (
    date < series.firstDate ||
    (!scheduled && !existing) ||
    (series.endDate && date > series.endDate) ||
    (!allowStopped && series.stoppedFrom && date >= series.stoppedFrom)
  )
    throw new RequestError(
      400,
      "Choose a scheduled occurrence date within this series.",
    );
}

export type SeriesScope = "future" | "all";

/** A date edited on its own, until an "all events" edit replaces it again. */
export const separateEditSql = (
  alias = "e",
) => `EXISTS(SELECT 1 FROM event_audit a
  WHERE a.event_id = ${alias}.id AND a.action = 'updated'
    AND NOT EXISTS(SELECT 1 FROM event_audit r WHERE r.event_id = a.event_id
      AND r.action = 'series_updated' AND r.created_at >= a.created_at))`;

/** "All" never reaches back: it starts at the series' next upcoming date. */
async function scopeDate(
  db: Env["DB"],
  seriesId: string,
  date: string,
  scope: SeriesScope,
) {
  if (scope === "future") return date;
  const first = await db
    .prepare(
      `SELECT min(occurrence_date) AS date FROM event
      WHERE series_id = ? AND cancelled_at IS NULL AND starts_at > ${nowMsSql}`,
    )
    .bind(seriesId)
    .first<{ date: string | null }>();
  return first?.date && first.date < date ? first.date : date;
}

const seriesScheduleSchema = z.object({
  intervalWeeks: z.number().int().min(1).max(maxIntervalWeeks).optional(),
  endDate: z.iso.date().nullable().optional(),
});

/** Replace the template from a nominal date, including generated snapshots.
 * Individual edits (event_audit.updated) and cancellation tombstones always win.
 * A new interval restarts the cadence from that date; upcoming dates off the
 * new cadence or after a new last date are cancelled with their bookings.
 * Other signups are never recreated, moved or dropped; capacity failures roll back ALL.
 */
/** The limits a this-and-future edit would apply, or null if it is invalid. */
export async function patrolTemplateLimits(
  db: Env["DB"],
  actor: Actor,
  id: string,
  date: string,
  input: unknown,
) {
  const series = await findPatrolSeries(db, actor, id);
  const parsed = patrolTemplateSchema.safeParse(
    withEventSettings(
      input,
      patrolTemplateFor(series, await readTemplates(db, id), date),
    ),
  );
  return parsed.success ? parsed.data : null;
}

export async function updatePatrolSeriesFrom(
  db: Env["DB"],
  actor: Actor,
  id: string,
  occurrenceDate: string,
  input: unknown,
  version: number,
  notify = false,
  scope: SeriesScope = "future",
) {
  requireOrganizer(actor);
  const series = await findPatrolSeries(db, actor, id);
  const templates = await readTemplates(db, id);
  const schedule = seriesScheduleSchema.safeParse(input);
  if (!schedule.success)
    throw new RequestError(
      400,
      "Choose a weekly interval from 1 to 8 and a valid last date.",
    );
  const {
    intervalWeeks: _interval,
    endDate: _endDate,
    ...templateInput
  } = Object.fromEntries(
    Object.entries(input && typeof input === "object" ? input : {}).filter(
      ([, value]) => value !== undefined,
    ),
  );
  await requireScheduledDate(db, series, templates, occurrenceDate);
  const started = await db
    .prepare(
      `SELECT 1 FROM event WHERE series_id = ? AND occurrence_date = ? AND starts_at <= ${nowMsSql}`,
    )
    .bind(id, occurrenceDate)
    .first();
  if (started)
    throw new RequestError(
      409,
      "This event has started, so it can no longer be edited. Reload the page.",
    );
  const date = await scopeDate(db, id, occurrenceDate, scope);
  // Only the fields the organizer changed are sent; the rest keep the series
  // values, so one date's separate edits never spread to the others.
  const base = patrolTemplateFor(series, templates, date);
  const parsed = patrolTemplateSchema.safeParse({
    localTime: base.localTime,
    dayOffset: base.dayOffset,
    meetingPoint: base.meetingPoint,
    meetingPointUrl: base.meetingPointUrl ?? "",
    spots: base.spots,
    minMedicSpots: base.minMedicSpots,
    minNewVolunteerSpots: base.minNewVolunteerSpots,
    maxNewVolunteers: base.maxNewVolunteers,
    unregisterMinutes: base.unregisterMinutes,
    open: Boolean(base.open),
    hidden: Boolean(base.hidden),
    includesOrientation: Boolean(base.includesOrientation),
    ...templateInput,
  });
  if (!parsed.success)
    throw new RequestError(
      400,
      parsed.error.issues.find(
        (issue) => issue.message === orientationCapacityMessage,
      )?.message ??
        "Check the recurring time, date offset, capacity, meeting point and HTTPS map link.",
    );
  const data = parsed.data;
  if (templateStart(date, data) <= Date.now())
    throw new RequestError(400, "Choose a future recurring date and time.");
  const endDate =
    schedule.data.endDate === undefined
      ? series.endDate
      : schedule.data.endDate;
  if (endDate !== null && endDate < date)
    throw new RequestError(
      400,
      scope === "all"
        ? "Choose a last date on or after the next upcoming date."
        : "Choose a last date on or after this date.",
    );
  const earlier = templates.filter((template) => template.effectiveDate < date);
  const current = seriesCadenceAt(series, templates, date);
  const intervalWeeks = schedule.data.intervalWeeks ?? current.intervalWeeks;
  // Keep the running cadence unless the interval changes here or a later
  // interval change is being replaced by this one.
  const restart =
    intervalWeeks !== current.intervalWeeks ||
    templates.some(
      (template) => template.effectiveDate > date && template.intervalWeeks,
    );
  const nextTemplates = [
    ...earlier,
    { effectiveDate: date, intervalWeeks: restart ? intervalWeeks : null },
  ];
  const now = Date.now();
  const operation = crypto.randomUUID();
  const rows = (
    await db
      .prepare(
        `SELECT id, occurrence_date AS date, starts_at AS startsAt,
        ${includesOrientationSql()} AS includesOrientation,
        ${separateEditSql()} AS edited FROM event e
    WHERE series_id = ? AND occurrence_date >= ? AND cancelled_at IS NULL AND starts_at > ${nowMsSql}`,
      )
      .bind(id, date)
      .all<{
        id: string;
        date: string;
        startsAt: number;
        includesOrientation: number;
        edited: number;
      }>()
  ).results;
  // Dates that already ran off the old cadence are kept, as before.
  const dropped = rows.flatMap((row) =>
    endDate !== null && row.date > endDate
      ? [{ ...row, email: patrolSeriesShortenedEmail }]
      : onCadence(series, templates, row.date) &&
          !onCadence(series, nextTemplates, row.date)
        ? [{ ...row, email: patrolSeriesRescheduledEmail }]
        : [],
  );
  // Dates a schedule change cancelled come back once the schedule includes
  // them again. Dates cancelled by hand stay cancelled.
  const returning = (
    await db
      .prepare(
        `SELECT e.id, e.occurrence_date AS date FROM event e
        WHERE e.series_id = ? AND e.occurrence_date >= ? AND e.cancelled_at IS NOT NULL AND e.starts_at > ${nowMsSql}
          AND NOT EXISTS(SELECT 1 FROM event_audit a WHERE a.event_id = e.id AND a.action = 'deleted')
          AND EXISTS(SELECT 1 FROM json_each((SELECT a.changed_fields FROM event_audit a
            WHERE a.event_id = e.id AND a.action = 'cancelled' ORDER BY a.created_at DESC LIMIT 1))
            WHERE value IN ('seriesSchedule', 'seriesEndDate'))`,
      )
      .bind(id, date)
      .all<{ id: string; date: string }>()
  ).results.filter(
    (row) =>
      (endDate === null || row.date <= endDate) &&
      (!series.stoppedFrom || row.date < series.stoppedFrom) &&
      onCadence(series, nextTemplates, row.date) &&
      templateStart(row.date, data) > now,
  );
  // Dropping the orientation from dates that keep it and have new
  // volunteers booked. "This and following" leaves separately edited dates.
  if (!data.includesOrientation)
    await assertOrientationKept(
      db,
      rows
        .filter(
          (row) =>
            row.includesOrientation &&
            !dropped.some((drop) => drop.id === row.id) &&
            (scope === "all" || !row.edited),
        )
        .map((row) => row.id),
    );
  const updates = [
    ...rows.filter((row) => !dropped.some((drop) => drop.id === row.id)),
    ...returning,
  ].map((row) => ({ id: row.id, startsAt: templateStart(row.date, data) }));
  const returningIds = JSON.stringify(returning.map((row) => row.id));
  const values = [
    data.localTime,
    data.dayOffset,
    data.meetingPoint,
    data.meetingPointUrl || null,
    data.spots,
    data.minMedicSpots,
    data.minNewVolunteerSpots,
    data.maxNewVolunteers,
    data.unregisterMinutes,
    Number(data.open),
    Number(data.hidden),
    Number(data.includesOrientation),
  ];
  const droppedIds = JSON.stringify(dropped.map((drop) => drop.id));
  try {
    const results = await db.batch([
      db
        .prepare(
          `UPDATE patrol_series SET end_date = ?, generation_until = 0, updated_at = ?
        WHERE id = ? AND updated_at = ? AND ${writePermission(true)}
          AND NOT EXISTS(SELECT 1 FROM event e WHERE e.series_id = patrol_series.id AND e.occurrence_date >= ?
            AND e.cancelled_at IS NULL AND e.starts_at > ${nowMsSql}
            AND e.id NOT IN (SELECT json_extract(j.value,'$.id') FROM json_each(?) j)
            AND e.id NOT IN (SELECT value FROM json_each(?)))`,
        )
        .bind(
          endDate,
          Math.max(now, series.updatedAt + 1),
          id,
          version,
          ...permissionValues(actor),
          date,
          JSON.stringify(updates),
          droppedIds,
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
          JSON.stringify([
            "effectiveDate",
            ...Object.keys(data),
            ...(restart ? ["intervalWeeks"] : []),
            ...(endDate !== series.endDate ? ["endDate"] : []),
          ]),
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
          `INSERT INTO patrol_series_template (id,series_id,effective_date,interval_weeks,local_time,day_offset,
         meeting_point,meeting_point_url,spots,min_medic_spots,min_new_volunteer_spots,max_new_volunteers,unregister_minutes,open,hidden,includes_orientation)
         SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM patrol_series_audit WHERE id = ?)`,
        )
        .bind(
          operation,
          id,
          date,
          restart ? intervalWeeks : null,
          ...values,
          operation,
        ),
      db
        .prepare(
          `INSERT INTO event_audit (id,event_id,actor_id,action,changed_fields,created_at)
        SELECT ? || ':restored:' || e.id,e.id,?,'restored','["cancelledAt","seriesSchedule"]',? FROM event e
        WHERE e.id IN (SELECT value FROM json_each(?)) AND e.cancelled_at IS NOT NULL
          AND EXISTS(SELECT 1 FROM patrol_series_audit WHERE id = ?)`,
        )
        .bind(operation, actor.id, now, returningIds, operation),
      db
        .prepare(
          `UPDATE event SET cancelled_at = NULL, open = ?, hidden = ?, updated_at = max(updated_at + 1, ?)
        WHERE EXISTS(SELECT 1 FROM event_audit a WHERE a.id = ? || ':restored:' || event.id)`,
        )
        .bind(Number(data.open), Number(data.hidden), now, operation),
      db
        .prepare(
          `INSERT INTO event_audit (id,event_id,actor_id,action,changed_fields,created_at)
        SELECT ? || ':' || e.id,e.id,?,'series_updated',?,? FROM event e JOIN json_each(?) j ON e.id = json_extract(j.value,'$.id')
        WHERE e.cancelled_at IS NULL AND e.starts_at > ${nowMsSql}
          -- Following events skip separate edits; all events replace them.
          AND (${scope === "all" ? `${separateEditSql()} OR` : `NOT ${separateEditSql()} AND (`} e.starts_at != json_extract(j.value,'$.startsAt') OR e.meeting_point != ? OR e.meeting_point_url IS NOT ? OR e.spots != ?
             OR e.min_medic_spots != ? OR e.min_new_volunteer_spots != ? OR e.max_new_volunteers != ? OR e.unregister_minutes != ?
             OR e.open != ? OR e.hidden != ? OR coalesce(e.includes_orientation, e.type = 'orientation') != ?)${scope === "all" ? "" : ")"}
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
         meeting_point = ?, meeting_point_url = ?, spots = ?, min_medic_spots = ?, min_new_volunteer_spots = ?, max_new_volunteers = ?, unregister_minutes = ?,
         open = ?, hidden = ?, includes_orientation = ?, updated_at = max(updated_at + 1, ?)
        WHERE EXISTS(SELECT 1 FROM event_audit a WHERE a.id = ? || ':' || event.id)
          AND id NOT IN (SELECT value FROM json_each(?))`,
        )
        .bind(
          JSON.stringify(updates),
          ...values.slice(2),
          now,
          operation,
          droppedIds,
        ),
      db
        .prepare(
          `INSERT INTO event_audit (id,event_id,actor_id,action,changed_fields,created_at)
        SELECT ? || ':' || e.id,e.id,?,'cancelled','["cancelledAt","seriesSchedule"]',? FROM event e
        WHERE e.id IN (SELECT value FROM json_each(?)) AND e.cancelled_at IS NULL AND e.starts_at > ${nowMsSql}
          AND EXISTS(SELECT 1 FROM patrol_series_audit WHERE id = ?)`,
        )
        .bind(operation, actor.id, now, droppedIds, operation),
      seriesNotifications(
        db,
        operation,
        now,
        notify,
        patrolSeriesChangedEmail(),
        Object.fromEntries([
          ...updates.map((update) => [
            update.id,
            patrolSeriesChangedEmail({
              startsAt: update.startsAt,
              includesOrientation: data.includesOrientation,
              meetingPoint: data.meetingPoint,
            }),
          ]),
          ...dropped.map((drop) => [
            drop.id,
            drop.email({
              startsAt: drop.startsAt,
              includesOrientation: Boolean(drop.includesOrientation),
            }),
          ]),
        ]),
      ),
      db
        .prepare(
          `UPDATE event SET cancelled_at = ?, open = 0, hidden = 1, updated_at = max(updated_at + 1, ?)
        WHERE id IN (SELECT value FROM json_each(?))
          AND EXISTS(SELECT 1 FROM event_audit a WHERE a.id = ? || ':' || event.id)`,
        )
        .bind(now, now, droppedIds, operation),
      db
        .prepare(
          `UPDATE signup SET status = 'cancelled', updated_at = ?
        WHERE status = 'confirmed' AND event_id IN (SELECT value FROM json_each(?))
          AND EXISTS(SELECT 1 FROM event_audit a WHERE a.id = ? || ':' || signup.event_id)`,
        )
        .bind(now, droppedIds, operation),
    ]);
    if (!results[0].meta.changes)
      throw new RequestError(
        409,
        "This recurring event or your organizer authorization changed. Reload before editing it.",
      );
    await ensurePatrolOccurrences(db, id);
    const restored = returning.length
      ? ` ${returning.length} ${returning.length === 1 ? "date fits the schedule again and was" : "dates fit the schedule again and were"} restored.`
      : "";
    return {
      operation,
      message: `${
        dropped.length
          ? `${scope === "all" ? "All events" : "This and following events"} saved. ${dropped.length} ${dropped.length === 1 ? "date no longer fits the schedule and was" : "dates no longer fit the schedule and were"} cancelled.`
          : `${scope === "all" ? "All events" : "This and following events"} saved. Individual exceptions and existing registrations were kept.`
      }${restored}`,
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
  fallback: EmailContent,
  dated: Record<string, EmailContent>,
) {
  return db
    .prepare(
      `INSERT INTO event_notification (id,operation_id,user_id,subject,body,created_at,delivery_to)
    SELECT lower(hex(randomblob(16))),?,s.user_id,
      coalesce(json_extract(dated.value,'$.subject'),?),coalesce(json_extract(dated.value,'$.text'),?),?,u.email FROM signup s
    JOIN user u ON u.id = s.user_id AND u.email_verified = 1
    LEFT JOIN json_each(?) dated ON dated.key = s.event_id
    WHERE s.status = 'confirmed' AND ? = 1
      AND EXISTS(SELECT 1 FROM event_audit a WHERE a.id = ? || ':' || s.event_id)`,
    )
    .bind(
      operation,
      fallback.subject,
      fallback.text,
      now,
      JSON.stringify(
        Object.fromEntries(
          Object.entries(dated).map(([id, email]) => [
            id,
            { subject: email.subject, text: email.text },
          ]),
        ),
      ),
      Number(notify),
      operation,
    );
}

/** Vancouver dates cannot be formatted in SQL. Events generated after this read
 * fall back to the undated message inside the atomic write.
 */
async function datedSeriesEmails(
  db: Env["DB"],
  seriesId: string,
  date: string,
  inclusive: boolean,
  email: (event: {
    startsAt: number;
    includesOrientation: boolean;
  }) => EmailContent,
) {
  const events = await db
    .prepare(
      `SELECT e.id, e.starts_at AS startsAt, ${includesOrientationSql()} AS includesOrientation FROM event e
      WHERE e.series_id = ? AND e.occurrence_date ${inclusive ? ">=" : ">"} ? AND e.cancelled_at IS NULL AND e.starts_at > ${nowMsSql}`,
    )
    .bind(seriesId, date)
    .all<{ id: string; startsAt: number; includesOrientation: number }>();
  return Object.fromEntries(
    events.results.map((event) => [
      event.id,
      email({
        startsAt: event.startsAt,
        includesOrientation: Boolean(event.includesOrientation),
      }),
    ]),
  );
}

/** Cancel from a date on: sets the last date to the day before, or stops for good
 * when nothing would remain. */
export async function stopPatrolSeries(
  db: Env["DB"],
  actor: Actor,
  id: string,
  date: string,
  version: number,
  reason = "",
  notify = false,
  scope: SeriesScope = "future",
) {
  return stopSeries(
    db,
    actor,
    id,
    date,
    version,
    reason,
    notify,
    "stopped",
    scope,
  );
}

/** Deleting a series stops all future dates, retaining snapshots and dependants. */
export async function deletePatrolSeries(
  db: Env["DB"],
  actor: Actor,
  id: string,
  version: number,
  notify = false,
) {
  const series = await findPatrolSeries(db, actor, id);
  return stopSeries(
    db,
    actor,
    id,
    series.firstDate,
    version,
    "",
    notify,
    "deleted",
  );
}

async function stopSeries(
  db: Env["DB"],
  actor: Actor,
  id: string,
  date: string,
  version: number,
  reason: string,
  notify: boolean,
  action: "stopped" | "deleted",
  scope: SeriesScope = "future",
) {
  requireOrganizer(actor);
  if (reason.length > 1000)
    throw new RequestError(400, "Keep the reason to 1000 characters or fewer.");
  const series = await findPatrolSeries(db, actor, id);
  await requireScheduledDate(
    db,
    series,
    await readTemplates(db, id),
    date,
    true,
  );
  date = await scopeDate(db, id, date, scope);
  // Cancelling following events sets the last date, which a later edit can
  // extend. Deleting, or cancelling before the first date, stops for good.
  const lastDate = addCalendarDays(date, -1);
  const field =
    action === "stopped" && lastDate >= series.firstDate
      ? "end_date"
      : "stopped_from";
  const reasonField = field === "end_date" ? "seriesEndDate" : "stoppedFrom";
  const dated = await datedSeriesEmails(db, id, date, true, (event) =>
    patrolSeriesStoppedEmail(reason, event),
  );
  const now = Date.now();
  const operation = crypto.randomUUID();
  const results = await db.batch([
    db
      .prepare(
        `UPDATE patrol_series SET ${field} = CASE WHEN ${field} IS NULL OR ${field} > ? THEN ? ELSE ${field} END,
      generation_until = 0, updated_at = ? WHERE id = ? AND updated_at = ? AND ${writePermission(true)}`,
      )
      .bind(
        field === "end_date" ? lastDate : date,
        field === "end_date" ? lastDate : date,
        Math.max(now, series.updatedAt + 1),
        id,
        version,
        ...permissionValues(actor),
      ),
    db
      .prepare(
        `INSERT INTO patrol_series_audit (id,series_id,actor_id,action,changed_fields,created_at)
       SELECT ?,?,?,?,?,? WHERE changes() = 1`,
      )
      .bind(
        operation,
        id,
        actor.id,
        action,
        JSON.stringify([field === "end_date" ? "endDate" : "stoppedFrom"]),
        now,
      ),
    db
      .prepare(
        `INSERT INTO event_audit (id,event_id,actor_id,action,changed_fields,created_at)
      SELECT ? || ':' || id,id,?,'cancelled',?,? FROM event
      WHERE series_id = ? AND occurrence_date >= ? AND cancelled_at IS NULL AND starts_at > ${nowMsSql}
        AND EXISTS(SELECT 1 FROM patrol_series_audit WHERE id = ?)`,
      )
      .bind(
        operation,
        actor.id,
        JSON.stringify(["cancelledAt", reasonField]),
        now,
        id,
        date,
        operation,
      ),
    seriesNotifications(
      db,
      operation,
      now,
      notify,
      patrolSeriesStoppedEmail(reason),
      dated,
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
      "This recurring event or your organizer authorization changed. Reload the page.",
    );
  await ensurePatrolOccurrences(db, id);
  return {
    operation,
    message:
      action === "deleted"
        ? "Series deleted. Future bookings were cancelled; registration and attendance history was kept."
        : scope === "all"
          ? "All upcoming events in this series and their registrations were cancelled. Past events were kept."
          : "This and following events and their registrations were cancelled. Earlier events were kept.",
  };
}

/** SQL alias is supplied only by backend code, never request input. */
export function recurringSignupWindowSql(alias = "e") {
  return `(${alias}.series_id IS NULL OR (
    ${alias}.cancelled_at IS NULL AND ${alias}.starts_at > ${nowMsSql}
    AND EXISTS(SELECT 1 FROM patrol_series ps WHERE ps.id = ${alias}.series_id
      AND ${alias}.starts_at < ps.generation_until)
  ))`;
}

// Stopped, shortened and off-cadence dates are not part of the schedule anymore.
const restorableSql = `(ps.stopped_from IS NULL OR e.occurrence_date < ps.stopped_from)
  AND (ps.end_date IS NULL OR e.occurrence_date <= ps.end_date)
  AND ${onCadenceSql("ps", "e.occurrence_date")}`;

/** A cancelled upcoming series date an organizer can still restore. */
export const restorableEventSql = (
  alias = "e",
) => `(${alias}.series_id IS NOT NULL
  AND ${alias}.cancelled_at IS NOT NULL AND ${alias}.starts_at > ${nowMsSql}
  AND NOT EXISTS(SELECT 1 FROM event_audit a WHERE a.event_id = ${alias}.id AND a.action = 'deleted')
  AND EXISTS(SELECT 1 FROM patrol_series ps WHERE ps.id = ${alias}.series_id
    AND NOT EXISTS(SELECT 1 FROM patrol_series_audit a WHERE a.series_id = ps.id AND a.action = 'deleted')
    AND ${restorableSql.replaceAll("e.occurrence_date", `${alias}.occurrence_date`)}))`;

/** Reopen a cancelled future date with its series' visibility. Bookings stay cancelled. */
export async function restorePatrolOccurrence(
  db: Env["DB"],
  actor: Actor,
  id: string,
  version: number,
) {
  requireOrganizer(actor);
  const event = await db
    .prepare(
      `SELECT e.series_id AS seriesId, e.occurrence_date AS occurrenceDate,
        e.cancelled_at AS cancelledAt, e.starts_at AS startsAt, ${restorableSql} AS restorable,
        ${separateEditSql()} AS edited
      FROM event e JOIN patrol_series ps ON ps.id = e.series_id
      WHERE e.id = ?
        AND NOT EXISTS(SELECT 1 FROM event_audit a WHERE a.event_id = e.id AND a.action = 'deleted')`,
    )
    .bind(id)
    .first<{
      seriesId: string;
      occurrenceDate: string;
      cancelledAt: number | null;
      startsAt: number;
      restorable: number;
      edited: number;
    }>();
  if (!event) throw new RequestError(404, "Event not found.");
  const series = await findPatrolSeries(db, actor, event.seriesId);
  if (event.cancelledAt === null)
    throw new RequestError(409, "This date is not cancelled. Reload the page.");
  if (event.startsAt <= Date.now())
    throw new RequestError(409, "Past dates cannot be restored.");
  if (!event.restorable)
    throw new RequestError(409, "This date is no longer part of the series.");
  const template = patrolTemplateFor(
    series,
    await readTemplates(db, series.id),
    event.occurrenceDate,
  );
  const now = Date.now();
  // Series changes made while it was cancelled apply now, unless it was edited on its own.
  const startsAt = event.edited
    ? event.startsAt
    : templateStart(event.occurrenceDate, template);
  if (startsAt <= now)
    throw new RequestError(409, "Past dates cannot be restored.");
  const details = event.edited
    ? []
    : [
        template.meetingPoint,
        template.meetingPointUrl,
        template.spots,
        template.minMedicSpots,
        template.minNewVolunteerSpots,
        template.maxNewVolunteers,
        template.unregisterMinutes,
        template.includesOrientation,
      ];
  const operation = crypto.randomUUID();
  const results = await db.batch([
    db
      .prepare(
        `UPDATE event SET cancelled_at = NULL, open = ?, hidden = ?, starts_at = ?,
        ${event.edited ? "" : "meeting_point = ?, meeting_point_url = ?, spots = ?, min_medic_spots = ?, min_new_volunteer_spots = ?, max_new_volunteers = ?, unregister_minutes = ?, includes_orientation = ?,"}
        updated_at = max(updated_at + 1, ?)
      WHERE id = ? AND updated_at = ? AND cancelled_at IS NOT NULL AND starts_at > ${nowMsSql}
        AND ${writePermission(true)}`,
      )
      .bind(
        template.open,
        template.hidden,
        startsAt,
        ...details,
        now,
        id,
        version,
        ...permissionValues(actor),
      ),
    db
      .prepare(
        `INSERT INTO event_audit (id,event_id,actor_id,action,changed_fields,created_at)
      SELECT ?,?,?,'restored',?,? WHERE changes() = 1`,
      )
      .bind(
        operation,
        id,
        actor.id,
        JSON.stringify([
          "cancelledAt",
          "open",
          "hidden",
          ...(event.edited ? [] : ["startsAt", "seriesTemplate"]),
        ]),
        now,
      ),
  ]);
  if (!results[0].meta.changes)
    throw new RequestError(
      409,
      "This date or your organizer authorization changed. Reload the page.",
    );
  return {
    operation,
    message: "Date restored. Earlier registrations stay cancelled.",
  };
}
