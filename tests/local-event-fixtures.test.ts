import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "vitest";
import {
  localAccountFixtures,
  localAccountUserId,
} from "../scripts/local-account-fixtures";
import {
  fixtureEventId,
  fixtureUserId,
  localEventFixtures,
} from "../scripts/local-event-fixtures";
import { vancouverInput } from "../src/data/event-time";
import { profileSchema } from "../src/server/db/profiles";
import { assertCompleteSampleProfiles } from "./helpers/sample-profile-fixtures";
import {
  manualAccountPresets,
  developmentAccountStatus,
} from "../src/dev/accounts";
import {
  sampleProfileFixtures,
  sampleProfileStatement,
} from "../scripts/sample-profile-fixtures";
import { approvedMedicSql } from "../src/server/db/sql";

function database() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  const directory = new URL("../drizzle/", import.meta.url);
  for (const name of readdirSync(directory)
    .filter((name) => name.endsWith(".sql"))
    .sort())
    db.exec(readFileSync(new URL(name, directory), "utf8"));
  return db;
}

test("the local seed refuses nonlocal targets and unknown arguments before any writes", () => {
  for (const args of [
    ["--remote"],
    ["--preview"],
    ["--production"],
    ["--unknown"],
    ["--accounts"],
    ["--test-fixtures", "--remote"],
  ]) {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/seed-local-events.ts", ...args],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Usage: pnpm db:seed:local/);
    assert.doesNotMatch(
      result.stdout,
      /Executing|test events and sample accounts are ready/,
    );
  }
});

test("manual presets cover application, orientation, patrol, medic and access states in the current schema", () => {
  const db = database();
  try {
    const now = Date.now();
    db.exec(localAccountFixtures(now).join(";\n"));
    assert.deepEqual(
      db
        .prepare(
          `SELECT substr(u.id, 20) AS preset, p.user_id IS NOT NULL AS submitted,
          EXISTS(SELECT 1 FROM application_draft WHERE user_id=u.id) AS draft,
          p.naloxone_completed_at IS NOT NULL AS naloxone,
          coalesce(v.registration_approved, 0), coalesce(v.active, 0), coalesce(v.patrol_approved, 0),
          EXISTS(SELECT 1 FROM orientation_completion WHERE user_id=u.id) AS orientation,
          EXISTS(SELECT 1 FROM signup s JOIN event e ON e.id=s.event_id WHERE s.user_id=u.id AND s.status='confirmed' AND e.starts_at>${now}) AS booked,
          ${approvedMedicSql("u.id")} AS medic, u.role
          FROM user u LEFT JOIN profile p ON p.user_id = u.id
          LEFT JOIN volunteer_status v ON v.user_id = u.id ORDER BY u.id`,
        )
        .all()
        .map((row) => Object.values(row)),
      [
        ["accepted", 1, 0, 1, 1, 1, 0, 0, 0, 0, "volunteer"],
        ["applied", 1, 0, 0, 0, 1, 0, 0, 0, 0, "volunteer"],
        ["awaiting-review", 1, 0, 1, 0, 1, 0, 0, 0, 0, "volunteer"],
        ["draft", 0, 1, 0, 0, 0, 0, 0, 0, 0, "volunteer"],
        ["inactive", 1, 0, 1, 1, 0, 0, 0, 0, 0, "volunteer"],
        ["medic", 1, 0, 1, 1, 1, 1, 1, 0, 1, "volunteer"],
        ["medic-new-volunteer", 1, 0, 1, 1, 1, 0, 0, 0, 0, "volunteer"],
        ["organizer", 1, 0, 1, 1, 1, 1, 0, 0, 0, "organizer"],
        ["orientation-booked", 1, 0, 1, 1, 1, 0, 0, 1, 0, "volunteer"],
        ["orientation-completed", 1, 0, 1, 1, 1, 0, 1, 0, 0, "volunteer"],
        ["patrol", 1, 0, 1, 1, 1, 1, 1, 0, 0, "volunteer"],
      ],
    );
    const profiles = db
      .prepare(
        "SELECT p.submitted_application, u.email FROM profile p JOIN user u ON u.id = p.user_id",
      )
      .all();
    assert.equal(profiles.length, manualAccountPresets.length - 1);
    for (const row of profiles) {
      const snapshot = JSON.parse(String(row.submitted_application));
      assert.deepEqual(profileSchema.parse(snapshot.answers), snapshot.answers);
      assert.equal(snapshot.email, row.email);
      assert.equal(
        snapshot.submittedAt,
        new Date(now - 14 * 86_400_000).toISOString(),
      );
    }
    assert.equal(
      db.prepare("SELECT count(*) AS n FROM application_draft").get()!.n,
      1,
    );
    assert.equal(
      db
        .prepare(
          "SELECT count(*) AS n FROM event WHERE open = 1 AND hidden = 0 AND starts_at > ?",
        )
        .get(now)!.n,
      2,
    );
    // Reseeding must not undo manual changes to a scenario.
    db.prepare(
      "UPDATE volunteer_status SET registration_approved = 1 WHERE user_id = ?",
    ).run(localAccountUserId("applied"));
    db.exec(
      "UPDATE signup SET status='cancelled' WHERE id='local-account-signup-orientation-booked'",
    );
    db.exec(
      "DELETE FROM orientation_completion WHERE user_id='local-account-user-patrol'",
    );
    db.exec(
      "INSERT INTO application_draft_generation (user_id,generation) VALUES ('local-account-user-draft','discarded')",
    );
    const tables = [
      "user",
      "profile",
      "volunteer_status",
      "event",
      "signup",
      "orientation_completion",
      "audit_log",
      "application_draft",
      "application_draft_generation",
    ];
    const before = tables.map((table) =>
      db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all(),
    );
    db.exec(localAccountFixtures(now + 1000).join(";\n"));
    assert.deepEqual(
      tables.map((table) =>
        db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all(),
      ),
      before,
    );
  } finally {
    db.close();
  }
});

function legacyManualPreset(
  db: DatabaseSync,
  key: "accepted" | "inactive" | "organizer",
  now: number,
) {
  const sampleKey = { accepted: "alex", inactive: "jamie", organizer: "robin" }[
    key
  ];
  const person = {
    ...sampleProfileFixtures("local", now).find(
      (person) => person.key === sampleKey,
    )!,
    id: localAccountUserId(key),
    email: `${key}.local@example.org`,
  };
  db.prepare(
    "INSERT INTO user (id,name,email,email_verified,role,created_at,updated_at) VALUES (?,?,?,1,?,?,?)",
  ).run(
    person.id,
    { accepted: "Accepted", inactive: "Inactive", organizer: "Organizer" }[key],
    person.email,
    key === "organizer" ? "organizer" : "volunteer",
    now,
    now,
  );
  db.exec(sampleProfileStatement(person, now));
  db.prepare(
    "INSERT INTO volunteer_status (user_id,active,registration_approved,updated_at) VALUES (?,?,?,?)",
  ).run(person.id, key === "inactive" ? 0 : 1, key === "inactive" ? 0 : 1, now);
}

test("reseeding upgrades only untouched old manual fixtures without replacing their snapshots or authenticators", () => {
  const db = database();
  try {
    const now = Date.now();
    for (const key of ["accepted", "inactive", "organizer"] as const)
      legacyManualPreset(db, key, now);
    db.exec(
      "INSERT INTO two_factor (id,user_id,secret,backup_codes) VALUES ('keep','local-account-user-organizer','secret','codes')",
    );
    const snapshots = db
      .prepare("SELECT submitted_application FROM profile ORDER BY user_id")
      .all();
    const originalFactor = db.prepare("SELECT * FROM two_factor").all();
    db.exec(localAccountFixtures(now + 1000).join(";\n"));
    assert.deepEqual(
      db
        .prepare(
          "SELECT submitted_application FROM profile WHERE user_id IN ('local-account-user-accepted','local-account-user-inactive','local-account-user-organizer') ORDER BY user_id",
        )
        .all(),
      snapshots,
    );
    assert.deepEqual(
      db.prepare("SELECT * FROM two_factor").all(),
      originalFactor,
    );
    for (const key of ["accepted", "inactive", "organizer"]) {
      const row = db
        .prepare(
          "SELECT p.naloxone_completed_at, v.registration_approved, v.patrol_approved FROM profile p JOIN volunteer_status v ON v.user_id=p.user_id WHERE p.user_id=?",
        )
        .get(localAccountUserId(key))!;
      assert.equal(row.naloxone_completed_at, now + 1000);
      assert.equal(row.registration_approved, 1);
      assert.equal(row.patrol_approved, key === "organizer" ? 1 : 0);
    }
    const before = db.prepare("SELECT * FROM audit_log ORDER BY id").all();
    db.exec(localAccountFixtures(now + 2000).join(";\n"));
    assert.deepEqual(
      db.prepare("SELECT * FROM audit_log ORDER BY id").all(),
      before,
    );
  } finally {
    db.close();
  }
});

function previousOrganizerPreset(db: DatabaseSync, now: number) {
  db.exec(localAccountFixtures(now).join(";\n"));
  // Recreate the exact previous seed version, before Organizer had patrol approval.
  db.exec(`UPDATE volunteer_status SET patrol_approved=0, approved_by=NULL, approved_at=NULL
    WHERE user_id='local-account-user-organizer';
    UPDATE audit_log SET changed_fields='["applicationApproved"]' WHERE id='local-account-approval-organizer'`);
}

test("reseeding grants untouched existing Organizer presets patrol approval once and preserves their profile and authenticator", () => {
  const db = database();
  try {
    const now = Date.now();
    previousOrganizerPreset(db, now);
    db.exec(
      "INSERT INTO two_factor (id,user_id,secret,backup_codes) VALUES ('keep','local-account-user-organizer','secret','codes')",
    );
    const profile = db
      .prepare(
        "SELECT * FROM profile WHERE user_id='local-account-user-organizer'",
      )
      .get();
    const factor = db.prepare("SELECT * FROM two_factor").all();
    db.exec(localAccountFixtures(now + 1000).join(";\n"));
    const status = db
      .prepare(
        "SELECT * FROM volunteer_status WHERE user_id='local-account-user-organizer'",
      )
      .get()!;
    assert.equal(status.registration_approved, 1);
    assert.equal(status.patrol_approved, 1);
    assert.equal(status.approved_by, localAccountUserId("organizer"));
    assert.equal(status.approved_at, now + 1000);
    assert.deepEqual(
      db
        .prepare(
          "SELECT * FROM profile WHERE user_id='local-account-user-organizer'",
        )
        .get(),
      profile,
    );
    assert.deepEqual(db.prepare("SELECT * FROM two_factor").all(), factor);
    const audits = db.prepare("SELECT * FROM audit_log ORDER BY id").all();
    db.exec(localAccountFixtures(now + 2000).join(";\n"));
    assert.deepEqual(
      db
        .prepare(
          "SELECT * FROM volunteer_status WHERE user_id='local-account-user-organizer'",
        )
        .get(),
      status,
    );
    assert.deepEqual(
      db.prepare("SELECT * FROM audit_log ORDER BY id").all(),
      audits,
    );
  } finally {
    db.close();
  }
});

test("reseeding does not overwrite edited or deliberately revoked Organizer access", () => {
  for (const change of [
    "UPDATE profile SET phone='604-555-0199' WHERE user_id='local-account-user-organizer'",
    "UPDATE user SET email='changed@example.org' WHERE id='local-account-user-organizer'",
    "UPDATE volunteer_status SET active=0 WHERE user_id='local-account-user-organizer'",
    "UPDATE volunteer_status SET registration_approved=0 WHERE user_id='local-account-user-organizer'",
    "INSERT INTO audit_log (id,actor_id,subject_id,action,changed_fields,created_at) VALUES ('revoked','local-account-user-organizer','local-account-user-organizer','approval_changed','[\"patrolApproved\"]',1)",
  ]) {
    const db = database();
    try {
      const now = Date.now();
      previousOrganizerPreset(db, now);
      // Deactivating the preset is valid only while another active organizer exists.
      db.exec(
        "UPDATE user SET role='organizer' WHERE id='local-account-user-patrol'",
      );
      db.exec(change);
      const before = db
        .prepare(
          "SELECT * FROM volunteer_status WHERE user_id='local-account-user-organizer'",
        )
        .get();
      db.exec(localAccountFixtures(now + 1000).join(";\n"));
      assert.deepEqual(
        db
          .prepare(
            "SELECT * FROM volunteer_status WHERE user_id='local-account-user-organizer'",
          )
          .get(),
        before,
      );
    } finally {
      db.close();
    }
  }
  // A new fully-approved preset must not be reapproved after a manual revocation,
  // even if that direct local database edit omitted an audit/timestamp update.
  const db = database();
  try {
    const now = Date.now();
    db.exec(localAccountFixtures(now).join(";\n"));
    db.exec(
      "UPDATE volunteer_status SET patrol_approved=0, approved_by=NULL, approved_at=NULL WHERE user_id='local-account-user-organizer'",
    );
    db.exec(localAccountFixtures(now + 1000).join(";\n"));
    assert.equal(
      db
        .prepare(
          "SELECT patrol_approved FROM volunteer_status WHERE user_id='local-account-user-organizer'",
        )
        .get()!.patrol_approved,
      0,
    );
  } finally {
    db.close();
  }
});

test("old presets with changed answers, identity, access, or audited activity are never upgraded", () => {
  for (const change of [
    "UPDATE profile SET phone='604-555-0199' WHERE user_id='local-account-user-accepted'",
    "UPDATE user SET email='changed@example.org' WHERE id='local-account-user-accepted'",
    "UPDATE volunteer_status SET registration_approved=0 WHERE user_id='local-account-user-accepted'",
    "INSERT INTO audit_log (id,actor_id,subject_id,action,created_at) VALUES ('viewed','local-account-user-organizer','local-account-user-accepted','profile_viewed',1)",
  ]) {
    const db = database();
    try {
      const now = Date.now();
      legacyManualPreset(db, "organizer", now);
      legacyManualPreset(db, "accepted", now);
      db.exec(change);
      const before = db
        .prepare(
          "SELECT * FROM profile WHERE user_id='local-account-user-accepted'",
        )
        .get();
      db.exec(localAccountFixtures(now + 1000).join(";\n"));
      assert.deepEqual(
        db
          .prepare(
            "SELECT * FROM profile WHERE user_id='local-account-user-accepted'",
          )
          .get(),
        before,
      );
    } finally {
      db.close();
    }
  }
});

test("new booking presets work alongside preserved legacy events", () => {
  const db = database();
  try {
    const now = Date.now();
    legacyManualPreset(db, "organizer", now);
    db.prepare(
      `INSERT INTO event (id,type,starts_at,meeting_point,spots,open,created_by,created_at,updated_at)
      VALUES ('local-account-event-orientation','orientation',?,'Original meeting point',12,1,'local-account-user-organizer',?,?)`,
    ).run(now + 86_400_000, now, now);
    const event = db.prepare("SELECT * FROM event").get();
    db.exec(localAccountFixtures(now + 1000).join(";\n"));
    assert.deepEqual(
      db
        .prepare(
          "SELECT * FROM event WHERE id='local-account-event-orientation'",
        )
        .get(),
      event,
    );
    assert.equal(
      db
        .prepare(
          "SELECT status FROM signup WHERE id='local-account-signup-orientation-booked'",
        )
        .get()!.status,
      "confirmed",
    );
  } finally {
    db.close();
  }
});

test("account descriptions follow edited database state rather than preset names", () => {
  const state = {
    submittedAt: 0,
    naloxoneCompletedAt: 0,
    applicationApproved: true,
    hasDraft: false,
    active: true,
    patrolApproved: true,
    orientationCompleted: true,
    orientationBooked: false,
    medicSelected: true,
    medicEligible: true,
    twoFactorEnabled: false,
  };
  assert.match(
    developmentAccountStatus(state),
    /Application complete.*Medic eligible/,
  );
  assert.match(
    developmentAccountStatus({
      ...state,
      active: false,
      applicationApproved: false,
      medicEligible: false,
    }),
    /Awaiting application approval.*Inactive.*Not medic eligible/,
  );
  assert.equal(
    developmentAccountStatus({ ...state, submittedAt: null, hasDraft: true }),
    "Draft saved · Not submitted",
  );
});

test("local fixtures restore open, full, hidden, and past events in the real schema", () => {
  const db = database();
  try {
    const now = Date.now();
    db.exec(localEventFixtures(now).join(";\n"));
    assert.equal(db.prepare("SELECT count(*) AS n FROM event").get()!.n, 5);
    assert.equal(db.prepare("SELECT count(*) AS n FROM user").get()!.n, 7);
    assertCompleteSampleProfiles(db, now);
    assert.equal(
      db
        .prepare("SELECT count(*) AS n FROM profile WHERE user_id = ?")
        .get(fixtureUserId("first-sign-in"))!.n,
      0,
    );
    const orientation = db
      .prepare("SELECT starts_at, spots FROM event WHERE id = ?")
      .get(fixtureEventId("orientation"))!;
    assert.equal(
      vancouverInput(Number(orientation.starts_at)).slice(-5),
      "18:00",
    );
    assert.equal(orientation.spots, 12);
    const full = db
      .prepare(
        "SELECT spots, (SELECT count(*) FROM signup WHERE event_id = event.id AND status = 'confirmed') AS confirmed FROM event WHERE id = ?",
      )
      .get(fixtureEventId("full-patrol"))!;
    assert.equal(full.spots, Number(full.confirmed) + 2);
    const hidden = db
      .prepare("SELECT open, hidden FROM event WHERE id = ?")
      .get(fixtureEventId("hidden-orientation"))!;
    assert.equal(hidden.open, 0);
    assert.equal(hidden.hidden, 1);
    assert.ok(
      Number(
        db
          .prepare("SELECT starts_at FROM event WHERE id = ?")
          .get(fixtureEventId("past-orientation"))!.starts_at,
      ) < now,
    );
    assert.equal(
      db.prepare("SELECT count(*) AS n FROM orientation_completion").get()!.n,
      1,
    );
    assert.equal(
      db
        .prepare(
          "SELECT patrol_approved FROM volunteer_status WHERE user_id = ?",
        )
        .get(fixtureUserId("alex"))!.patrol_approved,
      0,
    );
    assert.equal(
      db
        .prepare("SELECT two_factor_enabled FROM user WHERE id = ?")
        .get(fixtureUserId("robin"))!.two_factor_enabled,
      0,
    );
  } finally {
    db.close();
  }
});

test("rerunning the local seed preserves edits, cancellations, approvals, and unrelated data", () => {
  const db = database();
  try {
    const now = Date.now();
    db.exec(localEventFixtures(now).join(";\n"));
    db.prepare(
      "UPDATE event SET meeting_point = 'Edited meeting point', updated_at = ? WHERE id = ?",
    ).run(now + 1, fixtureEventId("patrol"));
    db.exec(
      "UPDATE signup SET status = 'cancelled' WHERE id = 'local-fixture-signup-casey'",
    );
    db.prepare(
      "UPDATE volunteer_status SET patrol_approved = 0 WHERE user_id = ?",
    ).run(fixtureUserId("dana"));
    db.prepare(
      "UPDATE profile SET preferred_name = 'Edited name' WHERE user_id = ?",
    ).run(fixtureUserId("casey"));
    db.prepare("UPDATE user SET role = 'volunteer' WHERE id = ?").run(
      fixtureUserId("robin"),
    );
    db.exec(
      "INSERT INTO user (id, name, email, created_at, updated_at) VALUES ('unrelated', 'Keep me', 'keep@example.org', 0, 0)",
    );
    const tables = [
      "user",
      "profile",
      "volunteer_status",
      "event",
      "signup",
      "orientation_completion",
    ];
    const before = tables.map((table) =>
      db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all(),
    );
    // Existing IDs must be skipped before insertion-only database validation.
    db.exec(`CREATE TRIGGER reject_reseeded_events BEFORE INSERT ON event
      BEGIN SELECT RAISE(ABORT, 'unexpected_event_insert'); END`);
    db.exec(localEventFixtures(now + 1000).join(";\n"));
    assert.deepEqual(
      tables.map((table) =>
        db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all(),
      ),
      before,
    );
    assert.equal(
      db
        .prepare(
          "SELECT status FROM signup WHERE id = 'local-fixture-signup-casey'",
        )
        .get()!.status,
      "cancelled",
    );
    assert.equal(
      db
        .prepare(
          "SELECT patrol_approved FROM volunteer_status WHERE user_id = ?",
        )
        .get(fixtureUserId("dana"))!.patrol_approved,
      0,
    );
    assert.equal(
      db
        .prepare("SELECT preferred_name FROM profile WHERE user_id = ?")
        .get(fixtureUserId("casey"))!.preferred_name,
      "Edited name",
    );
    assert.equal(db.prepare("SELECT count(*) AS n FROM user").get()!.n, 8);
    assert.equal(db.prepare("SELECT count(*) AS n FROM signup").get()!.n, 3);
    assert.equal(
      db.prepare("SELECT count(*) AS n FROM event_notification").get()!.n,
      0,
    );
  } finally {
    db.close();
  }
});

test("local reseeding atomically repairs only old synthetic profiles, without losing linked records", () => {
  const db = database();
  try {
    const now = Date.now();
    db.exec(localEventFixtures(now).join(";\n"));
    // Recreate pre-snapshot fixture rows without changing the immutable trigger.
    for (const key of ["casey", "alex", "dana"]) {
      const id = fixtureUserId(key);
      db.prepare("DELETE FROM profile WHERE user_id = ?").run(id);
      db.prepare(
        `INSERT INTO profile (user_id, preferred_name, phone, birth_date,
        emergency_contact_name, emergency_contact_phone, emergency_contact_relationship,
        heard_about_us, motivation, teams, medical_certification, training_experience, registered_at, updated_at)
        VALUES (?, 'Old combined name', '604-555-0100', '1995-04-12', 'Sample contact',
        '604-555-0101', 'Friend', 'A friend', 'Old answer', '["outreach"]', 'Standard first aid', 'Community volunteering', 0, 0)`,
      ).run(id);
    }
    // A fixture-looking ID with a different identity is not synthetic seed data.
    db.prepare(
      "UPDATE user SET email = 'not-a-fixture@example.org' WHERE id = ?",
    ).run(fixtureUserId("dana"));
    db.exec(`INSERT INTO session (id, user_id, token, expires_at, created_at, updated_at)
      VALUES ('keep-session', 'local-fixture-user-casey', 'fixture-session-token', ${now + 60000}, 0, 0);
      INSERT INTO two_factor (id, user_id, secret, backup_codes)
      VALUES ('keep-factor', 'local-fixture-user-casey', 'fixture-secret', 'fixture-codes');
      INSERT INTO account (id, user_id, account_id, provider_id, password, created_at, updated_at)
      VALUES ('keep-account', 'local-fixture-user-casey', 'local-fixture-user-casey', 'credential', 'fixture-hash', 0, 0)`);
    const tables = [
      "user",
      "volunteer_status",
      "event",
      "signup",
      "orientation_completion",
      "session",
      "two_factor",
      "account",
    ];
    const before = tables.map((table) =>
      db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all(),
    );
    const protectedProfile = db
      .prepare("SELECT * FROM profile WHERE user_id = ?")
      .get(fixtureUserId("dana"));
    const old = db
      .prepare("SELECT * FROM profile WHERE user_id = ?")
      .get(fixtureUserId("casey"));
    assert.throws(
      () =>
        db
          .prepare(
            "UPDATE profile SET submitted_application = '{}' WHERE user_id = ?",
          )
          .run(fixtureUserId("casey")),
      /submitted_application_immutable/,
    );
    db.exec(`CREATE TRIGGER fail_fixture_repair AFTER INSERT ON profile
      WHEN NEW.user_id = 'local-fixture-user-casey' BEGIN SELECT RAISE(ABORT, 'test_failure'); END`);
    assert.throws(
      () => db.exec(localEventFixtures(now + 1000).join(";\n")),
      /test_failure/,
    );
    assert.deepEqual(
      db
        .prepare("SELECT * FROM profile WHERE user_id = ?")
        .get(fixtureUserId("casey")),
      old,
    );
    db.exec("DROP TRIGGER fail_fixture_repair");
    db.exec(localEventFixtures(now + 2000).join(";\n"));
    for (const key of ["casey", "alex"]) {
      const repaired = db
        .prepare(
          "SELECT first_name, submitted_application FROM profile WHERE user_id = ?",
        )
        .get(fixtureUserId(key))!;
      assert.equal(
        JSON.parse(String(repaired.submitted_application)).answers.firstName,
        repaired.first_name,
      );
      assert.ok(repaired.first_name);
    }
    assert.deepEqual(
      db
        .prepare("SELECT * FROM profile WHERE user_id = ?")
        .get(fixtureUserId("dana")),
      protectedProfile,
    );
    assert.deepEqual(
      tables.map((table) =>
        db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all(),
      ),
      before,
    );
  } finally {
    db.close();
  }
});
