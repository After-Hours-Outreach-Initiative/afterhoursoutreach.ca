import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { sql } from "drizzle-orm";
import { check, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { afterEach, test } from "vitest";
import { createTestHarness } from "wrangler";
import {
  generateDatabaseMigration,
  parseTriggers,
} from "../scripts/generate-db";
import journal from "../drizzle/meta/_journal.json";

const directories: string[] = [];
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true });
});
function scratchDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "aho-db-migrations-"));
  directories.push(directory);
  return directory;
}
function database() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  return db;
}
const schema = {
  note: sqliteTable("note", {
    id: integer().primaryKey(),
    title: text().notNull(),
  }),
};
const triggers = parseTriggers(`CREATE TRIGGER note_title_insert
BEFORE INSERT ON note
BEGIN
  SELECT RAISE(ABORT, 'empty_title') WHERE NEW.title = '';
END;`);

test("checked-in migrations are generated, unedited, and match the current sources", async () => {
  assert.equal(await generateDatabaseMigration({ check: true }), null);
});

test("recurrence and orientation migrations preserve existing events, bookings, completions, audits and pending email", () => {
  const db = database();
  db.exec("PRAGMA foreign_keys=ON");
  const migrate = (tag: string) => {
    db.exec("BEGIN");
    db.exec(
      readFileSync(new URL(`../drizzle/${tag}.sql`, import.meta.url), "utf8"),
    );
    db.exec("COMMIT");
  };
  for (const { tag } of journal.entries.filter(({ idx }) => idx < 14))
    migrate(tag);
  db.exec(`
    INSERT INTO user (id,name,email,role,created_at,updated_at) VALUES ('existing','Sample','sample@example.org','organizer',0,0);
    INSERT INTO profile (user_id,preferred_name,phone,birth_date,emergency_contact_name,emergency_contact_phone,emergency_contact_relationship,heard_about_us,motivation,teams,medical_certification,training_experience,registered_at,updated_at)
      VALUES ('existing','Sample','555','2000-01-01','Contact','555','Friend','Friend','Help','[]','None','None',0,0);
    INSERT INTO volunteer_status (user_id,registration_approved,updated_at) VALUES ('existing',1,0);
    INSERT INTO event (id,type,starts_at,meeting_point,spots,created_by,created_at,updated_at)
      VALUES ('existing-event','orientation',${Date.now() + 86_400_000},'Sample point',1,'existing',0,0);
    INSERT INTO signup (id,event_id,user_id,created_at,updated_at) VALUES ('existing-booking','existing-event','existing',0,0);
    INSERT INTO orientation_completion VALUES ('existing-completion','existing','existing-event','existing',0);
    INSERT INTO event_audit VALUES ('existing-audit','existing-event','existing','created','[]',0);
    INSERT INTO event_notification (id,operation_id,user_id,subject,body,delivery_to,created_at)
      VALUES ('existing-mail','existing-audit','existing','Sample subject','Sample body','sample@example.org',0);
  `);
  const tables = [
    "user",
    "profile",
    "volunteer_status",
    "signup",
    "orientation_completion",
    "event_audit",
    "event_notification",
  ];
  const before = tables.map((table) =>
    db.prepare(`SELECT * FROM ${table}`).all(),
  );
  const oldEvent = db.prepare("SELECT * FROM event").get();
  migrate("0014_patrol_submission_integration");
  assert.deepEqual(
    tables.map((table) => db.prepare(`SELECT * FROM ${table}`).all()),
    before,
  );
  const { series_id, occurrence_date, ...event } = db
    .prepare("SELECT * FROM event")
    .get()!;
  assert.deepEqual(event, { ...oldEvent });
  assert.equal(series_id, null);
  assert.equal(occurrence_date, null);
  const recurrenceEvent = db.prepare("SELECT * FROM event").get();
  migrate("0015_patrol_orientation_capacity");
  assert.deepEqual(
    tables.map((table) => db.prepare(`SELECT * FROM ${table}`).all()),
    before,
  );
  const { includes_orientation, ...orientationEvent } = db
    .prepare("SELECT * FROM event")
    .get()!;
  assert.deepEqual(orientationEvent, { ...recurrenceEvent });
  assert.equal(includes_orientation, null);
  const legacyEvent = db.prepare("SELECT * FROM event").get();
  db.exec(`INSERT INTO patrol_series (id,first_date,local_time,interval_weeks,meeting_point,spots,includes_orientation,created_by,created_at,updated_at)
    VALUES ('legacy-series','2030-01-01','20:00',1,'Meeting point',1,1,'existing',0,0);
    INSERT INTO patrol_series_template (id,series_id,effective_date,local_time,meeting_point,spots,open,hidden,includes_orientation)
    VALUES ('legacy-template','legacy-series','2030-01-08','20:00','Meeting point',1,1,0,1)`);
  const legacySeries = db.prepare("SELECT * FROM patrol_series").get();
  const legacyTemplate = db
    .prepare("SELECT * FROM patrol_series_template")
    .get();
  migrate("0016_orientation_minimum_capacity");
  migrate("0017_medic_orientee_reservations");
  assert.deepEqual(db.prepare("SELECT * FROM event").get(), legacyEvent);
  assert.deepEqual(
    db.prepare("SELECT * FROM patrol_series").get(),
    legacySeries,
  );
  assert.deepEqual(
    db.prepare("SELECT * FROM patrol_series_template").get(),
    legacyTemplate,
  );
  assert.deepEqual(
    tables.map((table) => db.prepare(`SELECT * FROM ${table}`).all()),
    before,
  );
  assert.throws(
    () =>
      db.exec(
        "UPDATE event SET meeting_point='Edited point' WHERE id='existing-event'",
      ),
    /event_minimum_capacity/,
  );
  assert.deepEqual(db.prepare("SELECT * FROM event").get(), legacyEvent);
  assert.throws(
    () =>
      db.exec(
        "UPDATE patrol_series SET end_date='2030-12-31' WHERE id='legacy-series'",
      ),
    /event_minimum_capacity/,
  );
  assert.throws(
    () =>
      db.exec(
        "UPDATE patrol_series_template SET meeting_point='Edited point' WHERE id='legacy-template'",
      ),
    /event_minimum_capacity/,
  );
  assert.equal(
    db
      .prepare(
        "SELECT coalesce(includes_orientation, type='orientation') AS includesOrientation FROM event",
      )
      .get()?.includesOrientation,
    1,
  );
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  assert.equal(
    db
      .prepare("SELECT count(*) n FROM application_submission_notification")
      .get()?.n,
    0,
  );
});

test("the Code of Conduct migration preserves existing profiles without inventing acknowledgement", () => {
  const db = database();
  db.exec(
    readFileSync(
      new URL("../drizzle/0000_database.sql", import.meta.url),
      "utf8",
    ),
  );
  db.exec(`
    INSERT INTO user (id, name, email, created_at, updated_at)
      VALUES ('existing', 'Existing volunteer', 'existing@example.org', 1, 1);
    INSERT INTO profile (
      user_id, preferred_name, phone, birth_date, emergency_contact_name,
      emergency_contact_phone, emergency_contact_relationship, heard_about_us,
      motivation, teams, medical_certification, training_experience, registered_at, updated_at
    ) VALUES ('existing', 'Existing volunteer', '604-555-0100', '1995-04-12',
      'Contact', '604-555-0101', 'Friend', 'Friend', 'Help', '["outreach"]', 'None', 'None', 1, 1);
  `);
  const before = db.prepare("SELECT * FROM profile").get();
  db.exec(
    readFileSync(
      new URL("../drizzle/0001_code_of_conduct.sql", import.meta.url),
      "utf8",
    ),
  );
  const after = db.prepare("SELECT * FROM profile").get()!;
  const { code_of_conduct_version, code_of_conduct_accepted_at, ...answers } =
    after;
  assert.equal(code_of_conduct_version, null);
  assert.equal(code_of_conduct_accepted_at, null);
  assert.deepEqual(answers, { ...before });
});

test("application approval migration gates existing volunteers without dropping profiles, patrol approvals or signups", () => {
  const db = database();
  for (const name of ["0000_database", "0001_code_of_conduct"])
    db.exec(
      readFileSync(new URL(`../drizzle/${name}.sql`, import.meta.url), "utf8"),
    );
  db.exec(`
    INSERT INTO user (id, name, email, role, created_at, updated_at)
      VALUES ('organizer', 'Organizer', 'organizer@example.org', 'organizer', 1, 1),
        ('existing', 'Existing volunteer', 'existing@example.org', 'volunteer', 1, 1);
    INSERT INTO profile (
      user_id, preferred_name, phone, birth_date, emergency_contact_name,
      emergency_contact_phone, emergency_contact_relationship, heard_about_us,
      motivation, teams, medical_certification, training_experience, registered_at, updated_at
    ) VALUES ('existing', 'Existing volunteer', '604-555-0100', '1995-04-12',
      'Contact', '604-555-0101', 'Friend', 'Friend', 'Help', '["outreach"]', 'None', 'None', 1, 1);
    INSERT INTO volunteer_status (user_id, patrol_approved, approved_by, approved_at, updated_at)
      VALUES ('existing', 1, 'organizer', 1, 1);
    INSERT INTO event (id, type, starts_at, meeting_point, spots, created_by, created_at, updated_at)
      VALUES ('orientation', 'orientation', ${Date.now() + 86_400_000}, 'Meeting point', 2, 'organizer', 1, 1);
    INSERT INTO signup (id, event_id, user_id, created_at, updated_at)
      VALUES ('existing-signup', 'orientation', 'existing', 1, 1);
  `);
  const tables = ["user", "profile", "event", "signup"];
  const before = tables.map((table) =>
    db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all(),
  );
  const beforeStatus = db.prepare("SELECT * FROM volunteer_status").get();
  db.exec(
    readFileSync(
      new URL("../drizzle/0002_registration_approval.sql", import.meta.url),
      "utf8",
    ),
  );
  assert.deepEqual(
    tables.map((table) =>
      db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all(),
    ),
    before,
  );
  const { registration_approved, ...status } = db
    .prepare("SELECT * FROM volunteer_status")
    .get()!;
  assert.equal(registration_approved, 0);
  assert.deepEqual(status, { ...beforeStatus });
  assert.throws(
    () =>
      db.exec(
        "INSERT INTO signup (id, event_id, user_id, created_at, updated_at) VALUES ('blocked', 'orientation', 'existing', 1, 1)",
      ),
    /signup_not_eligible/,
  );
});

test("medical certification migrations preserve legacy answers without guessing selections or expiry", () => {
  const db = database();
  for (const name of [
    "0000_database",
    "0001_code_of_conduct",
    "0002_registration_approval",
  ])
    db.exec(
      readFileSync(new URL(`../drizzle/${name}.sql`, import.meta.url), "utf8"),
    );
  db.exec(`
    INSERT INTO user (id, name, email, created_at, updated_at)
      VALUES ('existing', 'Existing volunteer', 'existing@example.org', 1, 1);
    INSERT INTO profile (
      user_id, preferred_name, phone, birth_date, emergency_contact_name,
      emergency_contact_phone, emergency_contact_relationship, heard_about_us,
      motivation, teams, medical_certification, training_experience, registered_at, updated_at
    ) VALUES ('existing', 'Existing volunteer', '604-555-0100', '1995-04-12',
      'Contact', '604-555-0101', 'Friend', 'Friend', 'Help', '["outreach","medic"]', 'Legacy certification', 'Training', 1, 1);
  `);
  const before = db.prepare("SELECT * FROM profile").get();
  const triggersBefore = db
    .prepare(
      "SELECT name, sql FROM sqlite_master WHERE type='trigger' ORDER BY name",
    )
    .all();
  db.exec(
    readFileSync(
      new URL("../drizzle/0003_medical_certifications.sql", import.meta.url),
      "utf8",
    ),
  );
  const { medical_certifications, ...after } = db
    .prepare("SELECT * FROM profile")
    .get()!;
  assert.equal(medical_certifications, "[]");
  assert.deepEqual(after, { ...before });
  const beforeExpiry = db.prepare("SELECT * FROM profile").get();
  db.exec(
    readFileSync(
      new URL("../drizzle/0004_certification_expiry.sql", import.meta.url),
      "utf8",
    ),
  );
  const { medical_certification_expiry, ...afterExpiry } = db
    .prepare("SELECT * FROM profile")
    .get()!;
  assert.equal(medical_certification_expiry, null);
  assert.deepEqual(afterExpiry, { ...beforeExpiry });
  const beforeTraining = db.prepare("SELECT * FROM profile").get();
  db.exec(
    readFileSync(
      new URL("../drizzle/0005_relevant_training.sql", import.meta.url),
      "utf8",
    ),
  );
  const { relevant_training, other_training, ...afterTraining } = db
    .prepare("SELECT * FROM profile")
    .get()!;
  assert.equal(relevant_training, "[]");
  assert.equal(other_training, "");
  assert.deepEqual(afterTraining, { ...beforeTraining });
  assert.deepEqual(
    db
      .prepare(
        "SELECT name, sql FROM sqlite_master WHERE type='trigger' ORDER BY name",
      )
      .all(),
    triggersBefore,
  );
});

test("generation creates runnable schema and triggers and is a no-op without changes", async () => {
  const directory = scratchDirectory();
  const options = { directory, schema, triggers };
  assert.equal(await generateDatabaseMigration(options), "0000_database.sql");
  const contents = readFileSync(join(directory, "0000_database.sql"), "utf8");
  const journal = readFileSync(
    join(directory, "meta", "_journal.json"),
    "utf8",
  );
  assert.equal(await generateDatabaseMigration(options), null);
  assert.equal(
    await generateDatabaseMigration({ ...options, check: true }),
    null,
  );
  assert.equal(
    readFileSync(join(directory, "0000_database.sql"), "utf8"),
    contents,
  );
  assert.equal(
    readFileSync(join(directory, "meta", "_journal.json"), "utf8"),
    journal,
  );
  const db = database();
  db.exec(contents);
  db.exec("INSERT INTO note VALUES (1, 'Sample')");
  assert.throws(
    () => db.exec("INSERT INTO note (id,title) VALUES (2, '')"),
    /empty_title/,
  );
});

test("changed trigger definitions produce a new frozen migration and remove old triggers", async () => {
  const directory = scratchDirectory();
  await generateDatabaseMigration({ directory, schema, triggers });
  const initial = readFileSync(join(directory, "0000_database.sql"), "utf8");
  const replacement = parseTriggers(`CREATE TRIGGER note_length_insert
BEFORE INSERT ON note
BEGIN
  SELECT RAISE(ABORT, 'long_title') WHERE length(NEW.title) > 10;
END;`);
  const options = { directory, schema, triggers: replacement };
  await assert.rejects(
    generateDatabaseMigration({ ...options, check: true }),
    /db:generate/,
  );
  assert.equal(await generateDatabaseMigration(options), "0001_database.sql");
  assert.equal(
    readFileSync(join(directory, "0000_database.sql"), "utf8"),
    initial,
  );
  const db = database();
  db.exec(initial);
  db.exec("INSERT INTO note VALUES (1, 'Sample')");
  db.exec(readFileSync(join(directory, "0001_database.sql"), "utf8"));
  assert.deepEqual(
    db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all(),
    [Object.assign(Object.create(null), { name: "note_length_insert" })],
  );
  assert.equal(
    db.prepare("SELECT title FROM note WHERE id=1").get()?.title,
    "Sample",
  );
  db.exec("INSERT INTO note VALUES (2, '')");
  assert.throws(
    () => db.exec("INSERT INTO note VALUES (3, 'This is too long')"),
    /long_title/,
  );
});

test("schema rebuilds preserve data and reinstall unchanged triggers", async () => {
  const directory = scratchDirectory();
  await generateDatabaseMigration({ directory, schema, triggers });
  const updatedSchema = {
    note: sqliteTable(
      "note",
      {
        id: integer().primaryKey(),
        title: text().notNull(),
        added_nullable: text(),
        added_default: integer().notNull().default(7),
      },
      (table) => [
        check("note_title_length", sql`length(${table.title}) <= 100`),
      ],
    ),
  };
  const options = { directory, schema: updatedSchema, triggers };
  await assert.rejects(
    generateDatabaseMigration({ ...options, check: true }),
    /db:generate/,
  );
  await generateDatabaseMigration(options);
  const update = readFileSync(join(directory, "0001_database.sql"), "utf8");
  assert.match(update, /DROP TABLE/);
  assert.ok(update.indexOf("DROP TRIGGER") < update.indexOf("DROP TABLE"));
  const db = database();
  db.exec(readFileSync(join(directory, "0000_database.sql"), "utf8"));
  db.exec("INSERT INTO note VALUES (1, 'Sample')");
  db.exec(update);
  assert.equal(
    db.prepare("SELECT title FROM note WHERE id=1").get()?.title,
    "Sample",
  );
  assert.equal(
    db.prepare("SELECT added_nullable FROM note").get()?.added_nullable,
    null,
  );
  assert.equal(
    db.prepare("SELECT added_default FROM note").get()?.added_default,
    7,
  );
  assert.throws(
    () => db.exec("INSERT INTO note (id,title) VALUES (2, '')"),
    /empty_title/,
  );
  assert.equal(
    await generateDatabaseMigration({ ...options, check: true }),
    null,
  );
});

test("removing all triggers generates their removal", async () => {
  const directory = scratchDirectory();
  await generateDatabaseMigration({ directory, schema, triggers });
  await generateDatabaseMigration({ directory, schema, triggers: [] });
  const db = database();
  for (const name of readdirSync(directory)
    .filter((name) => name.endsWith(".sql"))
    .sort())
    db.exec(readFileSync(join(directory, name), "utf8"));
  assert.equal(
    db
      .prepare(
        "SELECT count(*) AS count FROM sqlite_master WHERE type='trigger'",
      )
      .get()?.count,
    0,
  );
});

test("generated table rebuilds preserve referenced rows and triggers in D1", async () => {
  const directory = scratchDirectory();
  const original = {
    ...schema,
    link: sqliteTable("note_link", {
      id: integer().primaryKey(),
      note_id: integer()
        .notNull()
        .references(() => schema.note.id),
    }),
  };
  await generateDatabaseMigration({ directory, schema: original, triggers });
  const main = join(directory, "worker.mjs");
  writeFileSync(main, "export default { fetch() { return new Response(); } };");
  const harness = createTestHarness({
    workers: [
      {
        config: {
          name: "database-generation-test",
          compatibility_date: "2026-08-16",
          main,
          d1_databases: [
            {
              binding: "DB",
              database_name: "database-generation-test",
              database_id: "00000000-0000-0000-0000-000000000000",
              migrations_dir: directory,
              remote: false,
            },
          ],
        },
      },
    ],
  });
  try {
    await harness.listen();
    const worker = harness.getWorker<Pick<Env, "DB">>();
    await worker.applyD1Migrations("DB");
    const { DB } = await worker.getEnv();
    await DB.batch([
      DB.prepare("INSERT INTO note VALUES (1, 'Sample')"),
      DB.prepare("INSERT INTO note_link VALUES (1, 1)"),
    ]);
    await generateDatabaseMigration({
      directory,
      triggers,
      schema: {
        ...original,
        note: sqliteTable(
          "note",
          {
            id: integer().primaryKey(),
            title: text().notNull(),
            added_nullable: text(),
            added_default: integer().notNull().default(7),
          },
          (table) => [
            check("note_title_length", sql`length(${table.title}) <= 100`),
          ],
        ),
      },
    });
    await worker.applyD1Migrations("DB");
    assert.equal(
      (await DB.prepare("SELECT title FROM note WHERE id=1").first())?.title,
      "Sample",
    );
    assert.deepEqual(
      await DB.prepare(
        "SELECT added_nullable,added_default FROM note WHERE id=1",
      ).first(),
      {
        added_nullable: null,
        added_default: 7,
      },
    );
    assert.equal(
      (await DB.prepare("SELECT note_id FROM note_link WHERE id=1").first())
        ?.note_id,
      1,
    );
    await assert.rejects(
      DB.prepare("INSERT INTO note (id,title) VALUES (2, '')").run(),
      /empty_title/,
    );
    await assert.rejects(
      DB.prepare("INSERT INTO note_link VALUES (2, 99)").run(),
      /FOREIGN KEY/,
    );
  } finally {
    await harness.close();
  }
});

test("unsafe D1 rebuilds with cascading child relationships are refused", async () => {
  const directory = scratchDirectory();
  const original = {
    ...schema,
    link: sqliteTable("note_link", {
      id: integer().primaryKey(),
      note_id: integer().references(() => schema.note.id, {
        onDelete: "cascade",
      }),
    }),
  };
  await generateDatabaseMigration({ directory, schema: original, triggers });
  await assert.rejects(
    generateDatabaseMigration({
      directory,
      triggers,
      schema: {
        ...original,
        note: sqliteTable(
          "note",
          {
            id: integer().primaryKey(),
            title: text().notNull(),
          },
          (table) => [
            check("note_title_length", sql`length(${table.title}) <= 100`),
          ],
        ),
      },
    }),
    /cannot safely rebuild note.*CASCADE/,
  );
  assert.deepEqual(
    readdirSync(directory).filter((name) => name.endsWith(".sql")),
    ["0000_database.sql"],
  );
});

test("hand-edited or untracked SQL output is rejected", async () => {
  const directory = scratchDirectory();
  const options = { directory, schema, triggers };
  await generateDatabaseMigration(options);
  const path = join(directory, "0000_database.sql");
  const initial = readFileSync(path, "utf8");
  writeFileSync(path, initial + "-- manual edit\n");
  await assert.rejects(
    generateDatabaseMigration({ ...options, check: true }),
    /was edited/,
  );
  writeFileSync(path, initial);
  writeFileSync(join(directory, "0001_untracked.sql"), "SELECT 1;");
  await assert.rejects(generateDatabaseMigration(options), /do not match/);
});

test("invalid trigger sources fail before writing any output", async () => {
  assert.throws(() => parseTriggers("SELECT 1;"), /exactly one/);
  assert.throws(
    () => parseTriggers(triggers[0].sql + "\n" + triggers[0].sql),
    /exactly one/,
  );
  assert.throws(
    () =>
      parseTriggers(
        triggers[0].sql + "\n--> statement-breakpoint\n" + triggers[0].sql,
      ),
    /Duplicate/,
  );
  const directory = scratchDirectory();
  const invalid = parseTriggers(
    "CREATE TRIGGER broken BEFORE INSERT ON note BEGIN nonsense; END;",
  );
  await assert.rejects(
    generateDatabaseMigration({ directory, schema, triggers: invalid }),
    /syntax error/,
  );
  assert.deepEqual(readdirSync(directory), []);
});
