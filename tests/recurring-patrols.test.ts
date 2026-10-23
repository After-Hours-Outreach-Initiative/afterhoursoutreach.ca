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
  changeSignup,
  ensurePatrolOccurrences,
  findEvent,
  findPatrolSeries,
  listEvents,
  listRosters,
  manageSignup,
  materializePatrolOccurrence,
  patrolOccurrenceId,
  saveEvent,
  savePatrolSeries,
  updatePatrolSeriesFrom,
  stopPatrolSeries,
  listPatrolTemplates,
} from "../src/server/db/events";
import {
  planPatrolOccurrences,
  type PatrolTemplate,
} from "../src/server/db/patrol-series";
import { RequestError } from "../src/server/http";
import {
  completeOrientation,
  setVolunteerStatus,
} from "../src/server/db/volunteers";
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

test("fortnightly October 20/November 3/November 17 preserve local wall time; December 1 enters exactly at October 20 start", () => {
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
    ["2026-10-20", "2026-11-03", "2026-11-17"],
  );
  assert.deepEqual(
    initial.occurrences.map((event) => new Date(event.startsAt).toISOString()),
    [
      "2026-10-21T03:30:00.000Z",
      "2026-11-04T04:30:00.000Z",
      "2026-11-18T04:30:00.000Z",
    ],
  );
  const existing = initial.occurrences.map((event) => ({
    occurrenceDate: event.date,
    startsAt: event.startsAt,
    cancelledAt: null,
  }));
  assert.deepEqual(
    planPatrolOccurrences(series, existing, first - 1).occurrences,
    [],
  );
  assert.deepEqual(
    planPatrolOccurrences(series, existing, first).occurrences.map(
      (event) => event.date,
    ),
    ["2026-12-01"],
  );
  assert.deepEqual(
    planPatrolOccurrences(
      { ...series, endDate: "2026-11-03" },
      [],
      first - 1,
    ).occurrences.map((event) => event.date),
    ["2026-10-20", "2026-11-03"],
  );
});

test("spring/fall recurrence DST policy is deterministic, including gaps and folds", () => {
  assert.equal(
    new Date(vancouverOccurrenceInstant("2026-03-08", "02:30")).toISOString(),
    "2026-03-08T10:30:00.000Z",
  );
  assert.equal(
    new Date(vancouverOccurrenceInstant("2026-11-01", "01:30")).toISOString(),
    "2026-11-01T08:30:00.000Z",
  );
  assert.equal(
    vancouverInput(vancouverOccurrenceInstant("2026-03-15", "02:30")),
    "2026-03-15T02:30",
  );
  assert.throws(() => vancouverOccurrenceInstant("2026-02-30", "02:30"));
});

test("effective day shifts plan the true earliest starts across template boundaries and keep a conservative signup frontier", () => {
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
    const third = candidates[2].startsAt;
    assert.deepEqual(
      plan.occurrences.map((event) => event.date).sort(),
      candidates
        .filter((event) => event.startsAt <= third)
        .map((event) => event.date)
        .sort(),
    );
    const missing = candidates.filter(
      (event) =>
        !plan.occurrences.some((planned) => planned.date === event.date),
    );
    assert.ok(plan.generationUntil > third);
    assert.ok(
      plan.generationUntil <=
        Math.min(...missing.map((event) => event.startsAt)),
    );
  }
});

test("concurrent D1 generation is idempotent and creates independent occurrence IDs, rosters, capacity and audits", async () => {
  const series = await savePatrolSeries(db, organizer, input());
  const original = await all(series.id);
  await Promise.all(
    Array.from({ length: 8 }, () => ensurePatrolOccurrences(db)),
  );
  assert.deepEqual(await all(series.id), original);
  assert.equal(original.length, 3);
  assert.equal(new Set(original.map((event) => event.id)).size, 3);
  assert.equal(
    original[0].id,
    patrolOccurrenceId(series.id, original[0].occurrenceDate!),
  );
  assert.equal(await count("event_audit"), 3);
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

test("simultaneous replenishment writes after a start create exactly one replacement", async () => {
  const series = await savePatrolSeries(db, organizer, input());
  const first = (await all(series.id))[0];
  await db
    .prepare("UPDATE event SET starts_at=0 WHERE id=?")
    .bind(first.id)
    .run();
  await Promise.all(
    Array.from({ length: 12 }, () => ensurePatrolOccurrences(db)),
  );
  assert.equal((await window()).length, 3);
  assert.equal((await all(series.id)).length, 4);
  assert.equal(await count("event_audit"), 4);
});

test("each series has its own three-occurrence window and cancelled chains are skipped without recreation", async () => {
  const data = input();
  const one = await savePatrolSeries(db, organizer, data);
  const two = await savePatrolSeries(db, organizer, {
    ...data,
    intervalWeeks: 1,
  });
  assert.equal(
    (await window()).filter((event) => event.seriesId === one.id).length,
    3,
  );
  assert.equal(
    (await window()).filter((event) => event.seriesId === two.id).length,
    3,
  );
  for (const event of await all(one.id))
    await cancelEvent(
      db,
      organizer,
      event.id,
      event.updatedAt,
      "Skip these dates",
    );
  const remaining = (await window()).filter(
    (event) => event.seriesId === one.id,
  );
  assert.deepEqual(
    remaining.map((event) => event.occurrenceDate),
    [42, 56, 70].map((days) => addCalendarDays(data.firstDate, days)),
  );
  assert.equal(
    (await all(one.id)).filter((event) => event.cancelledAt).length,
    3,
  );
  assert.equal(
    (await window()).filter((event) => event.seriesId === two.id).length,
    3,
  );
});

test("fourth occurrence is rejected by direct join, SQL reactivation/reassignment, and organizer moves, with rollback", async () => {
  const data = input();
  const series = await savePatrolSeries(db, organizer, data);
  const first = (await all(series.id))[0];
  const fourth = await materializePatrolOccurrence(
    db,
    organizer,
    series.id,
    addCalendarDays(data.firstDate, 42),
  );
  assert.equal((await findEvent(db, fourth.id)).inSignupWindow, 0);
  assert.equal((await window()).length, 3);
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

test("closed/full/hidden occurrences consume slots; hidden recurring occurrences are invisible even with a booking", async () => {
  const data = input();
  const series = await savePatrolSeries(db, organizer, data);
  const events = await all(series.id);
  const fourth = await materializePatrolOccurrence(
    db,
    organizer,
    series.id,
    addCalendarDays(data.firstDate, 42),
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
    [events[1].id, events[2].id],
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

test("cancellation advances the window, cancels only that roster, and is a permanent generation tombstone", async () => {
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
  assert.equal((await window()).length, 3);
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
      .prepare("UPDATE event SET cancelled_at=NULL WHERE id=?")
      .bind(events[0].id)
      .run(),
    /recurring_occurrence_tombstone/,
  );
  assert.equal(
    (
      await materializePatrolOccurrence(
        db,
        organizer,
        series.id,
        events[0].occurrenceDate!,
      )
    ).id,
    events[0].id,
  );
  assert.ok((await findEvent(db, events[0].id)).cancelledAt);
});

test("start/cancel eligibility uses the live clock; the frontier fails closed for sparse distant rows before maintenance", async () => {
  const data = input();
  const series = await savePatrolSeries(db, organizer, data);
  const events = await all(series.id);
  const distant = await materializePatrolOccurrence(
    db,
    organizer,
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
  assert.equal(current.length, 3);
  assert.equal(current[2].occurrenceDate, addCalendarDays(data.firstDate, 42));
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
  assert.equal((await window()).length, 3);
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
      { ...data, intervalWeeks: 1 },
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
  const shortened = await findPatrolSeries(db, organizer, series.id);
  await savePatrolSeries(
    db,
    organizer,
    { ...data, endDate: addCalendarDays(data.firstDate, 56) },
    series.id,
    shortened.updatedAt,
  );
  assert.ok((await findEvent(db, rows[2].id)).cancelledAt);
  assert.deepEqual(
    (await window()).map((event) => event.occurrenceDate),
    [0, 14, 42].map((days) => addCalendarDays(data.firstDate, days)),
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
  assert.equal(visible.filter((event) => event.seriesId).length, 3);
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
    { firstDate: "2026-11-01", localTime: "01:30" },
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
  const distantDate = addCalendarDays(data.firstDate, 70);
  const distant = await materializePatrolOccurrence(
    db,
    organizer,
    series.id,
    distantDate,
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
  await ensurePatrolOccurrences(db);
  assert.ok((await findEvent(db, distant.id)).cancelledAt);
  const fourth = await materializePatrolOccurrence(
    db,
    organizer,
    series.id,
    addCalendarDays(data.firstDate, 42),
  );
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
  const later = await materializePatrolOccurrence(
    db,
    organizer,
    series.id,
    day(70),
  );
  assert.equal(
    (await findEvent(db, later.id)).meetingPoint,
    "Updated meeting point",
  );
  const earlier = await materializePatrolOccurrence(
    db,
    organizer,
    series.id,
    day(42),
  );
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
  const newDate = await materializePatrolOccurrence(
    db,
    organizer,
    series.id,
    day(84),
  );
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
        "SELECT count(*) n FROM event_notification WHERE subject='Your event registration was cancelled'",
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
      /at least 2 total/.test(error.message),
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
      /at least 2 total/.test(error.message),
  );
  assert.ok(events.every((event) => event.includesOrientation === 1));
  await db
    .prepare(
      "UPDATE volunteer_status SET patrol_approved=0 WHERE user_id='bob'",
    )
    .run();
  await changeSignup(
    db,
    { ...bob, patrolApproved: false },
    events[1].id,
    "join",
  );
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
  await changeSignup(
    db,
    { ...bob, patrolApproved: false },
    events[1].id,
    "cancel",
  );
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
  const distant = await materializePatrolOccurrence(
    db,
    organizer,
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
    (await listEvents(db, { ...bob, patrolApproved: false }))
      .map((event) => event.id)
      .sort(),
    [events[0].id, current.id].sort(),
  );
  assert.equal((await listEvents(db, alice)).length, 3);
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
  assert.equal(preview.orientationCompleted, 0);
  assert.equal(preview.availableSpots, 4);
  await changeSignup(db, alice, events[0].id, "join");
  await db
    .prepare("UPDATE event SET starts_at=0 WHERE id=?")
    .bind(events[0].id)
    .run();
  await completeOrientation(db, organizer, alice.id, events[0].id);
  assert.equal(await count("orientation_completion"), 1);
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
            await materializePatrolOccurrence(
              db,
              organizer,
              series.id,
              extraDate,
            );
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
  assert.equal((await all(series.id)).length, 3);
  assert.equal(
    (
      await materializePatrolOccurrence(
        db,
        organizer,
        series.id,
        data.firstDate,
      )
    ).id,
    events[0].id,
  );
  assert.ok((await findEvent(db, events[0].id)).cancelledAt);
  await assert.rejects(
    materializePatrolOccurrence(
      db,
      organizer,
      series.id,
      addCalendarDays(data.firstDate, 42),
    ),
    status(400),
  );
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
