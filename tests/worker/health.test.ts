import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { readD1Migrations } from "@cloudflare/vitest-plugin";
import { afterAll, beforeAll, beforeEach, describe, test } from "vitest";
import { createTestHarness } from "wrangler";
import journal from "../../drizzle/meta/_journal.json";
import { assertDatabaseReady } from "../../src/server/db/readiness";

const migrations = await readD1Migrations(
  fileURLToPath(new URL("../../drizzle", import.meta.url)),
);
const migrationNames = journal.entries.map(({ tag }) => `${tag}.sql`);

describe("database readiness in the built Worker", () => {
  const server = createTestHarness({
    workers: [
      {
        configPath: "dist/server/wrangler.json",
        vars: { APP_ENV: "production", AUTH_BASE_URL: "" },
        secrets: {
          BETTER_AUTH_SECRET: "health-test-secret-12345678901234567890",
          RESEND_API_KEY: "",
        },
      },
    ],
  });
  let worker: ReturnType<typeof server.getWorker<Env>>;
  let DB: Env["DB"];
  beforeAll(async () => {
    await server.listen();
  });
  beforeEach(async () => {
    // Each case gets disposable local storage, never a remote binding.
    await server.reset();
    worker = server.getWorker<Env>();
    DB = (await worker.getEnv()).DB;
  });
  afterAll(async () => {
    await server.close();
  });

  async function health(status: 200 | 503) {
    const response = await worker.fetch(
      "https://afterhoursoutreach.ca/api/v1/health",
    );
    assert.equal(response.status, status);
    assert.equal(response.headers.get("cache-control"), "no-store");
    // Exact bodies also ensure failures never disclose errors or schema details.
    assert.deepEqual(await response.json(), {
      status: status === 200 ? "ok" : "unavailable",
    });
  }

  // Apply selected real SQL files, with the same transaction/ledger shape as
  // Wrangler. This allows genuinely partial histories, not only deleted markers.
  async function applySelected(selected: typeof migrations) {
    await DB.prepare(
      `CREATE TABLE d1_migrations (
         id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE,
         applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
       )`,
    ).run();
    for (const migration of selected) {
      await DB.batch([
        ...migration.queries.map((query) => DB.prepare(query)),
        DB.prepare("INSERT INTO d1_migrations (name) VALUES (?)").bind(
          migration.name,
        ),
      ]);
    }
  }

  test("a pristine but reachable database is unavailable", async () => {
    assert.deepEqual(await DB.prepare("SELECT 1 AS reachable").first(), {
      reachable: 1,
    });
    await health(503);
    assert.equal(
      await DB.prepare(
        "SELECT name FROM sqlite_master WHERE name='d1_migrations'",
      ).first(),
      null,
      "readiness must not initialize or migrate the database",
    );
  });

  test("a partially migrated database is unavailable, then recovers after migration", async () => {
    await applySelected(migrations.slice(0, 1));
    await health(503);
    await worker.applyD1Migrations("DB");
    await health(200);
  });

  test("a fully migrated database is healthy without application data", async () => {
    await worker.applyD1Migrations("DB");
    const { results } = await DB.prepare(
      "SELECT name FROM d1_migrations ORDER BY id",
    ).all<{ name: string }>();
    assert.deepEqual(
      results.map(({ name }) => name),
      migrationNames,
    );
    assert.deepEqual(
      migrations.map(({ name }) => name),
      migrationNames,
    );
    await health(200);
  });

  test("readiness reads no application rows and writes nothing on a populated database", async () => {
    await worker.applyD1Migrations("DB");
    await DB.prepare(
      `INSERT INTO user (id, name, email, created_at, updated_at)
       VALUES ('private-health-fixture', 'PRIVATE NAME', 'private@example.org', 0, 0)`,
    ).run();
    // Observe real D1 metrics, without mocking queries or changing their results.
    let batches = 0;
    await assertDatabaseReady(
      new Proxy(DB, {
        get(target, key) {
          if (key === "prepare") return target.prepare.bind(target);
          if (key === "batch")
            return async <T>(statements: D1PreparedStatement[]) => {
              batches++;
              const results = await target.batch<T>(statements);
              for (const result of results)
                assert.equal(result.meta.rows_written, 0);
              for (const result of results.slice(1)) {
                assert.equal(result.meta.rows_read, 0);
                assert.deepEqual(result.results, []);
              }
              return results;
            };
          return Reflect.get(target, key, target);
        },
      }),
    );
    assert.equal(batches, 1);
    await health(200);
  });

  test("an absent migration ledger is unavailable even with all application tables", async () => {
    await worker.applyD1Migrations("DB");
    await DB.prepare("DROP TABLE d1_migrations").run();
    await health(503);
  });

  test.each([0, migrationNames.length - 1])(
    "missing migration %i is unavailable despite later or unrelated records",
    async (index) => {
      await worker.applyD1Migrations("DB");
      await DB.prepare("DELETE FROM d1_migrations WHERE name=?")
        .bind(migrationNames[index])
        .run();
      await DB.prepare("INSERT INTO d1_migrations (name) VALUES (?)")
        .bind("9999_unrelated.sql")
        .run();
      await health(503);
    },
  );

  test("journal tags without Wrangler's filename suffix do not prove migration completion", async () => {
    await worker.applyD1Migrations("DB");
    await DB.prepare(
      "UPDATE d1_migrations SET name=substr(name, 1, length(name)-4)",
    ).run();
    await health(503);
  });

  test("an unapplied trigger-only migration is unavailable with the current table/column schema", async () => {
    const triggerOnly = migrations.find((migration) =>
      migration.queries.every((query) =>
        /^(?:CREATE|DROP) TRIGGER\b/.test(
          query.replace(/^(?:\s|--[^\n]*(?:\n|$))*/, ""),
        ),
      ),
    );
    assert.ok(
      triggerOnly,
      "the history must exercise a trigger-only migration",
    );
    await applySelected(migrations.filter((entry) => entry !== triggerOnly));
    await health(503);
    await worker.applyD1Migrations("DB");
    await health(200);
  });

  test.each([
    "profile",
    "session",
    "application_draft",
    "application_draft_generation",
  ])(
    "a missing %s table is unavailable despite a complete ledger",
    async (table) => {
      await worker.applyD1Migrations("DB");
      await health(200);
      await DB.prepare(`DROP TABLE "${table}"`).run();
      await health(503);
    },
  );

  test.each([
    ["user", "image"],
    ["profile", "heard_about_us_sources"],
    ["application_draft_generation", "generation"],
    ["event_notification", "delivery_origin"],
  ])(
    "a missing %s.%s column is unavailable even on empty tables",
    async (table, column) => {
      await worker.applyD1Migrations("DB");
      await DB.prepare(
        `ALTER TABLE "${table}" RENAME COLUMN "${column}" TO "missing_column"`,
      ).run();
      await health(503);
    },
  );
});
