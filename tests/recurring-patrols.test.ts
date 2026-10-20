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
} from "../src/server/db/events";
import { planPatrolOccurrences } from "../src/server/db/patrol-series";
import { RequestError } from "../src/server/http";
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
  spots: 2,
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
    db.prepare("UPDATE event SET spots=1 WHERE id=?").bind(events[2].id),
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
      spots: 1,
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
    spots: 1,
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
    /capacity_below_signups|CHECK/,
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
      spots: 2,
      open: true,
      hidden: false,
    });
  }
  const visible = await listEvents(db, bob);
  assert.equal(visible.filter((event) => !event.seriesId).length, 2);
  assert.equal(visible.filter((event) => event.seriesId).length, 3);
});

test("validation and authorization reject invalid recurrence input or stale organizer sessions", async () => {
  for (const extra of [
    { firstDate: "2026-02-30" },
    { intervalWeeks: 0 },
    { intervalWeeks: 53 },
    { localTime: "25:00" },
    { endDate: "2000-01-01" },
    { meetingPointUrl: "http://example.org" },
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
