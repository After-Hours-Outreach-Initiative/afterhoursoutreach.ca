import { is } from "drizzle-orm";
import { getTableConfig, SQLiteTable } from "drizzle-orm/sqlite-core";
import journal from "../../../drizzle/meta/_journal.json";
import * as schema from "./schema";

const migrationNames = journal.entries.map(({ tag }) => `${tag}.sql`);
const quoteIdentifier = (name: string) => `"${name.replaceAll('"', '""')}"`;
const schemaProbes = Object.values(schema)
  .filter((value) => is(value, SQLiteTable))
  .map((table) => {
    const { name, columns } = getTableConfig(table);
    // Qualify columns: SQLite can treat an unknown bare "column" as a string.
    // WHERE 0 validates every reference without reading any application rows.
    return `SELECT ${columns.map(({ name }) => `t.${quoteIdentifier(name)}`).join(", ")} FROM ${quoteIdentifier(name)} AS t WHERE 0`;
  });

/** Read-only readiness, bounded by the deployed schema and migration journal. */
export async function assertDatabaseReady(binding: Env["DB"]) {
  if (!migrationNames.length || !schemaProbes.length)
    throw new Error("Database unavailable.");

  const results = await binding.batch<{ applied: number }>([
    // Wrangler (including its Worker harness) records filenames, not journal tags.
    // Require every entry, not just the latest: gaps and trigger-only changes count.
    binding
      .prepare(
        `SELECT count(DISTINCT name) AS applied FROM d1_migrations
         WHERE name IN (SELECT value FROM json_each(?))`,
      )
      .bind(JSON.stringify(migrationNames)),
    ...schemaProbes.map((query) => binding.prepare(query)),
  ]);
  if (
    results.length !== schemaProbes.length + 1 ||
    results.some((result) => !result.success) ||
    results[0].results[0]?.applied !== migrationNames.length
  )
    throw new Error("Database unavailable.");
}
