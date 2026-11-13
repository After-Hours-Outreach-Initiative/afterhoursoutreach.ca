import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, test, vi } from "vitest";
import { createTestHarness } from "wrangler";
import {
  addCalendarDays,
  vancouverInput,
  vancouverOccurrenceInstant,
} from "../src/data/event-time";
import type { Actor } from "../src/server/db/access";
import {
  cancelEvent,
  deleteEvent,
  deletePatrolSeries,
  listPatrolSeries,
  changeSignup,
  addManualSignup,
  ensurePatrolOccurrences,
  findEvent,
  findPatrolSeries,
  listEvents,
  listRosters,
  listPublicRosters,
  manageSignup,
  patrolOccurrenceId,
  patrolTemplateFor,
  restorePatrolOccurrence,
  saveEvent,
  bulkSaveEvents,
  savePatrolSeries,
  updatePatrolSeriesFrom,
  stopPatrolSeries,
  listPatrolTemplates,
} from "../src/server/db/events";
import {
  planPatrolOccurrences,
  recurringHorizon,
  type PatrolTemplate,
} from "../src/server/db/patrol-series";
import { RequestError } from "../src/server/http";
import { listAuditLog } from "../src/server/db/audit-log";
import { setVolunteerStatus } from "../src/server/db/volunteers";
import { sourceSchemaStatements } from "./helpers/source-schema";

vi.stubEnv("DEV", false);
vi.stubEnv("PROD", true);

const harness = createTestHarness({
  workers: [
    {
      config: {
        name: "recurring-patrols-test",
        compatibility_date: "2026-08-16",
        main: fileURLToPath(
          new URL("./helpers/recurring-worker.mjs", import.meta.url),
        ),
        d1_databases: [
          {
            binding: "DB",
            database_name: "recurring-patrols-test",
            database_id: "00000000-0000-0000-0000-000000000000",
            remote: false,
          },
        ],
      },
    },
  ],
});
let db: Env["DB"];
let organizer: Actor;
let alice: Actor;
let bob: Actor;
const tomorrow = () =>
  addCalendarDays(vancouverInput(Date.now()).slice(0, 10), 1);
const input = () => ({
  firstDate: tomorrow(),
  localTime: "20:30",
  intervalWeeks: 2,
  endDate: null as string | null,
  meetingPoint: "Meeting point",
  meetingPointUrl: "",
  spots: 4,
  open: true,
  hidden: false,
});
const status = (expected: number) => (error: unknown) =>
  error instanceof RequestError && error.status === expected;
const count = (table: string) =>
  db.prepare(`SELECT count(*) AS n FROM ${table}`).first<number>("n");
const window = async () =>
  (await listEvents(db, alice)).filter((event) => event.seriesId);
const all = async (seriesId: string) =>
  (await listEvents(db, organizer)).filter(
    (event) => event.seriesId === seriesId,
  );
/** Insert one date beyond the two-month window, as generation will later. */
const distantDate = async (seriesId: string, date: string) => {
  const series = await findPatrolSeries(db, organizer, seriesId);
  const template = patrolTemplateFor(
    series,
    await listPatrolTemplates(db, organizer, seriesId),
    date,
  );
  const id = patrolOccurrenceId(seriesId, date);
  await db
    .prepare(
      `INSERT INTO event (id,type,series_id,occurrence_date,starts_at,meeting_point,meeting_point_url,
      spots,min_medic_spots,min_new_volunteer_spots,max_new_volunteers,unregister_minutes,
      open,hidden,includes_orientation,created_by,created_at,updated_at)
      VALUES (?,'patrol',?,?,?,?,?,?,?,?,?,?,?,?,?,'organizer',?,?)`,
    )
    .bind(
      id,
      seriesId,
      date,
      vancouverOccurrenceInstant(
        addCalendarDays(date, template.dayOffset),
        template.localTime,
      ),
      template.meetingPoint,
      template.meetingPointUrl,
      template.spots,
      template.minMedicSpots,
      template.minNewVolunteerSpots,
      template.maxNewVolunteers,
      template.unregisterMinutes,
      template.open,
      template.hidden,
      template.includesOrientation,
      Date.now(),
      Date.now(),
    )
    .run();
  return { id };
};

test("recurring patrols persist custom volunteer limits on generated occurrences", async () => {
  const limits = {
    minMedicSpots: 1,
    minNewVolunteerSpots: 1,
    maxNewVolunteers: 2,
  };
  const saved = await savePatrolSeries(db, organizer, {
    ...input(),
    includesOrientation: true,
    ...limits,
  });
  const series = await findPatrolSeries(db, organizer, saved.id);
  const occurrences = await all(saved.id);
  assert.equal(occurrences.length, 5);
  for (const settings of [series, ...occurrences])
    assert.deepEqual(
      [
        settings.minMedicSpots,
        settings.minNewVolunteerSpots,
        settings.maxNewVolunteers,
      ],
      [1, 1, 2],
    );
});

beforeAll(async () => {
  await harness.listen();
  db = (await harness.getWorker<Pick<Env, "DB">>().getEnv()).DB;
}, 60_000);
afterAll(async () => {
  await harness.close();
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
  // Clear isolated test state, including deliberate permanent tombstones.
  if (triggers.length)
    await db.batch(
      triggers.map(({ name }) => db.prepare(`DROP TRIGGER "${name}"`)),
    );
  // Defer references until every table has been removed in this transaction.
  await db.batch([
    db.prepare("PRAGMA defer_foreign_keys=ON"),
    ...tables.map(({ name }) => db.prepare(`DROP TABLE "${name}"`)),
  ]);
  await db.batch(
    sourceSchemaStatements().map((statement) => db.prepare(statement)),
  );
  const actors: Actor[] = [];
  for (const id of ["organizer", "alice", "bob"]) {
    const role = id === "organizer" ? "organizer" : "volunteer";
    await db.batch([
      db
        .prepare(
          "INSERT INTO user (id,name,email,email_verified,role,created_at,updated_at) VALUES (?,?,?,1,?,0,0)",
        )
        .bind(id, id, `${id}@example.org`, role),
      db
        .prepare(
          `INSERT INTO profile (user_id,preferred_name,phone,birth_date,emergency_contact_name,
        emergency_contact_phone,emergency_contact_relationship,heard_about_us,motivation,teams,
        medical_certification,training_experience,registered_at,updated_at)
        VALUES (?,?,'555','2000-01-01','Contact','555','Friend','Friend','Help','[]','None','None',0,0)`,
        )
        .bind(id, id),
      db
        .prepare(
          "INSERT INTO volunteer_status (user_id,active,registration_approved,patrol_approved,approved_by,approved_at,updated_at) VALUES (?,1,1,1,'organizer',0,0)",
        )
        .bind(id),
      db
        .prepare(
          "INSERT INTO session (id,user_id,token,expires_at,created_at,updated_at) VALUES (?,?,?,?,0,0)",
        )
        .bind(`${id}-session`, id, `${id}-token`, Date.now() + 86_400_000),
    ]);
    actors.push({
      id,
      role,
      name: id,
      sessionId: `${id}-session`,
      applicationSubmitted: true,
      applicationComplete: false,
      naloxoneCompleted: false,
      applicationApproved: true,
      patrolApproved: true,
      active: true,
      twoFactorEnabled: false,
      twoFactorVerified: false,
    });
  }
  [organizer, alice, bob] = actors;
});

test("fortnightly dates within two months preserve local wall time; the next date enters with the horizon", () => {
  const series = {
    firstDate: "2026-10-20",
    localTime: "20:30",
    intervalWeeks: 2,
    endDate: null,
  };
  const first = vancouverOccurrenceInstant(series.firstDate, series.localTime);
  const initial = planPatrolOccurrences(series, [], first - 1);
  assert.deepEqual(
    initial.occurrences.map((event) => event.date),
    ["2026-10-20", "2026-11-03", "2026-11-17", "2026-12-01", "2026-12-15"],
  );
  assert.deepEqual(
    initial.occurrences.map((event) => new Date(event.startsAt).toISOString()),
    [
      "2026-10-21T03:30:00.000Z",
      "2026-11-04T03:30:00.000Z",
      "2026-11-18T03:30:00.000Z",
      "2026-12-02T03:30:00.000Z",
      "2026-12-16T03:30:00.000Z",
    ],
  );
  assert.equal(
    initial.generationUntil,
    vancouverOccurrenceInstant("2026-12-20", "00:00"),
  );
  const existing = initial.occurrences.map((event) => ({
    occurrenceDate: event.date,
    startsAt: event.startsAt,
    cancelledAt: null,
  }));
  assert.deepEqual(
    planPatrolOccurrences(
      series,
      existing,
      vancouverOccurrenceInstant("2026-10-29", "23:59"),
    ).occurrences,
    [],
  );
  assert.deepEqual(
    planPatrolOccurrences(
      series,
      existing,
      vancouverOccurrenceInstant("2026-10-30", "00:00"),
    ).occurrences.map((event) => event.date),
    ["2026-12-29"],
  );
  assert.deepEqual(
    planPatrolOccurrences(
      { ...series, endDate: "2026-11-03" },
      [],
      first - 1,
    ).occurrences.map((event) => event.date),
    ["2026-10-20", "2026-11-03"],
  );
  // Shorter months clamp the horizon to their last day.
  assert.equal(
    recurringHorizon(vancouverOccurrenceInstant("2026-12-31", "12:00")),
    vancouverOccurrenceInstant("2027-02-28", "00:00"),
  );
});

test("bulk event edits guard all versions/permissions and roll back policy conflicts, audits and mail", async () => {
  const series = await savePatrolSeries(db, organizer, input());
  const rows = await all(series.id);
  const selection = rows
    .slice(0, 2)
    .map((row) => ({ id: row.id, version: row.updatedAt }));
  const snapshot = async () =>
    (await db.prepare("SELECT * FROM event ORDER BY id").all()).results;
  const before = await snapshot();
  const audits = (await count("event_audit"))!;
  await changeSignup(db, alice, selection[1].id, "join");
  // One selected event cannot fit its booking plus reserved medic places.
  await assert.rejects(
    bulkSaveEvents(
      db,
      organizer,
      { selection, changes: { spots: 2, meetingPoint: "Must roll back" } },
      true,
    ),
    status(409),
  );
  assert.deepEqual(await snapshot(), before);
  assert.equal(await count("event_audit"), audits + 1); // signup audit only
  assert.equal(await count("event_notification"), 0);
  // Race AFTER the initial read: a stale unchanged target must block the others.
  const racing = (write: () => Promise<unknown>) =>
    new Proxy(db, {
      get(target, key) {
        if (key === "batch")
          return async (statements: D1PreparedStatement[]) => {
            await write();
            return target.batch(statements);
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  const stale = racing(async () => {
    await db
      .prepare("UPDATE event SET updated_at=updated_at+1 WHERE id=?")
      .bind(selection[1].id)
      .run();
  });
  await assert.rejects(
    bulkSaveEvents(
      stale,
      organizer,
      { selection, changes: { meetingPoint: "Must not save" } },
      true,
    ),
    status(409),
  );
  assert.equal(
    (await findEvent(db, selection[0].id)).meetingPoint,
    "Meeting point",
  );
  assert.equal(await count("event_audit"), audits + 1);
  assert.equal(await count("event_notification"), 0);
  selection[1].version++;
  const revoked = racing(async () => {
    await db
      .prepare("UPDATE session SET expires_at=0 WHERE id=?")
      .bind(organizer.sessionId)
      .run();
  });
  await assert.rejects(
    bulkSaveEvents(revoked, organizer, {
      selection,
      changes: { hidden: true },
    }),
    status(409),
  );
  assert.equal((await findEvent(db, selection[0].id)).hidden, 0);
  assert.equal(await count("event_audit"), audits + 1);
});

test("bulk event edits change only chosen existing occurrences, preserve dates/templates, and use a retryable notification operation", async () => {
  const series = await savePatrolSeries(db, organizer, input());
  const rows = await all(series.id);
  const selection = rows
    .slice(0, 2)
    .map((row) => ({ id: row.id, version: row.updatedAt }));
  await changeSignup(db, alice, selection[0].id, "join");
  await changeSignup(db, alice, selection[1].id, "join");
  const templates = await listPatrolTemplates(db, organizer, series.id);
  const changes = {
    meetingPoint: "Shared meeting point",
    meetingPointUrl: "",
    open: false,
    hidden: true,
  };
  for (const invalid of [
    { selection: [], changes },
    { selection: [selection[0], selection[0]], changes },
    {
      selection: Array.from({ length: 101 }, (_, i) => ({
        id: `event-${i}`,
        version: 0,
      })),
      changes,
    },
    { selection, changes: {} },
    { selection, changes: { startsAt: new Date().toISOString() } },
  ])
    await assert.rejects(bulkSaveEvents(db, organizer, invalid), status(400));
  await assert.rejects(
    bulkSaveEvents(db, alice, { selection, changes }),
    status(403),
  );
  const result = await bulkSaveEvents(
    db,
    organizer,
    { selection, changes },
    true,
  );
  assert.ok(
    await db
      .prepare("SELECT id FROM event_audit WHERE id=?")
      .bind(result.operation)
      .first(),
  );
  assert.equal(
    await db
      .prepare(
        "SELECT count(*) AS n FROM event_notification WHERE operation_id=?",
      )
      .bind(result.operation)
      .first("n"),
    2,
  );
  for (const row of rows) {
    const after = await findEvent(db, row.id);
    assert.equal(after.startsAt, row.startsAt);
    assert.equal(after.spots, row.spots);
    assert.equal(after.includesOrientation, row.includesOrientation);
    assert.equal(
      after.meetingPoint,
      selection.some((target) => target.id === row.id)
        ? changes.meetingPoint
        : row.meetingPoint,
    );
  }
  assert.deepEqual(
    await listPatrolTemplates(db, organizer, series.id),
    templates,
  );
  await assert.rejects(
    bulkSaveEvents(db, organizer, { selection, changes: { spots: 8 } }),
    status(409),
  );
});

test("bulk start times move each selected event on its own Vancouver date", async () => {
  const series = await savePatrolSeries(db, organizer, input());
  const rows = (await all(series.id)).slice(0, 2);
  const selection = rows.map((row) => ({ id: row.id, version: row.updatedAt }));
  for (const startTime of ["25:00", "8:15"])
    await assert.rejects(
      bulkSaveEvents(db, organizer, { selection, changes: { startTime } }),
      status(400),
    );
  const result = await bulkSaveEvents(db, organizer, {
    selection,
    changes: { startTime: "18:15" },
  });
  assert.ok(result.operation);
  for (const row of rows)
    assert.equal(
      vancouverInput((await findEvent(db, row.id)).startsAt),
      `${vancouverInput(row.startsAt).slice(0, 10)}T18:15`,
    );
});

test("spring/fall recurrence DST policy is deterministic, including gaps and folds", () => {
  assert.equal(
    new Date(vancouverOccurrenceInstant("2026-03-08", "02:30")).toISOString(),
    "2026-03-08T10:30:00.000Z",
  );
  assert.equal(
    new Date(vancouverOccurrenceInstant("2025-11-02", "01:30")).toISOString(),
    "2025-11-02T08:30:00.000Z",
  );
  assert.equal(
    vancouverInput(vancouverOccurrenceInstant("2026-03-15", "02:30")),
    "2026-03-15T02:30",
  );
  assert.throws(() => vancouverOccurrenceInstant("2026-02-30", "02:30"));
});

test("effective day shifts plan every start before the two-month horizon across template boundaries", () => {
  const firstDate = "2026-10-20";
  const series = {
    firstDate,
    localTime: "20:30",
    intervalWeeks: 1,
    endDate: "2027-12-31",
  };
  const now = vancouverOccurrenceInstant("2026-10-21", "12:00");
  for (const [one, two] of [
    [35, -28],
    [-28, 35],
    [366, -366],
    [-366, 366],
    [0, 0],
  ]) {
    const templates: PatrolTemplate[] = [one, two].map((dayOffset, index) => ({
      effectiveDate: addCalendarDays(firstDate, index === 0 ? 14 : 42),
      localTime: "21:15",
      dayOffset,
      meetingPoint: "Point",
      meetingPointUrl: null,
      spots: 8,
      open: 1,
      hidden: 0,
      includesOrientation: 0,
      minMedicSpots: 2,
      minNewVolunteerSpots: 2,
      maxNewVolunteers: 4,
      unregisterMinutes: 30,
    }));
    const candidates = Array.from({ length: 63 }, (_, index) => {
      const date = addCalendarDays(firstDate, index * 7);
      const template = templates
        .filter((item) => item.effectiveDate <= date)
        .at(-1);
      return {
        date,
        startsAt: vancouverOccurrenceInstant(
          addCalendarDays(date, template?.dayOffset ?? 0),
          template?.localTime ?? series.localTime,
        ),
      };
    }).filter((event) => event.date <= series.endDate && event.startsAt > now);
    candidates.sort((a, b) => a.startsAt - b.startsAt);
    const plan = planPatrolOccurrences(series, [], now, templates);
    const horizon = recurringHorizon(now);
    assert.deepEqual(
      plan.occurrences.map((event) => event.date).sort(),
      candidates
        .filter((event) => event.startsAt < horizon)
        .map((event) => event.date)
        .sort(),
    );
    assert.equal(plan.generationUntil, horizon);
  }
});

test("concurrent D1 generation is idempotent and creates independent occurrence IDs, rosters, capacity and audits", async () => {
  const series = await savePatrolSeries(db, organizer, input());
  const original = await all(series.id);
  await Promise.all(
    Array.from({ length: 8 }, () => ensurePatrolOccurrences(db)),
  );
  assert.deepEqual(await all(series.id), original);
  assert.equal(original.length, 5);
  assert.equal(new Set(original.map((event) => event.id)).size, 5);
  assert.equal(
    original[0].id,
    patrolOccurrenceId(series.id, original[0].occurrenceDate!),
  );
  assert.equal(await count("event_audit"), 5);
  await changeSignup(db, alice, original[0].id, "join");
  await changeSignup(db, bob, original[1].id, "join");
  const rosters = await listRosters(
    db,
    organizer,
    original.map((event) => event.id),
  );
  assert.deepEqual(
    rosters.map((row) => [row.eventId, row.userId]).sort(),
    [
      [original[0].id, "alice"],
      [original[1].id, "bob"],
    ].sort(),
  );
  await changeSignup(db, alice, original[0].id, "cancel");
  assert.equal((await findEvent(db, original[1].id)).cancelledAt, null);
  assert.equal(await count("signup"), 2);
  await assert.rejects(changeSignup(db, alice, series.id, "join"), status(404));
});

test("simultaneous maintenance after a start creates no extra dates", async () => {
  const series = await savePatrolSeries(db, organizer, input());
  const first = (await all(series.id))[0];
  await db
    .prepare("UPDATE event SET starts_at=0 WHERE id=?")
    .bind(first.id)
    .run();
  await Promise.all(
    Array.from({ length: 12 }, () => ensurePatrolOccurrences(db)),
  );
  assert.equal((await window()).length, 4);
  assert.equal((await all(series.id)).length, 5);
  assert.equal(await count("event_audit"), 5);
});

test("each series generates two months of dates and cancelled dates are not recreated", async () => {
  const data = input();
  const one = await savePatrolSeries(db, organizer, data);
  const two = await savePatrolSeries(db, organizer, {
    ...data,
    intervalWeeks: 1,
  });
  assert.equal(
    (await window()).filter((event) => event.seriesId === one.id).length,
    5,
  );
  assert.equal(
    (await window()).filter((event) => event.seriesId === two.id).length,
    9,
  );
  for (const event of await all(one.id))
    await cancelEvent(
      db,
      organizer,
      event.id,
      event.updatedAt,
      "Skip these dates",
    );
  await ensurePatrolOccurrences(db);
  assert.equal(
    (await window()).filter((event) => event.seriesId === one.id).length,
    0,
  );
  assert.equal(
    await db
      .prepare(
        "SELECT count(*) n FROM event WHERE series_id=? AND cancelled_at IS NOT NULL",
      )
      .bind(one.id)
      .first("n"),
    5,
  );
  assert.equal(
    (await window()).filter((event) => event.seriesId === two.id).length,
    9,
  );
});

test("dates beyond two months are rejected by direct join, SQL reactivation/reassignment, and organizer moves, with rollback", async () => {
  const data = input();
  const series = await savePatrolSeries(db, organizer, data);
  const first = (await all(series.id))[0];
  const fourth = await distantDate(
    series.id,
    addCalendarDays(data.firstDate, 84),
  );
  assert.equal((await findEvent(db, fourth.id)).inSignupWindow, 0);
  assert.equal((await window()).length, 5);
  await assert.rejects(changeSignup(db, alice, fourth.id, "join"), status(409));
  await changeSignup(db, alice, first.id, "join");
  const signupId = await db
    .prepare(
      "SELECT id FROM signup WHERE user_id='alice' AND status='confirmed'",
    )
    .first<string>("id");
  await assert.rejects(
    manageSignup(db, organizer, signupId!, fourth.id, "move"),
    status(409),
  );
  assert.equal(
    await db
      .prepare("SELECT status FROM signup WHERE id=?")
      .bind(signupId)
      .first("status"),
    "confirmed",
  );
  await assert.rejects(
    db
      .prepare("UPDATE signup SET event_id=? WHERE id=?")
      .bind(fourth.id, signupId)
      .run(),
    /recurring_signup_window/,
  );
  await db
    .prepare(
      "INSERT INTO signup (id,event_id,user_id,status,created_at,updated_at) VALUES ('cancelled',?,'bob','cancelled',0,0)",
    )
    .bind(fourth.id)
    .run();
  await assert.rejects(
    db
      .prepare("UPDATE signup SET status='confirmed' WHERE id='cancelled'")
      .run(),
    /recurring_signup_window/,
  );
  await assert.rejects(
    db
      .prepare(
        "INSERT INTO signup (id,event_id,user_id,created_at,updated_at) VALUES ('direct',?,'bob',0,0)",
      )
      .bind(fourth.id)
      .run(),
    /recurring_signup_window/,
  );
});

test("manual attendees obey recurring windows and keep their history when the series stops", async () => {
  const data = { ...input(), includesOrientation: true, spots: 8 };
  const saved = await savePatrolSeries(db, organizer, data);
  const first = (await all(saved.id))[0];
  const fourth = await distantDate(
    saved.id,
    addCalendarDays(data.firstDate, 84),
  );
  const attendee = { name: "Manual Medic", medic: true, newVolunteer: true };
  await assert.rejects(
    addManualSignup(db, organizer, fourth.id, attendee),
    status(409),
  );
  await addManualSignup(db, organizer, first.id, attendee);
  const signup = (await listRosters(db, organizer, [first.id]))[0];
  await assert.rejects(
    manageSignup(db, organizer, signup.id, fourth.id, ""),
    status(409),
  );
  assert.equal(
    await db
      .prepare("SELECT status FROM signup WHERE id=?")
      .bind(signup.id)
      .first("status"),
    "confirmed",
  );
  const series = await findPatrolSeries(db, organizer, saved.id);
  await stopPatrolSeries(
    db,
    organizer,
    saved.id,
    first.occurrenceDate!,
    series.updatedAt,
    "",
    true,
  );
  assert.equal(
    await db
      .prepare("SELECT status FROM signup WHERE id=?")
      .bind(signup.id)
      .first("status"),
    "cancelled",
  );
  assert.equal(await count("signup"), 1);
  assert.equal(await count("event_notification"), 0);
});

test("closed, full and hidden occurrences reject signups; hidden recurring occurrences are invisible even with a booking", async () => {
  const data = input();
  const series = await savePatrolSeries(db, organizer, data);
  const events = await all(series.id);
  const fourth = await distantDate(
    series.id,
    addCalendarDays(data.firstDate, 84),
  );
  await changeSignup(db, alice, events[0].id, "join");
  await db.batch([
    db.prepare("UPDATE event SET hidden=1 WHERE id=?").bind(events[0].id),
    db.prepare("UPDATE event SET open=0 WHERE id=?").bind(events[1].id),
    db.prepare("UPDATE event SET spots=3 WHERE id=?").bind(events[2].id),
  ]);
  await changeSignup(db, alice, events[2].id, "join");
  assert.deepEqual(
    (await window()).map((event) => event.id),
    events.slice(1).map((event) => event.id),
  );
  assert.equal((await findEvent(db, fourth.id)).inSignupWindow, 0);
  await assert.rejects(
    changeSignup(db, bob, events[0].id, "join"),
    status(403),
  );
  await assert.rejects(
    changeSignup(db, bob, events[1].id, "join"),
    status(403),
  );
  await assert.rejects(
    changeSignup(db, bob, events[2].id, "join"),
    status(409),
  );
  await assert.rejects(changeSignup(db, bob, fourth.id, "join"), status(409));
  assert.equal(await count("signup"), 2);
});

test("cancellation cancels only that roster, is not regenerated, and can be restored without its bookings", async () => {
  const series = await savePatrolSeries(db, organizer, input());
  const events = await all(series.id);
  await changeSignup(db, alice, events[0].id, "join");
  await changeSignup(db, alice, events[1].id, "join");
  await cancelEvent(
    db,
    organizer,
    events[0].id,
    events[0].updatedAt,
    "Cancelled",
  );
  await Promise.all(
    Array.from({ length: 5 }, () => ensurePatrolOccurrences(db)),
  );
  assert.equal((await window()).length, 4);
  assert.equal((await all(series.id)).length, 4);
  assert.equal(await count("signup"), 2);
  const rows = (
    await db
      .prepare(
        "SELECT event_id AS eventId,status FROM signup ORDER BY event_id",
      )
      .all<{ eventId: string; status: string }>()
  ).results;
  assert.equal(
    rows.find((row) => row.eventId === events[0].id)?.status,
    "cancelled",
  );
  assert.equal(
    rows.find((row) => row.eventId === events[1].id)?.status,
    "confirmed",
  );
  await assert.rejects(
    db.prepare("DELETE FROM event WHERE id=?").bind(events[0].id).run(),
    /recurring_occurrence_tombstone/,
  );
  await assert.rejects(
    db
      .prepare("UPDATE event SET cancelled_at=1 WHERE id=?")
      .bind(events[0].id)
      .run(),
    /recurring_occurrence_tombstone/,
  );
  const cancelled = await findEvent(db, events[0].id);
  await assert.rejects(
    restorePatrolOccurrence(db, alice, events[0].id, cancelled.updatedAt),
    status(403),
  );
  await assert.rejects(
    restorePatrolOccurrence(
      db,
      organizer,
      events[0].id,
      cancelled.updatedAt + 1,
    ),
    status(409),
  );
  await assert.rejects(
    restorePatrolOccurrence(db, organizer, events[1].id, events[1].updatedAt),
    status(409),
  );
  await restorePatrolOccurrence(
    db,
    organizer,
    events[0].id,
    cancelled.updatedAt,
  );
  const restored = await findEvent(db, events[0].id);
  assert.equal(restored.cancelledAt, null);
  assert.equal(restored.open, 1);
  assert.equal(restored.hidden, 0);
  assert.equal(restored.inSignupWindow, 1);
  assert.equal((await window()).length, 5);
  assert.equal(
    await db
      .prepare("SELECT status FROM signup WHERE event_id=?")
      .bind(events[0].id)
      .first("status"),
    "cancelled",
  );
  assert.ok(
    (await listAuditLog(db, organizer)).entries.some(
      (entry) =>
        entry.subjectId === events[0].id && entry.action === "restored",
    ),
  );
  await changeSignup(db, alice, events[0].id, "join");
  await db
    .prepare("UPDATE event SET starts_at=0 WHERE id=?")
    .bind(events[2].id)
    .run();
  await cancelEvent(db, organizer, events[3].id, events[3].updatedAt, "");
  await db
    .prepare("UPDATE event SET starts_at=0 WHERE id=?")
    .bind(events[3].id)
    .run();
  await assert.rejects(
    restorePatrolOccurrence(
      db,
      organizer,
      events[3].id,
      (await findEvent(db, events[3].id)).updatedAt,
    ),
    status(409),
  );
  await assert.rejects(
    db
      .prepare("UPDATE event SET cancelled_at=NULL WHERE id=?")
      .bind(events[3].id)
      .run(),
    /recurring_occurrence_tombstone/,
  );
});

test("legacy deletion uses versioned cancellation and retains registered occurrences outside event lists without regeneration", async () => {
  const series = await savePatrolSeries(db, organizer, input());
  const unrelated = await savePatrolSeries(db, organizer, input());
  const [first, second] = await all(series.id);
  await changeSignup(db, alice, first.id, "join");
  await changeSignup(db, alice, second.id, "join");
  const unrelatedRows = await all(unrelated.id);
  await assert.rejects(
    deleteEvent(db, alice, first.id, first.updatedAt),
    status(403),
  );
  await assert.rejects(
    deleteEvent(db, organizer, first.id, first.updatedAt + 1),
    status(409),
  );
  const result = await deleteEvent(
    db,
    organizer,
    first.id,
    first.updatedAt,
    true,
  );
  assert.equal(
    await db
      .prepare("SELECT status FROM signup WHERE event_id=?")
      .bind(first.id)
      .first("status"),
    "cancelled",
  );
  assert.equal(
    await db
      .prepare("SELECT status FROM signup WHERE event_id=?")
      .bind(second.id)
      .first("status"),
    "confirmed",
  );
  assert.equal(
    await db
      .prepare("SELECT count(*) n FROM event_notification WHERE operation_id=?")
      .bind(result.operation)
      .first("n"),
    1,
  );
  await ensurePatrolOccurrences(db);
  assert.equal(
    (await all(series.id)).some((event) => event.id === first.id),
    false,
  );
  assert.equal(
    (await all(series.id)).filter((event) => !event.cancelledAt).length,
    4,
  );
  assert.deepEqual(await all(unrelated.id), unrelatedRows);
  await assert.rejects(
    restorePatrolOccurrence(db, organizer, first.id, first.updatedAt),
    status(409),
  );
  // A second action cannot change already-cancelled registered history.
  await cancelEvent(db, organizer, second.id, second.updatedAt, "");
  const cancelled = await findEvent(db, second.id);
  await assert.rejects(
    deleteEvent(db, organizer, second.id, cancelled.updatedAt),
    status(409),
  );
  assert.equal(
    await db
      .prepare("SELECT cancelled_at FROM event WHERE id=?")
      .bind(second.id)
      .first("cancelled_at"),
    cancelled.cancelledAt,
  );
});

test("past events reject cancellation and legacy deletion; series removal preserves past registrations and unrelated data", async () => {
  const series = await savePatrolSeries(db, organizer, {
    ...input(),
    spots: 5,
    includesOrientation: true,
  });
  const [past, future] = await all(series.id);
  await changeSignup(db, alice, past.id, "join");
  await changeSignup(db, alice, future.id, "join");
  await db
    .prepare("UPDATE event SET starts_at=0 WHERE id=?")
    .bind(past.id)
    .run();
  await assert.rejects(
    deleteEvent(db, organizer, past.id, past.updatedAt),
    status(409),
  );
  await assert.rejects(
    cancelEvent(db, organizer, past.id, past.updatedAt, ""),
    status(409),
  );
  assert.equal((await findEvent(db, past.id)).cancelledAt, null);
  assert.equal(
    await db
      .prepare("SELECT status FROM signup WHERE event_id=?")
      .bind(past.id)
      .first("status"),
    "confirmed",
  );
  await saveEvent(db, organizer, {
    type: "patrol",
    startsAt: new Date(Date.now() + 86_400_000).toISOString(),
    meetingPoint: "Unrelated one-off",
    meetingPointUrl: "",
    spots: 8,
    open: true,
    hidden: false,
  });
  const oneOff = await db
    .prepare("SELECT * FROM event WHERE series_id IS NULL")
    .first();
  const old = await findPatrolSeries(db, organizer, series.id);
  const occurrenceCount = await db
    .prepare("SELECT count(*) n FROM event WHERE series_id=?")
    .bind(series.id)
    .first("n");
  await assert.rejects(
    deletePatrolSeries(db, organizer, series.id, old.updatedAt + 1),
    status(409),
  );
  await deletePatrolSeries(db, organizer, series.id, old.updatedAt);
  await ensurePatrolOccurrences(db);
  assert.equal((await listPatrolSeries(db, organizer)).length, 0);
  assert.equal((await all(series.id)).length, 0);
  assert.equal(
    await db
      .prepare("SELECT status FROM signup WHERE event_id=?")
      .bind(future.id)
      .first("status"),
    "cancelled",
  );
  assert.equal(
    await db
      .prepare("SELECT status FROM signup WHERE event_id=?")
      .bind(past.id)
      .first("status"),
    "confirmed",
  );
  assert.deepEqual(
    await db.prepare("SELECT * FROM event WHERE series_id IS NULL").first(),
    oneOff,
  );
  assert.equal(await count("user"), 3);
  assert.equal(
    await db
      .prepare("SELECT count(*) n FROM event WHERE series_id=?")
      .bind(series.id)
      .first("n"),
    occurrenceCount,
  );
  await assert.rejects(
    restorePatrolOccurrence(
      db,
      organizer,
      future.id,
      (await db
        .prepare("SELECT updated_at FROM event WHERE id=?")
        .bind(future.id)
        .first<number>("updated_at"))!,
    ),
    status(404),
  );
  await deleteEvent(
    db,
    organizer,
    String(oneOff!.id),
    Number(oneOff!.updated_at),
  );
  assert.equal((await listEvents(db, organizer)).length, 0);
});

test("cancellation hides empty and previously registered events while retaining their details and audit history", async () => {
  const series = await savePatrolSeries(db, organizer, input());
  const [empty, previouslyRegistered] = await all(series.id);
  await changeSignup(db, alice, previouslyRegistered.id, "join");
  await changeSignup(db, alice, previouslyRegistered.id, "cancel");
  const history = (await db.prepare("SELECT * FROM signup").all()).results;
  const kept = await cancelEvent(
    db,
    organizer,
    previouslyRegistered.id,
    previouslyRegistered.updatedAt,
    "",
    true,
  );
  assert.match(kept.message, /history is available in the audit log/);
  assert.ok((await findEvent(db, previouslyRegistered.id)).cancelledAt);
  assert.deepEqual(
    (await db.prepare("SELECT * FROM signup").all()).results,
    history,
  );
  assert.equal(await count("event_notification"), 0);
  await cancelEvent(db, organizer, empty.id, empty.updatedAt, "");
  await ensurePatrolOccurrences(db);
  assert.ok((await findEvent(db, empty.id)).cancelledAt);
  assert.equal(
    await db
      .prepare(
        "SELECT count(*) n FROM event WHERE id=? AND cancelled_at IS NOT NULL AND open=0 AND hidden=1 AND meeting_point='Meeting point'",
      )
      .bind(empty.id)
      .first("n"),
    1,
  );
  assert.deepEqual(
    (
      await db
        .prepare(
          "SELECT action FROM event_audit WHERE event_id=? ORDER BY action",
        )
        .bind(empty.id)
        .all()
    ).results,
    [{ action: "cancelled" }, { action: "series_occurrence_created" }],
  );

  for (const registered of [false, true]) {
    await saveEvent(db, organizer, {
      includesOrientation: false,
      startsAt: new Date(Date.now() + 86_400_000).toISOString(),
      meetingPoint: "One-off",
      meetingPointUrl: "",
      spots: 4,
      open: true,
      hidden: false,
    });
    const event = (await listEvents(db, organizer)).find(
      (row) => !row.seriesId && !row.cancelledAt,
    )!;
    if (registered) {
      await changeSignup(db, alice, event.id, "join");
      await changeSignup(db, alice, event.id, "cancel");
    }
    await deleteEvent(db, organizer, event.id, event.updatedAt, true);
    assert.equal(
      await db
        .prepare("SELECT count(*) n FROM event WHERE id=?")
        .bind(event.id)
        .first("n"),
      1,
    );
    assert.ok((await findEvent(db, event.id)).cancelledAt);
    const log = await listAuditLog(db, organizer);
    assert.ok(
      log.entries.some(
        (entry) =>
          entry.subjectId === event.id &&
          entry.action === "created" &&
          entry.subjectName.includes("One-off"),
      ),
    );
    assert.ok(
      log.entries.some(
        (entry) => entry.subjectId === event.id && entry.action === "cancelled",
      ),
    );
  }

  const log = await listAuditLog(db, organizer);
  assert.ok(
    log.entries.some(
      (entry) =>
        entry.subjectId === empty.id &&
        entry.action === "cancelled" &&
        entry.subjectName.includes("Meeting point"),
    ),
  );
  for (const view of ["manage", "volunteer"] as const)
    assert.ok(
      (await listEvents(db, organizer, empty.id, view)).every(
        (row) => !row.cancelledAt,
      ),
    );
  // Organizers keep cancelled series dates they can still restore.
  assert.ok(
    (await listEvents(db, organizer, empty.id, "manage-upcoming")).every(
      (row) => !row.cancelledAt || (row.seriesId && row.restorable),
    ),
  );
  await db
    .prepare("UPDATE event SET starts_at=0 WHERE cancelled_at IS NOT NULL")
    .run();
  for (const view of ["manage-past", "past"] as const)
    assert.equal((await listEvents(db, organizer, empty.id, view)).length, 0);
});

test("a signup committed just before cancellation preserves the event and registration history", async () => {
  await saveEvent(db, organizer, {
    includesOrientation: false,
    startsAt: new Date(Date.now() + 86_400_000).toISOString(),
    meetingPoint: "Racing one-off",
    meetingPointUrl: "",
    spots: 4,
    open: true,
    hidden: false,
  });
  const event = (await listEvents(db, organizer))[0];
  const signupRace = new Proxy(db, {
    get(target, key) {
      if (key === "batch")
        return async (statements: D1PreparedStatement[]) => {
          // Commit after the empty preflight read but before cancellation writes.
          await changeSignup(db, alice, event.id, "join");
          return target.batch(statements);
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  await cancelEvent(signupRace, organizer, event.id, event.updatedAt, "");
  assert.ok((await findEvent(db, event.id)).cancelledAt);
  assert.deepEqual(
    (
      await db
        .prepare(
          "SELECT user_id AS userId, status FROM signup WHERE event_id=?",
        )
        .bind(event.id)
        .all()
    ).results,
    [{ userId: alice.id, status: "cancelled" }],
  );
});

test("start/cancel eligibility uses the live clock; the frontier keeps distant rows closed", async () => {
  const data = input();
  const series = await savePatrolSeries(db, organizer, data);
  const events = await all(series.id);
  const distant = await distantDate(
    series.id,
    addCalendarDays(data.firstDate, 140),
  );
  await changeSignup(db, alice, events[0].id, "join");
  await db
    .prepare("UPDATE event SET starts_at=0 WHERE id=?")
    .bind(events[0].id)
    .run();
  await assert.rejects(
    db
      .prepare(
        "INSERT INTO signup (id,event_id,user_id,created_at,updated_at) VALUES ('sparse',?,'bob',0,0)",
      )
      .bind(distant.id)
      .run(),
    /recurring_signup_window/,
  );
  const current = await window();
  assert.equal(current.length, 4);
  assert.equal(
    current.at(-1)!.occurrenceDate,
    addCalendarDays(data.firstDate, 56),
  );
  assert.equal(
    (await all(series.id)).find((event) => event.id === events[0].id)
      ?.confirmed,
    1,
  );
  await assert.rejects(
    changeSignup(db, alice, events[0].id, "cancel"),
    status(409),
  );
  await assert.rejects(
    changeSignup(db, bob, events[0].id, "join"),
    status(409),
  );
});

test("one-occurrence rescheduling remains attached to the original nominal date and generation cannot overwrite exceptions", async () => {
  const data = input();
  const series = await savePatrolSeries(db, organizer, data);
  const first = (await all(series.id))[0];
  const movedStart = vancouverOccurrenceInstant(
    addCalendarDays(data.firstDate, 100),
    data.localTime,
  );
  await saveEvent(
    db,
    organizer,
    {
      type: "patrol",
      startsAt: new Date(movedStart).toISOString(),
      meetingPoint: "Exception meeting point",
      meetingPointUrl: "",
      spots: 3,
      open: false,
      hidden: true,
    },
    first.id,
    first.updatedAt,
  );
  await ensurePatrolOccurrences(db);
  const moved = await findEvent(db, first.id);
  assert.equal(moved.occurrenceDate, data.firstDate);
  assert.equal(moved.startsAt, movedStart);
  assert.equal(moved.meetingPoint, "Exception meeting point");
  assert.equal(moved.inSignupWindow, 0);
  assert.equal((await window()).length, 4);
  await assert.rejects(
    db
      .prepare("UPDATE event SET occurrence_date=? WHERE id=?")
      .bind(addCalendarDays(data.firstDate, 1), first.id)
      .run(),
    /recurring_occurrence_identity/,
  );
});

test("series defaults are versioned and future-only; inclusive end dates stop generation and can extend without altering existing snapshots", async () => {
  const data = { ...input(), endDate: addCalendarDays(tomorrow(), 14) };
  const series = await savePatrolSeries(db, organizer, data);
  const initial = await all(series.id);
  assert.equal(initial.length, 2);
  const old = await findPatrolSeries(db, organizer, series.id);
  await savePatrolSeries(
    db,
    organizer,
    {
      ...data,
      endDate: addCalendarDays(data.firstDate, 56),
      meetingPoint: "New defaults",
    },
    series.id,
    old.updatedAt,
  );
  const rows = await all(series.id);
  assert.deepEqual(rows.slice(0, 2), initial);
  assert.equal(rows[2].meetingPoint, "New defaults");
  await assert.rejects(
    savePatrolSeries(db, organizer, data, series.id, old.updatedAt),
    status(409),
  );
  const current = await findPatrolSeries(db, organizer, series.id);
  await assert.rejects(
    savePatrolSeries(
      db,
      organizer,
      { ...data, firstDate: addCalendarDays(data.firstDate, 1) },
      series.id,
      current.updatedAt,
    ),
    status(409),
  );
  await changeSignup(db, alice, rows[2].id, "join");
  await savePatrolSeries(
    db,
    organizer,
    data,
    series.id,
    current.updatedAt,
    true,
  );
  assert.equal((await window()).length, 2);
  assert.ok((await findEvent(db, rows[2].id)).cancelledAt);
  assert.equal(
    await db
      .prepare("SELECT status FROM signup WHERE event_id=?")
      .bind(rows[2].id)
      .first("status"),
    "cancelled",
  );
  assert.equal(await count("event_notification"), 1);
  assert.match(
    String(
      await db
        .prepare("SELECT subject FROM event_notification")
        .first("subject"),
    ),
    /^Your event on \w{3}, \w{3} \d+ was cancelled$/,
  );
  assert.match(
    String(
      await db.prepare("SELECT body FROM event_notification").first("body"),
    ),
    /^Date: [^\n]+\nEvent type: /,
  );
  const shortened = await findPatrolSeries(db, organizer, series.id);
  await savePatrolSeries(
    db,
    organizer,
    { ...data, endDate: addCalendarDays(data.firstDate, 56) },
    series.id,
    shortened.updatedAt,
  );
  // Dates cancelled by the shorter end date stay cancelled until restored.
  assert.ok((await findEvent(db, rows[2].id)).cancelledAt);
  assert.deepEqual(
    (await window()).map((event) => event.occurrenceDate),
    [0, 14].map((days) => addCalendarDays(data.firstDate, days)),
  );
});

test("time/interval defaults persist without rewriting history, bookings or tombstones", async () => {
  const data = input();
  const series = await savePatrolSeries(db, organizer, data);
  const initial = await all(series.id);
  await changeSignup(db, alice, initial[2].id, "join");
  await db
    .prepare("UPDATE event SET starts_at=0 WHERE id=?")
    .bind(initial[0].id)
    .run();
  const cancelled = initial[3];
  await cancelEvent(
    db,
    organizer,
    cancelled.id,
    (await findEvent(db, cancelled.id)).updatedAt,
    "Skip this date",
  );
  const snapshots = (await db.prepare("SELECT * FROM event ORDER BY id").all())
    .results;
  const bookings = (await db.prepare("SELECT * FROM signup ORDER BY id").all())
    .results;
  const old = await findPatrolSeries(db, organizer, series.id);
  const edited = { ...data, localTime: "19:15", intervalWeeks: 1 };
  await savePatrolSeries(db, organizer, edited, series.id, old.updatedAt, true);
  const current = await findPatrolSeries(db, organizer, series.id);
  assert.equal(current.localTime, "19:15");
  assert.equal(current.intervalWeeks, 1);
  assert.ok(current.updatedAt > old.updatedAt);
  for (const snapshot of snapshots) {
    assert.deepEqual(
      await db
        .prepare("SELECT * FROM event WHERE id=?")
        .bind(snapshot.id)
        .first(),
      snapshot,
    );
  }
  assert.deepEqual(
    (await db.prepare("SELECT * FROM signup ORDER BY id").all()).results,
    bookings,
  );
  assert.equal(await count("event_notification"), 0);
  const newDate = addCalendarDays(data.firstDate, 7);
  assert.equal(
    vancouverInput(
      (await findEvent(db, patrolOccurrenceId(series.id, newDate))).startsAt,
    ),
    `${newDate}T19:15`,
  );
  const booked = (await listEvents(db, alice)).find(
    (event) => event.id === initial[2].id,
  );
  assert.equal(booked?.signedUp, 1);
  assert.equal(
    (await listPublicRosters(db, alice, [initial[2].id])).people.length,
    1,
  );
  await assert.rejects(
    savePatrolSeries(db, organizer, data, series.id, old.updatedAt),
    status(409),
  );
  await changeSignup(db, alice, initial[2].id, "cancel");
  await ensurePatrolOccurrences(db, series.id);
  assert.ok((await findEvent(db, cancelled.id)).cancelledAt);
  assert.ok(
    await db
      .prepare("SELECT cancelled_at FROM event WHERE id=?")
      .bind(cancelled.id)
      .first("cancelled_at"),
  );
  await assert.rejects(
    db
      .prepare("UPDATE patrol_series SET first_date=? WHERE id=?")
      .bind(newDate, series.id)
      .run(),
    /patrol_series_identity_immutable/,
  );
});

test("longer intervals retain effective templates and off-cadence snapshots as editable/stoppable boundaries", async () => {
  const data = input();
  const series = await savePatrolSeries(db, organizer, data);
  const initial = await all(series.id);
  let current = await findPatrolSeries(db, organizer, series.id);
  await updatePatrolSeriesFrom(
    db,
    organizer,
    series.id,
    data.firstDate,
    templateInput(),
    current.updatedAt,
  );
  const templates = await listPatrolTemplates(db, organizer, series.id);
  const snapshots = (await db.prepare("SELECT * FROM event ORDER BY id").all())
    .results;
  current = await findPatrolSeries(db, organizer, series.id);
  const edited = { ...data, localTime: "19:15", intervalWeeks: 3 };
  // Simulate a pause between the atomic defaults write and maintenance: the old
  // coverage must not authorize a direct signup under the new cadence.
  const paused = new Proxy(db, {
    get(target, key) {
      if (key === "batch")
        return async (statements: D1PreparedStatement[]) => {
          await target.batch(statements);
          assert.equal(
            await target
              .prepare("SELECT generation_until FROM patrol_series WHERE id=?")
              .bind(series.id)
              .first("generation_until"),
            0,
          );
          throw new Error("maintenance paused");
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  await assert.rejects(
    savePatrolSeries(paused, organizer, edited, series.id, current.updatedAt),
    /maintenance paused/,
  );
  await assert.rejects(
    db
      .prepare(
        "INSERT INTO signup (id,event_id,user_id,created_at,updated_at) VALUES ('paused',?,'alice',0,0)",
      )
      .bind(initial[0].id)
      .run(),
    /recurring_signup_window/,
  );
  await ensurePatrolOccurrences(db, series.id);
  assert.deepEqual(
    await listPatrolTemplates(db, organizer, series.id),
    templates,
  );
  for (const snapshot of snapshots) {
    assert.deepEqual(
      await db
        .prepare("SELECT * FROM event WHERE id=?")
        .bind(snapshot.id)
        .first(),
      snapshot,
    );
  }
  const futureDate = addCalendarDays(data.firstDate, 42);
  assert.equal(
    vancouverInput(
      (await findEvent(db, patrolOccurrenceId(series.id, futureDate))).startsAt,
    ),
    `${addCalendarDays(futureDate, 1)}T21:15`,
  );
  current = await findPatrolSeries(db, organizer, series.id);
  await updatePatrolSeriesFrom(
    db,
    organizer,
    series.id,
    initial[1].occurrenceDate!,
    { ...templateInput(), localTime: "22:00" },
    current.updatedAt,
  );
  assert.equal(
    vancouverInput((await findEvent(db, initial[1].id)).startsAt).slice(11),
    "22:00",
  );
  current = await findPatrolSeries(db, organizer, series.id);
  await stopPatrolSeries(
    db,
    organizer,
    series.id,
    initial[1].occurrenceDate!,
    current.updatedAt,
  );
  // Cancelling following events sets the last date instead of stopping for good.
  current = await findPatrolSeries(db, organizer, series.id);
  assert.equal(
    current.endDate,
    addCalendarDays(initial[1].occurrenceDate!, -1),
  );
  assert.equal(current.stoppedFrom, null);
  assert.ok((await findEvent(db, initial[1].id)).cancelledAt);
  assert.equal(
    (await all(series.id)).some(
      (event) =>
        !event.cancelledAt &&
        event.occurrenceDate! >= initial[1].occurrenceDate!,
    ),
    false,
  );
});

test("existing capacity, approvals, sessions and standalone behavior remain enforced", async () => {
  const series = await savePatrolSeries(db, organizer, {
    ...input(),
    spots: 3,
  });
  const first = (await all(series.id))[0];
  const attempts = await Promise.allSettled(
    [alice, bob].map((actor) => changeSignup(db, actor, first.id, "join")),
  );
  assert.equal(
    attempts.filter((attempt) => attempt.status === "fulfilled").length,
    1,
  );
  await assert.rejects(
    db.prepare("UPDATE event SET spots=0 WHERE id=?").bind(first.id).run(),
    /capacity_below_signups|CHECK|event_minimum_capacity|orientation_edit_conflict/,
  );
  const second = (await all(series.id))[1];
  await db
    .prepare(
      "UPDATE volunteer_status SET patrol_approved=0 WHERE user_id='bob'",
    )
    .run();
  await assert.rejects(changeSignup(db, bob, second.id, "join"), status(403));
  await db.prepare("DELETE FROM session WHERE user_id='alice'").run();
  await assert.rejects(changeSignup(db, alice, second.id, "join"), status(403));
  for (const type of ["patrol", "orientation"]) {
    await saveEvent(db, organizer, {
      type,
      startsAt: new Date(
        vancouverOccurrenceInstant(tomorrow(), "19:00"),
      ).toISOString(),
      meetingPoint: "Standalone",
      meetingPointUrl: "",
      spots: 4,
      open: true,
      hidden: false,
    });
  }
  const visible = await listEvents(db, bob);
  assert.equal(visible.filter((event) => !event.seriesId).length, 2);
  assert.equal(visible.filter((event) => event.seriesId).length, 5);
});

test("patrols allow past creation dates and standalone rescheduling without reopening history or registration", async () => {
  const data = {
    includesOrientation: false,
    startsAt: new Date(Date.now() - 3_600_000).toISOString(),
    meetingPoint: "Past event",
    meetingPointUrl: "",
    spots: 2,
    open: true,
    hidden: false,
  };
  await saveEvent(db, organizer, data);
  const [past] = await listEvents(db, organizer);
  assert.equal(past.startsAt, Date.parse(data.startsAt));
  await assert.rejects(changeSignup(db, alice, past.id, "join"), status(409));
  await assert.rejects(
    saveEvent(
      db,
      organizer,
      { ...data, meetingPoint: "Changed" },
      past.id,
      past.updatedAt,
    ),
    status(409),
  );
  await saveEvent(db, organizer, {
    ...data,
    startsAt: new Date(Date.now() + 86_400_000).toISOString(),
  });
  const [future] = await listEvents(db, organizer);
  await saveEvent(db, organizer, data, future.id, future.updatedAt);
  assert.equal(
    (await findEvent(db, future.id)).startsAt,
    Date.parse(data.startsAt),
  );
  await assert.rejects(
    saveEvent(db, organizer, { ...data, startsAt: "invalid" }),
    status(400),
  );

  const backdated = {
    ...input(),
    firstDate: addCalendarDays(tomorrow(), -28),
    endDate: tomorrow(),
  };
  const series = await savePatrolSeries(db, organizer, backdated);
  assert.equal(
    (await findPatrolSeries(db, organizer, series.id)).firstDate,
    backdated.firstDate,
  );
  assert.deepEqual(
    (await all(series.id)).map((event) => event.occurrenceDate),
    [backdated.endDate],
  );
});

test("validation and authorization reject invalid recurrence input or stale organizer sessions", async () => {
  for (const extra of [
    { firstDate: "2026-02-30" },
    { firstDate: "2026-03-08", localTime: "02:30" },
    { firstDate: "2025-11-02", localTime: "01:30" },
    { intervalWeeks: 0 },
    { intervalWeeks: 53 },
    { localTime: "25:00" },
    { endDate: "2000-01-01" },
    { meetingPointUrl: "http://example.org" },
    { includesOrientation: true, spots: 1 },
  ])
    await assert.rejects(
      savePatrolSeries(db, organizer, { ...input(), ...extra }),
      status(400),
    );
  await assert.rejects(savePatrolSeries(db, alice, input()), status(403));
  await db.prepare("DELETE FROM session WHERE user_id='organizer'").run();
  await assert.rejects(savePatrolSeries(db, organizer, input()), status(403));
  assert.equal(await count("patrol_series"), 0);
  assert.equal(await count("event"), 0);
});

const templateInput = () => ({
  localTime: "21:15",
  dayOffset: 1,
  meetingPoint: "Updated meeting point",
  meetingPointUrl: "https://example.org/map",
  spots: 5,
  open: true,
  hidden: false,
});

test("this-and-future updates booked materialized occurrences with stable IDs, preserving earlier dates, individual exceptions and tombstones", async () => {
  const data = input();
  const series = await savePatrolSeries(db, organizer, data);
  const events = await all(series.id);
  await changeSignup(db, alice, events[1].id, "join");
  await changeSignup(db, bob, events[2].id, "join");
  const bookings = (await db.prepare("SELECT * FROM signup ORDER BY id").all())
    .results;
  await saveEvent(
    db,
    organizer,
    {
      type: "patrol",
      startsAt: new Date(events[2].startsAt).toISOString(),
      meetingPoint: "Individual exception",
      meetingPointUrl: "",
      spots: 4,
      open: true,
      hidden: false,
    },
    events[2].id,
    events[2].updatedAt,
  );
  const exceptional = await findEvent(db, events[2].id);
  // The empty first occurrence still affects later bookings. Individual
  // exceptions receive cancellation mail, but not future-template edit mail.
  const eligibility = await all(series.id);
  const first = eligibility.find((event) => event.id === events[0].id)!;
  assert.equal(first.confirmed, 0);
  assert.equal(first.signedUp, 0);
  assert.equal(first.futureConfirmed, 2);
  assert.equal(first.futureEditableConfirmed, 1);
  const exception = eligibility.find((event) => event.id === events[2].id)!;
  assert.equal(exception.confirmed, 1);
  assert.equal(exception.futureConfirmed, 1);
  assert.equal(exception.futureEditableConfirmed, 0);
  const distant = await distantDate(
    series.id,
    addCalendarDays(data.firstDate, 70),
  );
  await cancelEvent(
    db,
    organizer,
    distant.id,
    (await findEvent(db, distant.id)).updatedAt,
    "Skip date",
  );
  const old = await findPatrolSeries(db, organizer, series.id);
  const change = await updatePatrolSeriesFrom(
    db,
    organizer,
    series.id,
    events[1].occurrenceDate!,
    templateInput(),
    old.updatedAt,
    true,
  );
  const changed = await findEvent(db, events[1].id);
  assert.equal(
    changed.startsAt,
    vancouverOccurrenceInstant(
      addCalendarDays(events[1].occurrenceDate!, 1),
      "21:15",
    ),
  );
  assert.equal(changed.meetingPoint, "Updated meeting point");
  assert.equal(changed.occurrenceDate, events[1].occurrenceDate);
  assert.equal(
    (await findEvent(db, events[0].id)).startsAt,
    events[0].startsAt,
  );
  assert.equal(
    (await findEvent(db, events[2].id)).meetingPoint,
    exceptional.meetingPoint,
  );
  assert.deepEqual(
    (await db.prepare("SELECT * FROM signup ORDER BY id").all()).results,
    bookings,
  );
  assert.equal(
    await db
      .prepare("SELECT count(*) n FROM event_notification WHERE operation_id=?")
      .bind(change.operation)
      .first("n"),
    1,
  );
  assert.match(
    String(
      await db
        .prepare("SELECT subject FROM event_notification")
        .first("subject"),
    ),
    /^Your event on \w{3}, \w{3} \d+ changed$/,
  );
  assert.match(
    String(
      await db.prepare("SELECT body FROM event_notification").first("body"),
    ),
    /^Date: [^\n]+\nEvent type: [^\n]+\nMeeting point: /,
  );
  await ensurePatrolOccurrences(db);
  assert.ok((await findEvent(db, distant.id)).cancelledAt);
  assert.ok(
    await db
      .prepare("SELECT cancelled_at FROM event WHERE id=?")
      .bind(distant.id)
      .first("cancelled_at"),
  );
  const fourth = events[3];
  assert.equal(
    (await findEvent(db, fourth.id)).meetingPoint,
    "Updated meeting point",
  );
  assert.equal(
    vancouverInput((await findEvent(db, fourth.id)).startsAt),
    `${addCalendarDays(data.firstDate, 43)}T21:15`,
  );
  await assert.rejects(
    updatePatrolSeriesFrom(
      db,
      organizer,
      series.id,
      data.firstDate,
      templateInput(),
      old.updatedAt,
    ),
    status(409),
  );
});

test("effective-date templates preserve earlier boundaries; an earlier this-and-future change replaces later defaults but not exceptions", async () => {
  const data = input();
  const series = await savePatrolSeries(db, organizer, data);
  let current = await findPatrolSeries(db, organizer, series.id);
  const day = (offset: number) => addCalendarDays(data.firstDate, offset);
  await updatePatrolSeriesFrom(
    db,
    organizer,
    series.id,
    day(56),
    templateInput(),
    current.updatedAt,
  );
  const later = await distantDate(series.id, day(70));
  assert.equal(
    (await findEvent(db, later.id)).meetingPoint,
    "Updated meeting point",
  );
  const earlier = { id: patrolOccurrenceId(series.id, day(42)) };
  assert.equal(
    (await findEvent(db, earlier.id)).meetingPoint,
    data.meetingPoint,
  );
  current = await findPatrolSeries(db, organizer, series.id);
  await updatePatrolSeriesFrom(
    db,
    organizer,
    series.id,
    day(28),
    { ...templateInput(), dayOffset: -1, meetingPoint: "Replacement" },
    current.updatedAt,
  );
  assert.equal((await findEvent(db, later.id)).meetingPoint, "Replacement");
  assert.equal((await listPatrolTemplates(db, organizer, series.id)).length, 1);
  const newDate = await distantDate(series.id, day(84));
  assert.equal(
    vancouverInput((await findEvent(db, newDate.id)).startsAt),
    `${day(83)}T21:15`,
  );
});

test("bulk capacity violations roll back template, event/audit changes, notifications, versions and all bookings", async () => {
  const data = input();
  const series = await savePatrolSeries(db, organizer, data);
  const events = await all(series.id);
  await changeSignup(db, alice, events[1].id, "join");
  await changeSignup(db, bob, events[1].id, "join");
  const bookedEvents = await all(series.id);
  const old = await findPatrolSeries(db, organizer, series.id);
  const audits = await count("event_audit");
  await assert.rejects(
    updatePatrolSeriesFrom(
      db,
      organizer,
      series.id,
      data.firstDate,
      { ...templateInput(), spots: 3 },
      old.updatedAt,
      true,
    ),
    status(409),
  );
  assert.deepEqual(await findPatrolSeries(db, organizer, series.id), old);
  assert.deepEqual(await all(series.id), bookedEvents);
  assert.equal(await count("patrol_series_template"), 0);
  assert.equal(await count("event_audit"), audits);
  assert.equal(await count("event_notification"), 0);
});

test("revoking patrol approval preserves orientation bookings but cancels regular patrol bookings", async () => {
  const orientationSeries = await savePatrolSeries(db, organizer, {
    ...input(),
    spots: 5,
    includesOrientation: true,
  });
  const patrolSeries = await savePatrolSeries(db, organizer, input());
  const orientation = (await all(orientationSeries.id))[0];
  const patrol = (await all(patrolSeries.id))[0];
  await changeSignup(db, alice, orientation.id, "join");
  await changeSignup(db, alice, patrol.id, "join");
  await setVolunteerStatus(db, organizer, {
    userId: alice.id,
    version: 0,
    active: true,
    patrolApproved: false,
    notify: true,
  });
  const bookings = (
    await db
      .prepare("SELECT event_id AS eventId, status FROM signup WHERE user_id=?")
      .bind(alice.id)
      .all<{ eventId: string; status: string }>()
  ).results;
  assert.equal(
    bookings.find((row) => row.eventId === orientation.id)?.status,
    "confirmed",
  );
  assert.equal(
    bookings.find((row) => row.eventId === patrol.id)?.status,
    "cancelled",
  );
  assert.equal(
    await db
      .prepare(
        "SELECT count(*) n FROM event_notification WHERE subject LIKE 'Your registration for % was cancelled' AND body LIKE 'Date: %volunteer access changed%'",
      )
      .first("n"),
    1,
  );
});

test("orientation settings persist on series, future templates and individual exceptions; invalid toggles roll back bookings", async () => {
  const data = { ...input(), spots: 8, includesOrientation: true };
  const series = await savePatrolSeries(db, organizer, data);
  const events = await all(series.id);
  const old = await findPatrolSeries(db, organizer, series.id);
  assert.equal(old.includesOrientation, 1);
  await assert.rejects(
    db
      .prepare("UPDATE patrol_series SET spots=1 WHERE id=?")
      .bind(series.id)
      .run(),
    /event_minimum_capacity/,
  );
  await assert.rejects(
    db
      .prepare(
        `INSERT INTO patrol_series_template
    (id,series_id,effective_date,local_time,day_offset,meeting_point,meeting_point_url,spots,open,hidden,includes_orientation)
    SELECT 'invalid-template',id,first_date,local_time,0,meeting_point,meeting_point_url,1,open,hidden,1 FROM patrol_series WHERE id=?`,
      )
      .bind(series.id)
      .run(),
    /event_minimum_capacity/,
  );
  await assert.rejects(
    saveEvent(
      db,
      organizer,
      {
        startsAt: new Date(events[0].startsAt).toISOString(),
        meetingPoint: data.meetingPoint,
        meetingPointUrl: "",
        spots: 1,
        open: true,
        hidden: false,
        includesOrientation: true,
      },
      events[0].id,
      events[0].updatedAt,
    ),
    (error: unknown) =>
      error instanceof RequestError &&
      error.status === 400 &&
      /reserved medic places/.test(error.message),
  );
  await assert.rejects(
    updatePatrolSeriesFrom(
      db,
      organizer,
      series.id,
      data.firstDate,
      { ...templateInput(), includesOrientation: true, spots: 1 },
      old.updatedAt,
    ),
    (error: unknown) =>
      error instanceof RequestError &&
      error.status === 400 &&
      /reserved medic places/.test(error.message),
  );
  assert.ok(events.every((event) => event.includesOrientation === 1));
  await db
    .prepare(
      "UPDATE volunteer_status SET patrol_approved=0 WHERE user_id='bob'",
    )
    .run();
  await db
    .prepare("UPDATE profile SET naloxone_completed_at=? WHERE user_id=?")
    .bind(Date.now(), bob.id)
    .run();
  const newVolunteer = {
    ...bob,
    patrolApproved: false,
    naloxoneCompleted: true,
    applicationComplete: true,
  };
  await changeSignup(db, newVolunteer, events[1].id, "join");
  const individual = {
    startsAt: new Date(events[1].startsAt).toISOString(),
    meetingPoint: data.meetingPoint,
    meetingPointUrl: "",
    spots: 8,
    open: true,
    hidden: false,
    includesOrientation: false,
  };
  await assert.rejects(
    saveEvent(db, organizer, individual, events[1].id, events[1].updatedAt),
    status(409),
  );
  const template = { ...templateInput(), spots: 8, includesOrientation: false };
  const booked = await all(series.id);
  await assert.rejects(
    updatePatrolSeriesFrom(
      db,
      organizer,
      series.id,
      events[1].occurrenceDate!,
      template,
      old.updatedAt,
      true,
    ),
    status(409),
  );
  assert.deepEqual(await findPatrolSeries(db, organizer, series.id), old);
  assert.deepEqual(await all(series.id), booked);
  assert.equal(await count("patrol_series_template"), 0);
  assert.equal(await count("event_notification"), 0);
  await changeSignup(db, newVolunteer, events[1].id, "cancel");
  await updatePatrolSeriesFrom(
    db,
    organizer,
    series.id,
    events[1].occurrenceDate!,
    template,
    old.updatedAt,
  );
  assert.equal(
    (await listPatrolTemplates(db, organizer, series.id))[0]
      .includesOrientation,
    0,
  );
  assert.equal((await findEvent(db, events[0].id)).includesOrientation, 1);
  assert.equal((await findEvent(db, events[1].id)).includesOrientation, 0);
  const distant = await distantDate(
    series.id,
    addCalendarDays(data.firstDate, 70),
  );
  assert.equal((await findEvent(db, distant.id)).includesOrientation, 0);
  const current = await findEvent(db, events[1].id);
  await saveEvent(
    db,
    organizer,
    {
      ...individual,
      startsAt: new Date(current.startsAt).toISOString(),
      includesOrientation: true,
    },
    current.id,
    current.updatedAt,
  );
  await ensurePatrolOccurrences(db);
  assert.equal((await findEvent(db, current.id)).includesOrientation, 1);
  assert.deepEqual(
    (await listEvents(db, newVolunteer)).map((event) => event.id).sort(),
    [events[0].id, current.id].sort(),
  );
  assert.equal((await listEvents(db, alice)).length, 5);
  // Storage keeps the immutable recurring patrol identity, not a mutually exclusive type.
  assert.equal(
    await db
      .prepare("SELECT type FROM event WHERE id=?")
      .bind(current.id)
      .first("type"),
    "patrol",
  );
  const preview = (await listEvents(db, alice)).find(
    (event) => event.id === events[0].id,
  )!;
  assert.equal(preview.availableSpots, 4);
  await changeSignup(db, alice, events[0].id, "join");
});

test("an occurrence generated between the bulk read and write cannot retain stale defaults unnoticed", async () => {
  const data = input();
  const series = await savePatrolSeries(db, organizer, data);
  const old = await findPatrolSeries(db, organizer, series.id);
  const extraDate = addCalendarDays(data.firstDate, 70);
  let inject = true;
  const racing = new Proxy(db, {
    get(target, key) {
      if (key === "batch")
        return async (statements: D1PreparedStatement[]) => {
          if (inject) {
            inject = false;
            await distantDate(series.id, extraDate);
          }
          return target.batch(statements);
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  await assert.rejects(
    updatePatrolSeriesFrom(
      racing,
      organizer,
      series.id,
      data.firstDate,
      templateInput(),
      old.updatedAt,
      true,
    ),
    status(409),
  );
  assert.equal(await count("patrol_series_template"), 0);
  assert.equal(await count("event_notification"), 0);
  assert.equal(
    (await findEvent(db, patrolOccurrenceId(series.id, extraDate)))
      .meetingPoint,
    data.meetingPoint,
  );
  await updatePatrolSeriesFrom(
    db,
    organizer,
    series.id,
    data.firstDate,
    templateInput(),
    old.updatedAt,
  );
  assert.equal(
    (await findEvent(db, patrolOccurrenceId(series.id, extraDate)))
      .meetingPoint,
    templateInput().meetingPoint,
  );
});

test("stopping at the first date cancels exceptions/bookings, preserves history and never restarts on extension or maintenance", async () => {
  const data = input();
  const series = await savePatrolSeries(db, organizer, data);
  const events = await all(series.id);
  await changeSignup(db, alice, events[0].id, "join");
  await saveEvent(
    db,
    organizer,
    {
      type: "patrol",
      startsAt: new Date(events[1].startsAt).toISOString(),
      meetingPoint: "Exception",
      meetingPointUrl: "",
      spots: 4,
      open: true,
      hidden: false,
    },
    events[1].id,
    events[1].updatedAt,
  );
  await db
    .prepare("UPDATE event SET starts_at=0 WHERE id=?")
    .bind(events[2].id)
    .run();
  const old = await findPatrolSeries(db, organizer, series.id);
  await stopPatrolSeries(
    db,
    organizer,
    series.id,
    data.firstDate,
    old.updatedAt,
    "Stopping",
    true,
  );
  assert.ok((await findEvent(db, events[0].id)).cancelledAt);
  assert.ok((await findEvent(db, events[1].id)).cancelledAt);
  assert.equal((await findEvent(db, events[2].id)).cancelledAt, null);
  assert.equal(
    await db.prepare("SELECT status FROM signup").first("status"),
    "cancelled",
  );
  assert.equal(await count("event_notification"), 1);
  assert.match(
    String(
      await db
        .prepare("SELECT subject FROM event_notification")
        .first("subject"),
    ),
    /^Your event on \w{3}, \w{3} \d+ was cancelled$/,
  );
  assert.match(
    String(
      await db.prepare("SELECT body FROM event_notification").first("body"),
    ),
    /^Date: [^\n]+\nEvent type: /,
  );
  const stopped = await findPatrolSeries(db, organizer, series.id);
  await savePatrolSeries(
    db,
    organizer,
    { ...data, endDate: addCalendarDays(data.firstDate, 365) },
    series.id,
    stopped.updatedAt,
  );
  await ensurePatrolOccurrences(db);
  assert.equal((await window()).length, 0);
  assert.deepEqual(
    (await all(series.id)).map((event) => event.id),
    [events[2].id],
  );
  for (const event of [events[0], events[3]])
    await assert.rejects(
      restorePatrolOccurrence(
        db,
        organizer,
        event.id,
        (await findEvent(db, event.id)).updatedAt,
      ),
      status(409),
    );
  assert.ok((await findEvent(db, events[0].id)).cancelledAt);
});

test("bulk edits and stopping reject volunteers and revoked organizer sessions without writes", async () => {
  const data = input();
  const series = await savePatrolSeries(db, organizer, data);
  const old = await findPatrolSeries(db, organizer, series.id);
  await assert.rejects(
    updatePatrolSeriesFrom(
      db,
      alice,
      series.id,
      data.firstDate,
      templateInput(),
      old.updatedAt,
    ),
    status(403),
  );
  await assert.rejects(
    stopPatrolSeries(db, alice, series.id, data.firstDate, old.updatedAt),
    status(403),
  );
  await db.prepare("DELETE FROM session WHERE user_id='organizer'").run();
  await assert.rejects(
    updatePatrolSeriesFrom(
      db,
      organizer,
      series.id,
      data.firstDate,
      templateInput(),
      old.updatedAt,
    ),
    status(409),
  );
  await assert.rejects(
    stopPatrolSeries(db, organizer, series.id, data.firstDate, old.updatedAt),
    status(409),
  );
  assert.deepEqual(await findPatrolSeries(db, organizer, series.id), old);
  assert.equal(await count("patrol_series_template"), 0);
  assert.equal(await count("event_notification"), 0);
});

test("all-events edits start at the next upcoming date and never change past dates", async () => {
  const data = { ...input(), intervalWeeks: 1 };
  const series = await savePatrolSeries(db, organizer, data);
  const events = await all(series.id);
  // The first date has already happened.
  await db
    .prepare("UPDATE event SET starts_at = ? WHERE id = ?")
    .bind(Date.now() - 3_600_000, events[0].id)
    .run();
  const old = await findPatrolSeries(db, organizer, series.id);
  await updatePatrolSeriesFrom(
    db,
    organizer,
    series.id,
    events[3].occurrenceDate!,
    { ...templateInput(), dayOffset: 0 },
    old.updatedAt,
    false,
    "all",
  );
  assert.equal(
    (await findEvent(db, events[0].id)).meetingPoint,
    "Meeting point",
  );
  for (const event of events.slice(1))
    assert.equal(
      (await findEvent(db, event.id)).meetingPoint,
      "Updated meeting point",
    );
  assert.deepEqual(
    (await listPatrolTemplates(db, organizer, series.id)).map(
      (template) => template.effectiveDate,
    ),
    [events[1].occurrenceDate],
  );
});

test("a new interval restarts the cadence from that date, cancelling dates that no longer fit", async () => {
  const data = { ...input(), intervalWeeks: 1 };
  const series = await savePatrolSeries(db, organizer, data);
  const events = await all(series.id);
  await changeSignup(db, alice, events[2].id, "join");
  await changeSignup(db, bob, events[3].id, "join");
  const old = await findPatrolSeries(db, organizer, series.id);
  const result = await updatePatrolSeriesFrom(
    db,
    organizer,
    series.id,
    events[1].occurrenceDate!,
    {
      ...templateInput(),
      localTime: data.localTime,
      dayOffset: 0,
      intervalWeeks: 2,
    },
    old.updatedAt,
    true,
  );
  assert.match(result.message, /no longer fit the schedule/);
  const dates = (await all(series.id)).map((event) => event.occurrenceDate);
  const kept = [0, 1, 3, 5, 7].map((index) => events[index].occurrenceDate);
  for (const date of kept) assert.ok(dates.includes(date));
  for (const index of [2, 4, 6])
    assert.ok((await findEvent(db, events[index].id)).cancelledAt);
  // The cancelled date takes its booking with it; the kept date keeps its booking.
  const signups = (
    await db
      .prepare("SELECT event_id, status FROM signup ORDER BY event_id")
      .all<{ event_id: string; status: string }>()
  ).results;
  assert.deepEqual(
    Object.fromEntries(signups.map((row) => [row.event_id, row.status])),
    { [events[2].id]: "cancelled", [events[3].id]: "confirmed" },
  );
  assert.equal(
    await db
      .prepare("SELECT count(*) n FROM event_notification WHERE user_id = ?")
      .bind(alice.id)
      .first("n"),
    1,
  );
  // Off-cadence dates can't be restored, and generation follows the new cadence.
  const dropped = await findEvent(db, events[2].id);
  await assert.rejects(
    restorePatrolOccurrence(db, organizer, dropped.id, dropped.updatedAt),
    status(409),
  );
  const listed = await listEvents(db, organizer, undefined, "manage-upcoming");
  assert.equal(
    listed.find((event) => event.id === events[3].id)?.intervalWeeks,
    2,
  );
  assert.equal(
    listed.find((event) => event.id === events[0].id)?.intervalWeeks,
    1,
  );
  assert.ok(!listed.some((event) => event.id === dropped.id));
});

test("a new last date from an event cancels later dates; cancelling all events stops from the next upcoming date", async () => {
  const data = { ...input(), intervalWeeks: 1 };
  const series = await savePatrolSeries(db, organizer, data);
  const events = await all(series.id);
  let current = await findPatrolSeries(db, organizer, series.id);
  await updatePatrolSeriesFrom(
    db,
    organizer,
    series.id,
    events[1].occurrenceDate!,
    { ...templateInput(), dayOffset: 0, endDate: events[3].occurrenceDate },
    current.updatedAt,
  );
  current = await findPatrolSeries(db, organizer, series.id);
  assert.equal(current.endDate, events[3].occurrenceDate);
  assert.equal((await all(series.id)).length, 4);
  await assert.rejects(
    updatePatrolSeriesFrom(
      db,
      organizer,
      series.id,
      events[2].occurrenceDate!,
      { ...templateInput(), endDate: events[1].occurrenceDate },
      current.updatedAt,
    ),
    status(400),
  );
  await stopPatrolSeries(
    db,
    organizer,
    series.id,
    events[2].occurrenceDate!,
    current.updatedAt,
    "",
    false,
    "all",
  );
  assert.equal((await all(series.id)).length, 0);
  assert.equal(
    (await findPatrolSeries(db, organizer, series.id)).stoppedFrom,
    events[0].occurrenceDate,
  );
});

test("planning follows each interval change from its own date", () => {
  const now = Date.parse("2026-11-02T12:00:00Z");
  const series = {
    firstDate: "2026-11-03",
    localTime: "20:30",
    intervalWeeks: 1,
    endDate: null,
  };
  const template = {
    effectiveDate: "2026-11-17",
    intervalWeeks: 2,
    localTime: "20:30",
    dayOffset: 0,
  } as PatrolTemplate;
  const dates = planPatrolOccurrences(series, [], now, [
    template,
  ]).occurrences.map((event) => event.date);
  assert.deepEqual(dates, [
    "2026-11-03",
    "2026-11-10",
    "2026-11-17",
    "2026-12-01",
    "2026-12-15",
    "2026-12-29",
  ]);
});

test("following-event edits skip separately edited dates, and all-events edits replace them", async () => {
  const series = await savePatrolSeries(db, organizer, {
    ...input(),
    intervalWeeks: 1,
  });
  const events = await all(series.id);
  await changeSignup(db, alice, events[2].id, "join");
  await saveEvent(
    db,
    organizer,
    {
      type: "patrol",
      startsAt: new Date(events[2].startsAt).toISOString(),
      meetingPoint: "Separate edit",
      meetingPointUrl: "",
      spots: 4,
      open: true,
      hidden: false,
    },
    events[2].id,
    (await findEvent(db, events[2].id)).updatedAt,
  );
  const edited = async () =>
    (await all(series.id)).find((event) => event.id === events[2].id)!;
  assert.equal((await edited()).edited, 1);
  // Booked separate edits don't count toward following-event emails.
  assert.equal(
    (await all(series.id)).find((event) => event.id === events[1].id)!
      .futureEditableConfirmed,
    0,
  );
  const template = {
    ...templateInput(),
    localTime: "20:30",
    dayOffset: 0,
  };
  await updatePatrolSeriesFrom(
    db,
    organizer,
    series.id,
    events[1].occurrenceDate!,
    { ...template, meetingPoint: "Following" },
    (await findPatrolSeries(db, organizer, series.id)).updatedAt,
  );
  assert.equal(
    (await findEvent(db, events[2].id)).meetingPoint,
    "Separate edit",
  );
  await updatePatrolSeriesFrom(
    db,
    organizer,
    series.id,
    events[1].occurrenceDate!,
    { ...template, meetingPoint: "Everything" },
    (await findPatrolSeries(db, organizer, series.id)).updatedAt,
    true,
    "all",
  );
  assert.equal((await findEvent(db, events[2].id)).meetingPoint, "Everything");
  assert.equal((await edited()).edited, 0);
  assert.equal(
    await db
      .prepare("SELECT count(*) n FROM event_notification WHERE user_id = ?")
      .bind(alice.id)
      .first("n"),
    1,
  );
  // It is part of the series again, so later following-event edits apply.
  await updatePatrolSeriesFrom(
    db,
    organizer,
    series.id,
    events[1].occurrenceDate!,
    { ...template, meetingPoint: "Following again" },
    (await findPatrolSeries(db, organizer, series.id)).updatedAt,
  );
  assert.equal(
    (await findEvent(db, events[2].id)).meetingPoint,
    "Following again",
  );
});

test("series edits change only the fields sent, so a separately edited date's values don't spread", async () => {
  const series = await savePatrolSeries(db, organizer, {
    ...input(),
    intervalWeeks: 1,
  });
  const events = await all(series.id);
  const moved = addCalendarDays(events[2].occurrenceDate!, -1);
  await saveEvent(
    db,
    organizer,
    {
      type: "patrol",
      startsAt: new Date(
        vancouverOccurrenceInstant(moved, "19:00"),
      ).toISOString(),
      meetingPoint: "Separate edit",
      meetingPointUrl: "",
      spots: 4,
      open: true,
      hidden: false,
    },
    events[2].id,
    (await findEvent(db, events[2].id)).updatedAt,
  );
  await updatePatrolSeriesFrom(
    db,
    organizer,
    series.id,
    events[2].occurrenceDate!,
    { spots: 6 },
    (await findPatrolSeries(db, organizer, series.id)).updatedAt,
    false,
    "all",
  );
  for (const event of await all(series.id)) {
    assert.equal(event.spots, 6);
    assert.equal(event.meetingPoint, "Meeting point");
    assert.equal(vancouverInput(event.startsAt).slice(11), "20:30");
    assert.equal(
      vancouverInput(event.startsAt).slice(0, 10),
      event.occurrenceDate,
    );
  }
});

test("changing the schedule back restores the dates it cancelled, but not dates cancelled by hand", async () => {
  const series = await savePatrolSeries(db, organizer, {
    ...input(),
    intervalWeeks: 1,
  });
  const events = await all(series.id);
  const byHand = await findEvent(db, events[4].id);
  await cancelEvent(db, organizer, byHand.id, byHand.updatedAt, "");
  const schedule = async (intervalWeeks: number) =>
    updatePatrolSeriesFrom(
      db,
      organizer,
      series.id,
      events[1].occurrenceDate!,
      { intervalWeeks },
      (await findPatrolSeries(db, organizer, series.id)).updatedAt,
    );
  await schedule(2);
  for (const index of [2, 4, 6])
    assert.ok((await findEvent(db, events[index].id)).cancelledAt);
  const result = await schedule(1);
  assert.match(result.message, /restored/);
  for (const index of [2, 6])
    assert.equal((await findEvent(db, events[index].id)).cancelledAt, null);
  assert.ok((await findEvent(db, events[4].id)).cancelledAt);
});

test("cancelling following events sets the last date, and extending it brings those dates back", async () => {
  const series = await savePatrolSeries(db, organizer, {
    ...input(),
    intervalWeeks: 1,
  });
  const events = await all(series.id);
  await stopPatrolSeries(
    db,
    organizer,
    series.id,
    events[2].occurrenceDate!,
    (await findPatrolSeries(db, organizer, series.id)).updatedAt,
  );
  const stopped = await findPatrolSeries(db, organizer, series.id);
  assert.equal(stopped.endDate, addCalendarDays(events[2].occurrenceDate!, -1));
  assert.equal(stopped.stoppedFrom, null);
  assert.equal(
    (await all(series.id)).filter((event) => !event.cancelledAt).length,
    2,
  );
  await updatePatrolSeriesFrom(
    db,
    organizer,
    series.id,
    events[0].occurrenceDate!,
    { endDate: null },
    stopped.updatedAt,
  );
  for (const event of events)
    assert.equal((await findEvent(db, event.id)).cancelledAt, null);
});

test("restoring a date applies series changes made while it was cancelled", async () => {
  const series = await savePatrolSeries(db, organizer, {
    ...input(),
    intervalWeeks: 1,
  });
  const events = await all(series.id);
  const cancelled = await findEvent(db, events[2].id);
  await cancelEvent(db, organizer, cancelled.id, cancelled.updatedAt, "");
  await updatePatrolSeriesFrom(
    db,
    organizer,
    series.id,
    events[1].occurrenceDate!,
    { meetingPoint: "New place", localTime: "21:00" },
    (await findPatrolSeries(db, organizer, series.id)).updatedAt,
    false,
    "all",
  );
  await restorePatrolOccurrence(
    db,
    organizer,
    cancelled.id,
    (await findEvent(db, cancelled.id)).updatedAt,
  );
  const restored = await findEvent(db, cancelled.id);
  assert.equal(restored.cancelledAt, null);
  assert.equal(restored.meetingPoint, "New place");
  assert.equal(vancouverInput(restored.startsAt).slice(11), "21:00");
});

test("series stay within reach: intervals cap at eight weeks and first dates at two months", async () => {
  await assert.rejects(
    savePatrolSeries(db, organizer, { ...input(), intervalWeeks: 9 }),
    status(400),
  );
  await assert.rejects(
    savePatrolSeries(db, organizer, {
      ...input(),
      firstDate: addCalendarDays(tomorrow(), 70),
    }),
    status(400),
  );
  const series = await savePatrolSeries(db, organizer, input());
  await assert.rejects(
    updatePatrolSeriesFrom(
      db,
      organizer,
      series.id,
      (await all(series.id))[0].occurrenceDate!,
      { intervalWeeks: 9 },
      (await findPatrolSeries(db, organizer, series.id)).updatedAt,
    ),
    status(400),
  );
});

test("only a new time, meeting point or event type is emailed to booked volunteers", async () => {
  const data = input();
  const series = await savePatrolSeries(db, organizer, data);
  const [first, second, third] = await all(series.id);
  for (const { id } of [first, second, third])
    await changeSignup(db, alice, id, "join");
  const event = {
    type: "patrol",
    startsAt: new Date(first.startsAt).toISOString(),
    meetingPoint: first.meetingPoint,
    meetingPointUrl: "",
    spots: first.spots,
    open: true,
    hidden: false,
  };
  const save = async (changes: object) =>
    saveEvent(
      db,
      organizer,
      { ...event, ...changes },
      first.id,
      (await findEvent(db, first.id)).updatedAt,
      true,
    );
  await save({ spots: 6 });
  await save({ meetingPointUrl: "https://maps.example/point" });
  await save({ open: false, hidden: true });
  assert.equal(await count("event_notification"), 0);
  await save({ meetingPoint: "Moved" });
  assert.equal(await count("event_notification"), 1);

  const versions = async () =>
    Promise.all(
      [first, second].map(async ({ id }) => ({
        id,
        version: (await findEvent(db, id)).updatedAt,
      })),
    );
  await bulkSaveEvents(
    db,
    organizer,
    { selection: await versions(), changes: { spots: 7 } },
    true,
  );
  assert.equal(await count("event_notification"), 1);
  // Only the event whose meeting point actually moves is emailed.
  await bulkSaveEvents(
    db,
    organizer,
    { selection: await versions(), changes: { meetingPoint: "Moved" } },
    true,
  );
  assert.equal(await count("event_notification"), 2);

  // The first two dates now have their own edits, so start from the third.
  const seriesVersion = async () =>
    (await findPatrolSeries(db, organizer, series.id)).updatedAt;
  await updatePatrolSeriesFrom(
    db,
    organizer,
    series.id,
    third.occurrenceDate!,
    { spots: 8 },
    await seriesVersion(),
    true,
  );
  assert.equal(await count("event_notification"), 2);
  await updatePatrolSeriesFrom(
    db,
    organizer,
    series.id,
    third.occurrenceDate!,
    { meetingPoint: "Moved again" },
    await seriesVersion(),
    true,
  );
  assert.equal(await count("event_notification"), 3);
});
