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
import {
  approvedMedicSql,
  attendeeCategorySql,
  medicMarkSql,
} from "../src/server/db/sql";
import {
  localAccountCleanup,
  localAccountCleanupCandidates,
} from "../scripts/local-account-cleanup";

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
          `SELECT replace(u.id, 'local-account-v2-user-', '') AS preset, p.user_id IS NOT NULL AS submitted,
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
      [...manualAccountPresets]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((preset) => [
          preset.key,
          Number(!preset.draft),
          Number(preset.draft),
          Number(preset.naloxoneCompleted),
          Number(preset.applicationApproved),
          Number(!preset.draft && preset.active),
          Number(preset.patrolApproved),
          Number(preset.orientation === "completed"),
          Number(preset.orientation === "booked"),
          Number(
            preset.sampleKey === "dana" &&
              preset.applicationApproved &&
              preset.patrolApproved,
          ),
          preset.role,
        ]),
    );
    const names = db
      .prepare("SELECT name FROM user")
      .all()
      .map(({ name }) => String(name));
    assert.equal(new Set(names).size, manualAccountPresets.length);
    assert.equal(
      db.prepare("SELECT count(DISTINCT email) AS n FROM user").get()!.n,
      manualAccountPresets.length,
    );
    assert.ok(names.filter((name) => name.length <= 3).length >= 2);
    assert.ok(names.filter((name) => name.length >= 45).length >= 3);
    assert.ok(names.some((name) => name.length >= 60 && !name.includes(" ")));
    const rosterNames = db
      .prepare(
        "SELECT u.name FROM signup s JOIN user u ON u.id=s.user_id WHERE s.status='confirmed'",
      )
      .all()
      .map(({ name }) => String(name));
    assert.ok(rosterNames.some((name) => name.length <= 3));
    assert.ok(rosterNames.some((name) => name.length >= 45));
    // These are presentation types, not independent boolean flags. An approved
    // Medic always has the plus; an unapproved medic is New, never Medic.
    const approvedTypes = db
      .prepare(
        `SELECT DISTINCT
      CASE WHEN u.role='organizer' THEN 'Organizer'
        WHEN ${attendeeCategorySql("u.id")}='new-volunteer' THEN 'New'
        WHEN ${attendeeCategorySql("u.id")}='medic' THEN 'Medic' ELSE 'Outreach' END AS type,
      ${medicMarkSql("u.id")} AS medic, v.active
      FROM user u JOIN volunteer_status v ON v.user_id=u.id WHERE v.registration_approved=1`,
      )
      .all();
    assert.deepEqual(
      new Set(
        approvedTypes.map(
          ({ type, medic, active }) => `${type}:${medic}:${active}`,
        ),
      ),
      new Set(
        [
          "Outreach:0",
          "New:0",
          "New:1",
          "Medic:1",
          "Organizer:0",
          "Organizer:1",
        ].flatMap((type) => [0, 1].map((active) => `${type}:${active}`)),
      ),
    );
    const applicants = db
      .prepare(
        `SELECT DISTINCT CASE WHEN v.application_rejection_reason IS NOT NULL THEN 'rejected'
      WHEN p.naloxone_completed_at IS NOT NULL THEN 'ready' ELSE 'in-progress' END AS progress,
      EXISTS(SELECT 1 FROM json_each(p.teams) WHERE value='medic') AS medic
      FROM profile p JOIN volunteer_status v ON v.user_id=p.user_id WHERE v.registration_approved=0`,
      )
      .all();
    assert.deepEqual(
      new Set(applicants.map(({ progress, medic }) => `${progress}:${medic}`)),
      new Set(
        ["rejected", "ready", "in-progress"].flatMap((progress) =>
          [0, 1].map((medic) => `${progress}:${medic}`),
        ),
      ),
    );
    const profiles = db
      .prepare(
        "SELECT p.submitted_application, p.preferred_name, u.name, u.email FROM profile p JOIN user u ON u.id = p.user_id",
      )
      .all();
    assert.equal(profiles.length, manualAccountPresets.length - 1);
    for (const row of profiles) {
      const snapshot = JSON.parse(String(row.submitted_application));
      assert.deepEqual(profileSchema.parse(snapshot.answers), snapshot.answers);
      assert.equal(snapshot.email, row.email);
      assert.equal(snapshot.answers.preferredName, row.preferred_name);
      assert.equal(row.preferred_name, row.name);
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
      "UPDATE signup SET status='cancelled' WHERE id='local-account-v2-signup-orientation-booked'",
    );
    db.exec(
      "DELETE FROM orientation_completion WHERE user_id='local-account-v2-user-patrol'",
    );
    db.exec(
      "INSERT INTO application_draft_generation (user_id,generation) VALUES ('local-account-v2-user-draft','discarded')",
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

test("cleanup removes only untouched known legacy samples and empty marked applications, once", () => {
  const db = database();
  try {
    const now = Date.now();
    // Reconstruct the previous manual generation without changing shared test data.
    const previous = localAccountFixtures(now)
      .slice(localAccountCleanup(now).length)
      .map((sql) =>
        sql
          .replaceAll("local-account-v2-", "local-account-")
          .replaceAll(".v2.local@", ".local@"),
      );
    // Its identities/profiles must use the original shared names and answers.
    db.exec(previous.join(";\n"));
    for (const preset of manualAccountPresets.filter(({ draft }) => !draft)) {
      const id = `local-account-user-${preset.key}`;
      const sample = sampleProfileFixtures("local", now).find(
        ({ key }) => key === preset.sampleKey,
      )!;
      db.prepare("DELETE FROM profile WHERE user_id=?").run(id);
      db.prepare("UPDATE user SET name=? WHERE id=?").run(sample.name, id);
      db.exec(
        sampleProfileStatement(
          { ...sample, id, email: `${preset.key}.local@example.org` },
          now - 14 * 86400000,
          {
            naloxoneCompletedAt: preset.naloxoneCompleted
              ? now - 13 * 86400000
              : null,
          },
        )
          .replaceAll(',"expiredFirstAidDetails":""', "")
          .replaceAll(',"crisisInterventionDetails":""', ""),
      );
      db.prepare("DELETE FROM discord_requirement WHERE user_id=?").run(id);
    }
    db.exec(`INSERT INTO user (id,name,email,created_at,updated_at) VALUES ('real','Alex Chen','real@example.org',0,0);
      UPDATE profile SET preferred_name='Edited sample' WHERE user_id='local-account-user-accepted';
      INSERT INTO audit_log (id,actor_id,subject_id,action,created_at) VALUES ('history','local-account-user-organizer','local-account-user-awaiting-review','profile_viewed',1)`);
    const ids = [
      "local-application-00000000-0000-4000-8000-000000000001",
      "local-application-00000000-0000-4000-8000-000000000002",
    ];
    for (const id of ids) {
      db.prepare(
        "INSERT INTO user (id,name,email,email_verified,created_at,updated_at) VALUES (?,'New application',?,1,?,?)",
      ).run(id, `${id}@example.invalid`, now, now);
      db.prepare(
        "INSERT INTO account (id,user_id,account_id,provider_id,created_at,updated_at) VALUES (?,?,?,'local-development-application',?,?)",
      ).run(id, id, id, now, now);
    }
    db.prepare(
      "INSERT INTO application_draft (user_id,version,revision,answers,updated_at) VALUES (?,1,'saved','{}',?)",
    ).run(ids[1], now);
    const protectedIds = [
      "real",
      "local-account-user-accepted",
      "local-account-user-awaiting-review",
      "local-account-user-organizer",
      ids[1],
    ];
    const saved = protectedIds.map((id) =>
      db.prepare("SELECT * FROM user WHERE id=?").get(id),
    );
    const candidates = localAccountCleanupCandidates(now).flatMap((sql) =>
      db.prepare(sql).all(),
    );
    assert.ok(candidates.some(({ id }) => id === ids[0]));
    assert.ok(
      candidates.some(
        ({ id }) => id === "local-account-user-orientation-completed",
      ),
    );
    db.exec(localAccountCleanup(now).join(";\n"));
    assert.deepEqual(
      protectedIds.map((id) =>
        db.prepare("SELECT * FROM user WHERE id=?").get(id),
      ),
      saved,
    );
    assert.equal(
      db.prepare("SELECT 1 FROM user WHERE id=?").get(ids[0]),
      undefined,
    );
    assert.equal(
      db
        .prepare(
          "SELECT 1 FROM user WHERE id='local-account-user-orientation-completed'",
        )
        .get(),
      undefined,
    );
    assert.equal(
      db
        .prepare(
          "SELECT preferred_name FROM profile WHERE user_id='local-account-user-accepted'",
        )
        .get()!.preferred_name,
      "Edited sample",
    );
    db.exec(localAccountFixtures(now + 1000).join(";\n"));
    const before = [
      "user",
      "profile",
      "signup",
      "orientation_completion",
      "audit_log",
      "application_draft",
    ].map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all());
    db.exec(localAccountFixtures(now + 2000).join(";\n"));
    assert.deepEqual(
      [
        "user",
        "profile",
        "signup",
        "orientation_completion",
        "audit_log",
        "application_draft",
      ].map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()),
      before,
    );
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
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
    email: `${key}.v2.local@example.org`,
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
      "INSERT INTO two_factor (id,user_id,secret,backup_codes) VALUES ('keep','local-account-v2-user-organizer','secret','codes')",
    );
    const snapshots = db
      .prepare("SELECT submitted_application FROM profile ORDER BY user_id")
      .all();
    const originalFactor = db.prepare("SELECT * FROM two_factor").all();
    db.exec(localAccountFixtures(now + 1000).join(";\n"));
    assert.deepEqual(
      db
        .prepare(
          "SELECT submitted_application FROM profile WHERE user_id IN ('local-account-v2-user-accepted','local-account-v2-user-inactive','local-account-v2-user-organizer') ORDER BY user_id",
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
    WHERE user_id='local-account-v2-user-organizer';
    UPDATE audit_log SET changed_fields='["applicationApproved"]' WHERE id='local-account-v2-approval-organizer'`);
}

test("reseeding grants untouched existing Organizer presets patrol approval once and preserves their profile and authenticator", () => {
  const db = database();
  try {
    const now = Date.now();
    previousOrganizerPreset(db, now);
    db.exec(
      "INSERT INTO two_factor (id,user_id,secret,backup_codes) VALUES ('keep','local-account-v2-user-organizer','secret','codes')",
    );
    const profile = db
      .prepare(
        "SELECT * FROM profile WHERE user_id='local-account-v2-user-organizer'",
      )
      .get();
    const factor = db.prepare("SELECT * FROM two_factor").all();
    db.exec(localAccountFixtures(now + 1000).join(";\n"));
    const status = db
      .prepare(
        "SELECT * FROM volunteer_status WHERE user_id='local-account-v2-user-organizer'",
      )
      .get()!;
    assert.equal(status.registration_approved, 1);
    assert.equal(status.patrol_approved, 1);
    assert.equal(status.approved_by, localAccountUserId("organizer"));
    assert.equal(status.approved_at, now + 1000);
    assert.deepEqual(
      db
        .prepare(
          "SELECT * FROM profile WHERE user_id='local-account-v2-user-organizer'",
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
          "SELECT * FROM volunteer_status WHERE user_id='local-account-v2-user-organizer'",
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
    "UPDATE profile SET phone='604-555-0199' WHERE user_id='local-account-v2-user-organizer'",
    "UPDATE user SET email='changed@example.org' WHERE id='local-account-v2-user-organizer'",
    "UPDATE volunteer_status SET active=0 WHERE user_id='local-account-v2-user-organizer'",
    "UPDATE volunteer_status SET registration_approved=0 WHERE user_id='local-account-v2-user-organizer'",
    "INSERT INTO audit_log (id,actor_id,subject_id,action,changed_fields,created_at) VALUES ('revoked','local-account-v2-user-organizer','local-account-v2-user-organizer','approval_changed','[\"patrolApproved\"]',1)",
  ]) {
    const db = database();
    try {
      const now = Date.now();
      previousOrganizerPreset(db, now);
      // Deactivating the preset is valid only while another active organizer exists.
      db.exec(
        "UPDATE user SET role='organizer' WHERE id='local-account-v2-user-patrol'",
      );
      db.exec(change);
      const before = db
        .prepare(
          "SELECT * FROM volunteer_status WHERE user_id='local-account-v2-user-organizer'",
        )
        .get();
      db.exec(localAccountFixtures(now + 1000).join(";\n"));
      assert.deepEqual(
        db
          .prepare(
            "SELECT * FROM volunteer_status WHERE user_id='local-account-v2-user-organizer'",
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
      "UPDATE volunteer_status SET patrol_approved=0, approved_by=NULL, approved_at=NULL WHERE user_id='local-account-v2-user-organizer'",
    );
    db.exec(localAccountFixtures(now + 1000).join(";\n"));
    assert.equal(
      db
        .prepare(
          "SELECT patrol_approved FROM volunteer_status WHERE user_id='local-account-v2-user-organizer'",
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
    "UPDATE profile SET phone='604-555-0199' WHERE user_id='local-account-v2-user-accepted'",
    "UPDATE user SET email='changed@example.org' WHERE id='local-account-v2-user-accepted'",
    "UPDATE volunteer_status SET registration_approved=0 WHERE user_id='local-account-v2-user-accepted'",
    "INSERT INTO audit_log (id,actor_id,subject_id,action,created_at) VALUES ('viewed','local-account-v2-user-organizer','local-account-v2-user-accepted','profile_viewed',1)",
  ]) {
    const db = database();
    try {
      const now = Date.now();
      legacyManualPreset(db, "organizer", now);
      legacyManualPreset(db, "accepted", now);
      db.exec(change);
      const before = db
        .prepare(
          "SELECT * FROM profile WHERE user_id='local-account-v2-user-accepted'",
        )
        .get();
      db.exec(localAccountFixtures(now + 1000).join(";\n"));
      assert.deepEqual(
        db
          .prepare(
            "SELECT * FROM profile WHERE user_id='local-account-v2-user-accepted'",
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
      VALUES ('local-account-v2-event-orientation','orientation',?,'Original meeting point',12,1,'local-account-v2-user-organizer',?,?)`,
    ).run(now + 86_400_000, now, now);
    const event = db.prepare("SELECT * FROM event").get();
    db.exec(localAccountFixtures(now + 1000).join(";\n"));
    assert.deepEqual(
      db
        .prepare(
          "SELECT * FROM event WHERE id='local-account-v2-event-orientation'",
        )
        .get(),
      event,
    );
    assert.equal(
      db
        .prepare(
          "SELECT status FROM signup WHERE id='local-account-v2-signup-orientation-booked'",
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
