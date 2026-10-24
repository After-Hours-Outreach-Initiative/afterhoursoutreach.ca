import { defineConfig } from "drizzle-kit";

// Use pnpm db:generate: its wrapper generates schema changes AND triggers.sql.

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/server/db/schema.ts",
  out: "./drizzle",
});
