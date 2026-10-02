import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { createDatabase } from "../src/server/db";
import { event } from "../src/server/db/schema";

test("Drizzle and capacity constraints work in the D1 runtime", async () => {
  const runtime = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: "export default { fetch() { return new Response('ok'); } }",
      compatibilityDate: "2026-08-16",
      compatibilityFlags: ["nodejs_compat"],
      d1Databases: { DB: "test-db" },
    }),
  );
  try {
    const binding = await runtime.getD1Database("DB");
    const migrations = new URL("../drizzle/", import.meta.url);
    for (const name of readdirSync(migrations)
      .filter((name) => name.endsWith(".sql"))
      .sort()) {
      const statements = readFileSync(new URL(name, migrations), "utf8")
        .split("--> statement-breakpoint")
        .map((statement) => statement.trim())
        .filter(Boolean);
      await binding.batch(
        statements.map((statement) => binding.prepare(statement)),
      );
    }
    for (const id of ["organizer", "alice", "bob"]) {
      await binding
        .prepare(
          "INSERT INTO user (id, name, email, role, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 0)",
        )
        .bind(
          id,
          id,
          `${id}@example.org`,
          id === "organizer" ? "organizer" : "volunteer",
        )
        .run();
    }
    for (const id of ["alice", "bob"]) {
      await binding
        .prepare(
          `INSERT INTO profile (
        user_id, preferred_name, phone, birth_date, emergency_contact_name,
        emergency_contact_phone, emergency_contact_relationship, heard_about_us,
        motivation, teams, medical_certification, training_experience, registered_at, updated_at
      ) VALUES (?, ?, '555', '2000-01-01', 'Contact', '555', 'Friend', 'Friend', 'Help', '[]', 'None', 'None', 0, 0)`,
        )
        .bind(id, id)
        .run();
      await binding
        .prepare(
          "INSERT INTO volunteer_status (user_id, updated_at) VALUES (?, 0)",
        )
        .bind(id)
        .run();
    }

    const database = createDatabase(binding);
    const now = new Date();
    await database.insert(event).values({
      id: "orientation",
      type: "orientation",
      startsAt: new Date(now.getTime() + 86_400_000),
      meetingPoint: "Meeting point",
      spots: 1,
      createdBy: "organizer",
      createdAt: now,
      updatedAt: now,
    });
    const rows = await database.select().from(event);
    assert.equal(rows[0].startsAt instanceof Date, true);
    assert.equal(rows[0].open, true);

    const attempts = await Promise.allSettled(
      ["alice", "bob"].map((id) =>
        binding
          .prepare(
            "INSERT INTO signup (id, event_id, user_id, created_at, updated_at) VALUES (?, 'orientation', ?, 0, 0)",
          )
          .bind(id, id)
          .run(),
      ),
    );
    assert.equal(
      attempts.filter((result) => result.status === "fulfilled").length,
      1,
    );
    const failure = attempts.find((result) => result.status === "rejected");
    assert.ok(failure?.status === "rejected");
    assert.match(String(failure.reason), /event_full/);
    const count = await binding
      .prepare(
        "SELECT count(*) AS count FROM signup WHERE status = 'confirmed'",
      )
      .first<{ count: number }>();
    assert.equal(count?.count, 1);
  } finally {
    await runtime.dispose();
  }
});
