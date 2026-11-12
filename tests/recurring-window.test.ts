import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "vitest";
import { vancouverOccurrenceInstant } from "../src/data/event-time";
import {
  planPatrolOccurrences,
  recurringSignupWindowSql,
} from "../src/server/db/patrol-series";
import { sourceSchemaStatements } from "./helpers/source-schema";

test("the SQL window and signup guards open each date two months ahead, at Vancouver midnight", () => {
  const db = new DatabaseSync(":memory:");
  let now = vancouverOccurrenceInstant("2026-10-29", "23:59");
  // Deterministic SQLite statement-time clock; production still uses SQLite's
  // own julianday('now'), never a client-supplied timestamp.
  db.function("julianday", (_value) => now / 86_400_000 + 2440587.5);
  try {
    db.exec("PRAGMA foreign_keys=ON");
    for (const statement of sourceSchemaStatements()) db.exec(statement);
    db.exec(`
      INSERT INTO user (id,name,email,role,created_at,updated_at)
        VALUES ('organizer','Organizer','organizer@example.org','organizer',0,0),
          ('alice','Alice','alice@example.org','volunteer',0,0);
      INSERT INTO profile (user_id,preferred_name,phone,birth_date,emergency_contact_name,
        emergency_contact_phone,emergency_contact_relationship,heard_about_us,motivation,
        teams,medical_certification,training_experience,registered_at,updated_at)
        VALUES ('alice','Alice','555','2000-01-01','Contact','555','Friend','Friend','Help','[]','None','None',0,0);
      INSERT INTO volunteer_status (user_id,active,registration_approved,patrol_approved,approved_by,approved_at,updated_at)
        VALUES ('alice',1,1,1,'organizer',0,0);
      INSERT INTO patrol_series (id,first_date,local_time,interval_weeks,meeting_point,spots,created_by,created_at,updated_at)
        VALUES ('series','2026-10-20','20:30',2,'Meeting point',3,'organizer',0,0);
    `);
    const dates = [
      "2026-10-20",
      "2026-11-03",
      "2026-11-17",
      "2026-12-01",
      "2026-12-15",
      "2026-12-29",
    ];
    for (const date of dates) {
      db.prepare(
        `INSERT INTO event (id,type,series_id,occurrence_date,starts_at,meeting_point,spots,created_by,created_at,updated_at)
        VALUES (?,'patrol','series',?,?,'Meeting point',3,'organizer',0,0)`,
      ).run(date, date, vancouverOccurrenceInstant(date, "20:30"));
    }
    const series = {
      firstDate: dates[0],
      localTime: "20:30",
      intervalWeeks: 2,
      endDate: null,
    };
    const existing = dates.map((date) => ({
      occurrenceDate: date,
      startsAt: vancouverOccurrenceInstant(date, "20:30"),
      cancelledAt: null,
    }));
    const maintain = () =>
      db
        .prepare("UPDATE patrol_series SET generation_until=?")
        .run(planPatrolOccurrences(series, existing, now).generationUntil);
    const window = () =>
      db
        .prepare(
          `SELECT occurrence_date AS date FROM event e
      WHERE ${recurringSignupWindowSql()} ORDER BY starts_at`,
        )
        .all()
        .map((row) => row.date);
    const signup = db.prepare(
      "INSERT INTO signup (id,event_id,user_id,created_at,updated_at) VALUES (?,?,'alice',0,0)",
    );
    maintain();
    assert.deepEqual(window(), dates.slice(1, 5));
    signup.run("november-booking", dates[1]);
    assert.throws(
      () => signup.run("too-early", dates[5]),
      /recurring_signup_window/,
    );
    now = vancouverOccurrenceInstant("2026-10-30", "00:00");
    // The frontier only moves when maintenance runs.
    assert.deepEqual(window(), dates.slice(1, 5));
    maintain();
    assert.deepEqual(window(), dates.slice(1));
    signup.run("december-booking", dates[5]);
    assert.throws(() => signup.run("started", dates[0]), /signup_not_eligible/);
    assert.equal(
      db.prepare("SELECT status FROM signup WHERE id='november-booking'").get()
        ?.status,
      "confirmed",
    );
  } finally {
    db.close();
  }
});
