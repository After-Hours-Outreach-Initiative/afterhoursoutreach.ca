import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, test } from "node:test";

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
      "INSERT INTO volunteer_status (user_id, updated_at) VALUES (?, 0)",
    ).run(id);
  }
  for (const type of ["patrol", "orientation"]) {
    db.prepare(
      `INSERT INTO event (id, type, starts_at, meeting_point, spots, created_by, created_at, updated_at)
      VALUES (?, ?, ?, 'Meeting point', 1, 'organizer', 0, 0)`,
    ).run(type, type, Date.now() + 86_400_000);
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

test("inactive, unregistered, closed, hidden, cancelled and started events reject signups", () => {
  db.exec("UPDATE volunteer_status SET active = 0 WHERE user_id = 'alice'");
  assert.throws(
    () => signUp("inactive", "orientation", "alice"),
    /signup_not_eligible/,
  );
  db.exec(
    "UPDATE volunteer_status SET active = 1 WHERE user_id = 'alice'; DELETE FROM profile WHERE user_id = 'alice'",
  );
  assert.throws(
    () => signUp("unregistered", "orientation", "alice"),
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
    /capacity_below_signups/,
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
