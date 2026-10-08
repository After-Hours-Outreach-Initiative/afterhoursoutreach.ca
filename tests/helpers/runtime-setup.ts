import { env } from "cloudflare:workers";
import { applyD1Migrations, reset } from "cloudflare:test";
import { beforeEach, inject, vi } from "vitest";

// Set these before application imports: Vitest otherwise defaults to DEV=true.
vi.stubEnv("DEV", false);
vi.stubEnv("PROD", true);

// The plugin isolates storage per file, so reset explicitly between cases too.
beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, inject("migrations"));
});
