import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "vitest";

test("Discord migration preserves existing volunteers and drafts without inventing links or consent", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("PRAGMA foreign_keys=ON");
    const directory = new URL("../drizzle/", import.meta.url);
    const files = readdirSync(directory)
      .filter((file) => file.endsWith(".sql"))
      .sort();
    const discord = files.indexOf("0020_discord_connect.sql");
    for (const file of files.slice(0, discord))
      db.exec(readFileSync(new URL(file, directory), "utf8"));
    db.exec(`INSERT INTO user (id,name,email,role,created_at,updated_at) VALUES
      ('organizer','Organizer','organizer@example.org','organizer',1,1),
      ('legacy','Legacy','legacy@example.org','volunteer',1,1),
      ('draft','Draft','draft@example.org','volunteer',1,1);
      INSERT INTO profile (user_id,preferred_name,phone,birth_date,emergency_contact_name,emergency_contact_phone,
      emergency_contact_relationship,heard_about_us,motivation,teams,medical_certification,training_experience,registered_at,updated_at)
      VALUES ('legacy','Original name','555','2000-01-01','Contact','555','Friend','Friend','Help','["outreach"]','None','None',1,1);
      INSERT INTO volunteer_status (user_id,active,registration_approved,patrol_approved,approved_by,approved_at,updated_at)
        VALUES ('legacy',1,1,1,'organizer',1,1);
      INSERT INTO session (id,user_id,token,expires_at,created_at,updated_at)
        VALUES ('existing-session','legacy','existing-token',${Date.now() + 86_400_000},1,1);
      INSERT INTO event (id,type,starts_at,meeting_point,spots,created_by,created_at,updated_at)
        VALUES ('existing-patrol','patrol',${Date.now() + 86_400_000},'Meeting point',8,'organizer',1,1);
      INSERT INTO signup (id,event_id,user_id,created_at,updated_at)
        VALUES ('existing-booking','existing-patrol','legacy',1,1);
      INSERT INTO application_draft (user_id,version,revision,answers,updated_at) VALUES ('draft',1,'original','{"firstName":"Draft"}',1);`);
    const profile = db.prepare("SELECT * FROM profile").get(),
      draft = db.prepare("SELECT * FROM application_draft").get();
    const preservedTables = ["volunteer_status", "session", "event", "signup"];
    const before = preservedTables.map((table) =>
      db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all(),
    );
    for (const file of files.slice(discord))
      db.exec(readFileSync(new URL(file, directory), "utf8"));
    assert.deepEqual(db.prepare("SELECT * FROM profile").get(), profile);
    assert.deepEqual(
      db.prepare("SELECT * FROM application_draft").get(),
      draft,
    );
    assert.deepEqual(
      preservedTables.map((table) =>
        db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all(),
      ),
      before,
      "Existing approvals, active sessions, events and bookings must survive migration unchanged.",
    );
    assert.equal(
      db.prepare("SELECT registration_approved FROM volunteer_status").get()
        ?.registration_approved,
      1,
    );
    assert.equal(
      db.prepare("SELECT count(*) AS n FROM discord_requirement").get()?.n,
      0,
    );
    assert.equal(
      db.prepare("SELECT count(*) AS n FROM discord_link").get()?.n,
      0,
    );
    db.exec(`INSERT INTO profile (user_id,preferred_name,phone,birth_date,emergency_contact_name,emergency_contact_phone,
      emergency_contact_relationship,heard_about_us,motivation,teams,medical_certification,training_experience,registered_at,updated_at)
      SELECT 'draft',preferred_name,phone,birth_date,emergency_contact_name,emergency_contact_phone,
      emergency_contact_relationship,heard_about_us,motivation,teams,medical_certification,training_experience,2,2 FROM profile WHERE user_id='legacy'`);
    assert.deepEqual(
      db
        .prepare("SELECT user_id FROM discord_requirement")
        .all()
        .map((row) => row.user_id),
      ["draft"],
    );
  } finally {
    db.close();
  }
});
