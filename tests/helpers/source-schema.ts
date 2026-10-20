import { readFileSync } from "node:fs";
import { getTableName, is, SQL } from "drizzle-orm";
import {
  getTableConfig,
  SQLiteSyncDialect,
  SQLiteTable,
} from "drizzle-orm/sqlite-core";
import * as schema from "../../src/server/db/schema";

/**
 * Build a fresh, disposable test database from the SOURCE schema, without
 * generating migrations, snapshots, journals, or any database artifacts.
 * Migration replay/preservation checks remain the integration owner's job.
 */
export function sourceSchemaStatements() {
  const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
  const dialect = new SQLiteSyncDialect();
  const expression = (value: SQL) =>
    dialect.sqlToQuery(value).sql.replace(/"[^"]+"\."/g, '"');
  const literal = (value: unknown): string => {
    if (is(value, SQL)) return expression(value);
    if (typeof value === "string") return `'${value.replaceAll("'", "''")}'`;
    if (typeof value === "boolean") return value ? "1" : "0";
    if (value === null) return "NULL";
    return String(value);
  };
  const tables: string[] = [];
  const indexes: string[] = [];
  for (const table of Object.values(schema)) {
    if (!is(table, SQLiteTable)) continue;
    const config = getTableConfig(table);
    const definitions = config.columns.map((column) =>
      [
        quote(column.name),
        column.getSQLType(),
        column.primary ? "PRIMARY KEY" : "",
        column.notNull ? "NOT NULL" : "",
        column.isUnique ? "UNIQUE" : "",
        column.default !== undefined
          ? `DEFAULT ${literal(column.default)}`
          : "",
      ]
        .filter(Boolean)
        .join(" "),
    );
    for (const key of config.foreignKeys) {
      const reference = key.reference();
      definitions.push(`FOREIGN KEY (${reference.columns.map((column) => quote(column.name))})
        REFERENCES ${quote(getTableName(reference.foreignTable))} (${reference.foreignColumns.map((column) => quote(column.name))})
        ON DELETE ${key.onDelete ?? "no action"}`);
    }
    for (const check of config.checks)
      definitions.push(
        `CONSTRAINT ${quote(check.name)} CHECK (${expression(check.value)})`,
      );
    for (const constraint of config.uniqueConstraints)
      definitions.push(
        `UNIQUE (${constraint.columns.map((column) => quote(column.name))})`,
      );
    tables.push(
      `CREATE TABLE ${quote(config.name)} (${definitions.join(", ")})`,
    );
    for (const { config: index } of config.indexes) {
      const columns = index.columns.map((column) =>
        is(column, SQL) ? expression(column) : quote(column.name),
      );
      indexes.push(
        `CREATE ${index.unique ? "UNIQUE " : ""}INDEX ${quote(index.name)} ON ${quote(config.name)} (${columns})${index.where ? ` WHERE ${expression(index.where)}` : ""}`,
      );
    }
  }
  return [
    ...tables,
    ...indexes,
    ...readFileSync(
      new URL("../../src/server/db/triggers.sql", import.meta.url),
      "utf8",
    )
      .split("--> statement-breakpoint")
      .map((statement) => statement.trim())
      .filter(Boolean),
  ];
}
