import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  previewEventFixtures,
  previewEventId,
  previewUserId,
} from "../scripts/preview-event-fixtures";
import { vancouverInput } from "../src/data/event-time";

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

test("preview seed refuses target overrides before running Wrangler", () => {
  for (const argument of [
    "--local",
    "--remote",
    "--production",
    "--env=production",
  ]) {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/seed-preview-events.ts", argument],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Usage: pnpm db:seed:preview/);
    assert.doesNotMatch(result.stdout, /Executing|sample volunteers/);
  }
});

test("preview fixtures use the real schema without credentials, privileges, or queued email", () => {
  const db = database();
  try {
    const now = Date.now();
    db.exec(previewEventFixtures(now).join(";\n"));
    assert.equal(db.prepare("SELECT count(*) AS n FROM user").get()!.n, 6);
    assert.equal(db.prepare("SELECT count(*) AS n FROM profile").get()!.n, 6);
    assert.equal(
      db
        .prepare("SELECT count(*) AS n FROM volunteer_status WHERE active=0")
        .get()!.n,
      1,
    );
    assert.equal(db.prepare("SELECT count(*) AS n FROM event").get()!.n, 5);
    assert.equal(db.prepare("SELECT count(*) AS n FROM signup").get()!.n, 4);
    for (const table of [
      "account",
      "session",
      "verification",
      "two_factor",
      "event_notification",
      "organizer_bootstrap",
    ])
      assert.equal(
        db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n,
        0,
      );
    assert.equal(
      db
        .prepare(
          "SELECT count(*) AS n FROM user WHERE role='organizer' OR email_verified=1",
        )
        .get()!.n,
      0,
    );
    assert.equal(
      db
        .prepare(
          "SELECT count(*) AS n FROM volunteer_status WHERE patrol_approved=1",
        )
        .get()!.n,
      0,
    );
    assert.equal(
      db
        .prepare(
          "SELECT count(*) AS n FROM user WHERE email LIKE '%@preview.example.invalid' AND name LIKE '%(sample)'",
        )
        .get()!.n,
      6,
    );
    const events = db
      .prepare("SELECT starts_at, meeting_point FROM event")
      .all();
    assert.ok(
      events.every(
        (event) =>
          Number(event.starts_at) > now &&
          String(event.meeting_point).startsWith("[Sample]"),
      ),
    );
    const orientation = db
      .prepare("SELECT starts_at FROM event WHERE id=?")
      .get(previewEventId("orientation"))!;
    assert.equal(
      vancouverInput(Number(orientation.starts_at)).slice(-5),
      "18:00",
    );
    const full = db
      .prepare(
        "SELECT spots, (SELECT count(*) FROM signup WHERE event_id=event.id AND status='confirmed') AS confirmed FROM event WHERE id=?",
      )
      .get(previewEventId("full-orientation"))!;
    assert.equal(full.spots, full.confirmed);
    assert.equal(
      db
        .prepare("SELECT hidden FROM event WHERE id=?")
        .get(previewEventId("hidden-orientation"))!.hidden,
      1,
    );
    assert.equal(
      db
        .prepare("SELECT open FROM event WHERE id=?")
        .get(previewEventId("closed-patrol"))!.open,
      0,
    );
  } finally {
    db.close();
  }
});

test("preview reseeding preserves existing accounts, fixture edits, and cancelled or ineligible signups", () => {
  const db = database();
  try {
    const now = Date.now();
    db.exec(
      "INSERT INTO user (id, name, email, role, created_at, updated_at) VALUES ('existing', 'Keep me', 'existing@example.org', 'organizer', 0, 0)",
    );
    db.exec(previewEventFixtures(now).join(";\n"));
    db.prepare(
      "UPDATE event SET meeting_point='Edited meeting point', updated_at=? WHERE id=?",
    ).run(now + 1, previewEventId("patrol"));
    db.prepare(
      "UPDATE profile SET preferred_name='Edited name' WHERE user_id=?",
    ).run(previewUserId("casey"));
    db.exec(
      "UPDATE signup SET status='cancelled' WHERE id='preview-fixture-signup-casey'",
    );
    db.exec("DELETE FROM signup WHERE id='preview-fixture-signup-alex'");
    db.prepare("UPDATE volunteer_status SET active=0 WHERE user_id=?").run(
      previewUserId("alex"),
    );
    const tables = ["user", "profile", "volunteer_status", "event", "signup"];
    const before = tables.map((table) =>
      db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all(),
    );
    db.exec(previewEventFixtures(now + 1000).join(";\n"));
    assert.deepEqual(
      tables.map((table) =>
        db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all(),
      ),
      before,
    );
    db.prepare("UPDATE volunteer_status SET active=1 WHERE user_id=?").run(
      previewUserId("alex"),
    );
    db.prepare("UPDATE event SET open=0 WHERE id=?").run(
      previewEventId("orientation"),
    );
    db.exec(previewEventFixtures(now + 2000).join(";\n"));
    assert.equal(
      db
        .prepare(
          "SELECT count(*) AS n FROM signup WHERE id='preview-fixture-signup-alex'",
        )
        .get()!.n,
      0,
    );
  } finally {
    db.close();
  }
});
