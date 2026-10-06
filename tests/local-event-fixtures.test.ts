import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  fixtureEventId,
  fixtureUserId,
  localEventFixtures,
} from "../scripts/local-event-fixtures";
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

test("the local seed refuses remote, preview, and production arguments before any writes", () => {
  for (const argument of ["--remote", "--preview", "--production"]) {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/seed-local-events.ts", argument],
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

test("local fixtures restore open, full, hidden, and past events in the real schema", () => {
  const db = database();
  try {
    const now = Date.now();
    db.exec(localEventFixtures(now).join(";\n"));
    assert.equal(db.prepare("SELECT count(*) AS n FROM event").get()!.n, 5);
    assert.equal(db.prepare("SELECT count(*) AS n FROM user").get()!.n, 7);
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
    assert.equal(full.spots, full.confirmed);
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
    const before = db.prepare("SELECT * FROM event ORDER BY id").all();
    db.exec(localEventFixtures(now + 1000).join(";\n"));
    assert.deepEqual(
      db.prepare("SELECT * FROM event ORDER BY id").all(),
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
