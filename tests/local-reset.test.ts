import assert from "node:assert/strict";
import { test } from "vitest";
import { env } from "cloudflare:workers";
import { localAccountFixtures } from "../scripts/local-account-fixtures";
import { localAccountUserId } from "../src/dev/accounts";
import { clearLocalData } from "../src/dev/server/seed-accounts";
import { ensurePatrolOccurrences } from "../src/server/db/patrol-series";

const count = async (sql: string) =>
  (await env.DB.prepare(sql).first<{ n: number }>())!.n;
const seed = () =>
  env.DB.batch(localAccountFixtures().map((sql) => env.DB.prepare(sql)));

test("resetting local data removes everything, then the samples seed fresh", async () => {
  await seed();
  // Recurring dates, which their triggers never let be deleted normally.
  await ensurePatrolOccurrences(env.DB);
  assert.ok(
    await count("SELECT count(*) n FROM event WHERE series_id IS NOT NULL"),
  );
  const triggers = await count(
    "SELECT count(*) n FROM sqlite_master WHERE type='trigger'",
  );
  const organizer = localAccountUserId("organizer");
  // Things made by hand, one tied to a sample account by a foreign key, and
  // an edited sample event that plain seeding would keep.
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO user (id, name, email, email_verified, role, created_at, updated_at) VALUES ('hand-made', 'Hand Made', 'hand@example.org', 1, 'volunteer', 0, 0)",
    ),
    env.DB.prepare(
      `INSERT INTO event (id, type, includes_orientation, starts_at, meeting_point, spots, open, hidden, created_by, created_at, updated_at)
      VALUES ('hand-made-event', 'patrol', 0, ?, 'Elsewhere', 6, 1, 0, ?, 0, 0)`,
    ).bind(Date.now() + 86_400_000, organizer),
    env.DB.prepare(
      "UPDATE event SET meeting_point='Edited' WHERE id='local-account-v2-event-patrol'",
    ),
  ]);

  await clearLocalData(env.DB);
  assert.equal(await count("SELECT count(*) n FROM user"), 0);
  assert.equal(await count("SELECT count(*) n FROM event"), 0);
  // Migrations and every protective trigger stay in place.
  assert.ok(await count("SELECT count(*) n FROM d1_migrations"));
  assert.equal(
    await count("SELECT count(*) n FROM sqlite_master WHERE type='trigger'"),
    triggers,
  );

  await seed();
  assert.equal(
    await count("SELECT count(*) n FROM user WHERE id='hand-made'"),
    0,
  );
  assert.equal(
    await count(
      "SELECT count(*) n FROM event WHERE id='local-account-v2-event-patrol' AND meeting_point<>'Edited'",
    ),
    1,
  );
  assert.equal(
    await count(
      "SELECT count(*) n FROM patrol_series WHERE id='local-account-v2-series-orientation'",
    ),
    1,
  );
});
