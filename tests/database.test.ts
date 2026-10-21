import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, test } from "vitest";

let db: DatabaseSync;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  const migrations = new URL("../drizzle/", import.meta.url);
  for (const name of readdirSync(migrations)
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    db.exec(readFileSync(new URL(name, migrations), "utf8"));
  }
  for (const id of ["organizer", "alice", "bob"]) {
    db.prepare(
      "INSERT INTO user (id, name, email, role, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 0)",
    ).run(
      id,
      id,
      `${id}@example.org`,
      id === "organizer" ? "organizer" : "volunteer",
    );
  }
  for (const id of ["alice", "bob"]) {
    db.prepare(
      `INSERT INTO profile (
      user_id, preferred_name, phone, birth_date, emergency_contact_name,
      emergency_contact_phone, emergency_contact_relationship, heard_about_us,
      motivation, teams, medical_certification, training_experience, registered_at, updated_at
    ) VALUES (?, ?, '555', '2000-01-01', 'Contact', '555', 'Friend', 'Friend', 'Help', '[]', 'None', 'None', 0, 0)`,
    ).run(id, id);
    db.prepare(
      "INSERT INTO volunteer_status (user_id, registration_approved, updated_at) VALUES (?, 1, 0)",
    ).run(id);
  }
  for (const type of ["patrol", "orientation"]) {
    db.prepare(
      `INSERT INTO event (id, type, starts_at, meeting_point, spots, created_by, created_at, updated_at)
      VALUES (?, ?, ?, 'Meeting point', ?, 'organizer', 0, 0)`,
    ).run(type, type, Date.now() + 86_400_000, type === "orientation" ? 2 : 1);
  }
});

afterEach(() => db.close());

function approve(id: string) {
  db.prepare(
    "UPDATE volunteer_status SET patrol_approved = 1, approved_by = 'organizer', approved_at = 0 WHERE user_id = ?",
  ).run(id);
}

function signUp(id: string, eventId: string, userId: string) {
  db.prepare(
    "INSERT INTO signup (id, event_id, user_id, created_at, updated_at) VALUES (?, ?, ?, 0, 0)",
  ).run(id, eventId, userId);
}

function anotherOrientation() {
  db.exec(`INSERT INTO event (id, type, starts_at, meeting_point, spots, created_by, created_at, updated_at)
    SELECT 'other-orientation', type, starts_at, meeting_point, spots, created_by, created_at, updated_at
    FROM event WHERE id = 'orientation'`);
}

test("first-orientation cap covers inserts, reactivation and reassignment but allows cancellation and moves", () => {
  anotherOrientation();
  signUp("first", "orientation", "alice");
  assert.throws(
    () => signUp("blocked", "other-orientation", "alice"),
    /orientation_signup_limit/,
  );
  db.exec("UPDATE signup SET status='cancelled' WHERE id='first'");
  signUp("replacement", "other-orientation", "alice");
  assert.throws(
    () => db.exec("UPDATE signup SET status='confirmed' WHERE id='first'"),
    /orientation_signup_limit/,
  );
  db.exec("UPDATE signup SET event_id='orientation' WHERE id='replacement'");
  signUp("bob-spot", "other-orientation", "bob");
  assert.throws(
    () => db.exec("UPDATE signup SET user_id='bob' WHERE id='replacement'"),
    /orientation_signup_limit/,
  );
});

test("patrol approval or recorded completion lifts the cap; existing excess bookings are preserved", () => {
  // Leave room for a completed volunteer as well as the reserved first-timer places.
  db.exec("UPDATE event SET spots=3 WHERE id='orientation'");
  anotherOrientation();
  approve("alice");
  signUp("first", "orientation", "alice");
  signUp("second", "other-orientation", "alice");
  db.exec(
    "UPDATE volunteer_status SET patrol_approved=0 WHERE user_id='alice'",
  );
  assert.equal(
    db
      .prepare("SELECT count(*) AS count FROM signup WHERE status='confirmed'")
      .get()?.count,
    2,
  );
  db.exec("UPDATE signup SET status='cancelled' WHERE id='first'");
  assert.throws(
    () => signUp("blocked", "orientation", "alice"),
    /orientation_signup_limit/,
  );
  db.exec(
    "INSERT INTO orientation_completion VALUES ('completion', 'alice', 'other-orientation', 'organizer', 0)",
  );
  signUp("oriented", "orientation", "alice");
});

function capacityPeople(prefix: string, count: number, completed = false) {
  db.exec(`INSERT INTO event (id,type,starts_at,meeting_point,spots,created_by,created_at,updated_at)
    SELECT 'history','orientation',0,'Past patrol',8,'organizer',0,0
    WHERE NOT EXISTS(SELECT 1 FROM event WHERE id='history')`);
  return Array.from({ length: count }, (_, index) => {
    const id = `${prefix}-${index}`;
    db.prepare(
      "INSERT INTO user (id,name,email,created_at,updated_at) VALUES (?,?,?,0,0)",
    ).run(id, id, `${id}@example.org`);
    db.prepare(
      `INSERT INTO profile (user_id,preferred_name,phone,birth_date,emergency_contact_name,
      emergency_contact_phone,emergency_contact_relationship,heard_about_us,motivation,teams,
      medical_certification,training_experience,registered_at,updated_at)
      SELECT ?,preferred_name,phone,birth_date,emergency_contact_name,emergency_contact_phone,
        emergency_contact_relationship,heard_about_us,motivation,teams,medical_certification,
        training_experience,registered_at,updated_at FROM profile WHERE user_id='alice'`,
    ).run(id);
    db.prepare(
      "INSERT INTO volunteer_status (user_id,registration_approved,updated_at) VALUES (?,1,0)",
    ).run(id);
    // Patrol approval must NOT make someone an orientation-completed volunteer.
    approve(id);
    if (completed)
      db.prepare(
        "INSERT INTO orientation_completion VALUES (?,?, 'history','organizer',0)",
      ).run(`${id}-completion`, id);
    return id;
  });
}

test("orientation patrol reserves two total-capacity places without requiring two bookings", () => {
  db.exec("UPDATE event SET spots=8,includes_orientation=1 WHERE id='patrol'");
  const completed = capacityPeople("completed", 7, true);
  for (const id of completed.slice(0, 6)) signUp(id, "patrol", id);
  assert.throws(
    () => signUp(completed[6], "patrol", completed[6]),
    /orientation_places_reserved/,
  );
  assert.equal(
    db.prepare("SELECT open FROM event WHERE id='patrol'").get()?.open,
    1,
  );
  assert.equal(
    db.prepare("SELECT count(*) n FROM signup WHERE status='confirmed'").get()
      ?.n,
    6,
  );
  const firstTimers = capacityPeople("new", 3);
  signUp(firstTimers[0], "patrol", firstTimers[0]);
  // One first-timer neither blocks nor cancels the patrol; the other place stays reserved.
  assert.throws(
    () => signUp(completed[6], "patrol", completed[6]),
    /orientation_places_reserved/,
  );
  signUp(firstTimers[1], "patrol", firstTimers[1]);
  assert.throws(
    () => signUp(firstTimers[2], "patrol", firstTimers[2]),
    /event_full/,
  );
});

test("four first-timers maximum also guards reactivation, moves and attendee reassignment", () => {
  db.exec(
    "UPDATE event SET spots=12,includes_orientation=1 WHERE id='orientation'; UPDATE event SET spots=12 WHERE id='patrol'",
  );
  const people = capacityPeople("new", 5);
  for (const id of people.slice(0, 4)) signUp(id, "orientation", id);
  assert.throws(
    () => signUp("fifth", "orientation", people[4]),
    /orientation_places_full/,
  );
  db.prepare(
    "INSERT INTO signup (id,event_id,user_id,status,created_at,updated_at) VALUES ('reactivate','orientation',?,'cancelled',0,0)",
  ).run(people[4]);
  assert.throws(
    () => db.exec("UPDATE signup SET status='confirmed' WHERE id='reactivate'"),
    /orientation_places_full/,
  );
  signUp("move", "patrol", people[4]);
  assert.throws(
    () => db.exec("UPDATE signup SET event_id='orientation' WHERE id='move'"),
    /orientation_places_full/,
  );
  assert.equal(
    db.prepare("SELECT event_id FROM signup WHERE id='move'").get()?.event_id,
    "patrol",
  );
  const completed = capacityPeople("completed", 1, true)[0];
  signUp("swap", "orientation", completed);
  assert.throws(
    () =>
      db.prepare("UPDATE signup SET user_id=? WHERE id='swap'").run(people[4]),
    /orientation_places_full/,
  );
  db.prepare("UPDATE signup SET status='cancelled' WHERE id=?").run(people[0]);
  db.exec("UPDATE signup SET status='confirmed' WHERE id='reactivate'");
});

test("orientation toggles and capacity edits reject incompatible bookings and preserve history", () => {
  assert.throws(
    () => db.exec("UPDATE event SET includes_orientation=1 WHERE id='patrol'"),
    /orientation_minimum_capacity/,
  );
  assert.throws(
    () =>
      db.exec(`INSERT INTO event (id,type,starts_at,meeting_point,spots,created_by,created_at,updated_at)
    SELECT 'invalid-orientation','orientation',starts_at,meeting_point,1,created_by,created_at,updated_at FROM event WHERE id='patrol'`),
    /orientation_minimum_capacity/,
  );
  db.exec("UPDATE event SET spots=8 WHERE id='patrol'");
  const completed = capacityPeople("completed", 7, true);
  for (const id of completed) signUp(id, "patrol", id);
  assert.throws(
    () => db.exec("UPDATE event SET includes_orientation=1 WHERE id='patrol'"),
    /orientation_edit_conflict/,
  );
  db.prepare("UPDATE signup SET status='cancelled' WHERE id=?").run(
    completed[6],
  );
  db.exec("UPDATE event SET includes_orientation=1 WHERE id='patrol'");
  assert.throws(
    () => db.exec("UPDATE event SET spots=7 WHERE id='patrol'"),
    /orientation_edit_conflict/,
  );
  signUp("needs-orientation", "patrol", "alice");
  assert.throws(
    () => db.exec("UPDATE event SET includes_orientation=0 WHERE id='patrol'"),
    /orientation_edit_conflict/,
  );
  assert.equal(
    db.prepare("SELECT count(*) n FROM signup WHERE status='confirmed'").get()
      ?.n,
    7,
  );
  assert.throws(
    () => db.exec("UPDATE event SET includes_orientation=0 WHERE id='history'"),
    /orientation_edit_conflict/,
  );
  assert.equal(
    db.prepare("SELECT count(*) n FROM orientation_completion").get()?.n,
    7,
  );
});

test("application approval is required for orientation inserts, reactivation and moves", () => {
  db.exec(
    "UPDATE volunteer_status SET registration_approved=0 WHERE user_id='alice'",
  );
  approve("alice");
  for (const eventId of ["orientation", "patrol"])
    assert.throws(
      () => signUp(eventId, eventId, "alice"),
      /signup_not_eligible/,
    );
  db.exec(
    "UPDATE volunteer_status SET registration_approved=1 WHERE user_id='alice'",
  );
  signUp("spot", "orientation", "alice");
  db.exec(
    "UPDATE volunteer_status SET registration_approved=0 WHERE user_id='alice'",
  );
  assert.throws(
    () => db.exec("UPDATE signup SET event_id='patrol' WHERE id='spot'"),
    /signup_not_eligible/,
  );
  db.exec("UPDATE signup SET status='cancelled' WHERE id='spot'");
  assert.throws(
    () => db.exec("UPDATE signup SET status='confirmed' WHERE id='spot'"),
    /signup_not_eligible/,
  );
});

test("approval is independent of orientation completion", () => {
  assert.throws(
    () => signUp("before", "patrol", "alice"),
    /signup_not_eligible/,
  );
  db.exec(
    "INSERT INTO orientation_completion VALUES ('completion', 'alice', 'orientation', 'organizer', 0)",
  );
  assert.throws(
    () => signUp("completed", "patrol", "alice"),
    /signup_not_eligible/,
  );
  approve("alice");
  signUp("approved", "patrol", "alice");
  approve("bob");
  signUp("no-orientation", "orientation", "bob");
});

test("approval without any orientation allows patrol signup", () => {
  approve("alice");
  signUp("approved", "patrol", "alice");
});

test("only an organizer can be recorded as the approver", () => {
  assert.throws(
    () =>
      db.exec(
        "UPDATE volunteer_status SET patrol_approved = 1, approved_by = 'bob', approved_at = 0 WHERE user_id = 'alice'",
      ),
    /approval_requires_organizer/,
  );
});

test("last spot cannot be overbooked, including by reactivation or moving", () => {
  const reserved = capacityPeople("reserved", 1)[0];
  signUp("reserved", "orientation", reserved);
  signUp("first", "orientation", "alice");
  assert.throws(() => signUp("second", "orientation", "bob"), /event_full/);
  db.exec("UPDATE signup SET status = 'cancelled' WHERE id = 'first'");
  signUp("second", "orientation", "bob");
  assert.throws(
    () => db.exec("UPDATE signup SET status = 'confirmed' WHERE id = 'first'"),
    /event_full/,
  );
  approve("alice");
  signUp("patrol-spot", "patrol", "alice");
  assert.throws(
    () =>
      db.exec(
        "UPDATE signup SET event_id = 'orientation' WHERE id = 'patrol-spot'",
      ),
    /event_full/,
  );
});

test("duplicate confirmed signup is rejected, cancelled signup permits a new one", () => {
  db.exec("UPDATE event SET spots = 3 WHERE id = 'orientation'");
  signUp("first", "orientation", "alice");
  assert.throws(() => signUp("duplicate", "orientation", "alice"), /UNIQUE/);
  db.exec("UPDATE signup SET status = 'cancelled' WHERE id = 'first'");
  signUp("replacement", "orientation", "alice");
});

test("inactive accounts, missing applications, closed, hidden, cancelled and started events reject signups", () => {
  db.exec("UPDATE volunteer_status SET active = 0 WHERE user_id = 'alice'");
  assert.throws(
    () => signUp("inactive", "orientation", "alice"),
    /signup_not_eligible/,
  );
  db.exec(
    "UPDATE volunteer_status SET active = 1 WHERE user_id = 'alice'; DELETE FROM profile WHERE user_id = 'alice'",
  );
  assert.throws(
    () => signUp("no-application", "orientation", "alice"),
    /signup_not_eligible/,
  );
  db.exec("UPDATE event SET open = 0 WHERE id = 'orientation'");
  assert.throws(
    () => signUp("closed", "orientation", "bob"),
    /signup_not_eligible/,
  );
  db.exec("UPDATE event SET open = 1, hidden = 1 WHERE id = 'orientation'");
  assert.throws(
    () => signUp("hidden", "orientation", "bob"),
    /signup_not_eligible/,
  );
  db.exec(
    "UPDATE event SET hidden = 0, cancelled_at = 1 WHERE id = 'orientation'",
  );
  assert.throws(
    () => signUp("cancelled", "orientation", "bob"),
    /signup_not_eligible/,
  );
  db.exec(
    "UPDATE event SET cancelled_at = NULL, starts_at = 0 WHERE id = 'orientation'",
  );
  assert.throws(
    () => signUp("past", "orientation", "bob"),
    /signup_not_eligible/,
  );
});

test("capacity cannot shrink below existing signups", () => {
  db.exec("UPDATE event SET spots = 2 WHERE id = 'orientation'");
  signUp("first", "orientation", "alice");
  signUp("second", "orientation", "bob");
  assert.throws(
    () => db.exec("UPDATE event SET spots = 1 WHERE id = 'orientation'"),
    /capacity_below_signups|orientation_minimum_capacity/,
  );
});

test("patrol cannot be recorded as an orientation completion", () => {
  assert.throws(
    () =>
      db.exec(
        "INSERT INTO orientation_completion VALUES ('wrong', 'alice', 'patrol', 'organizer', 0)",
      ),
    /not_an_orientation/,
  );
});

test("emails are unique regardless of capitalization", () => {
  assert.throws(
    () =>
      db.exec(
        "INSERT INTO user (id, name, email, created_at, updated_at) VALUES ('duplicate', 'Duplicate', 'ALICE@example.org', 0, 0)",
      ),
    /UNIQUE/,
  );
});
