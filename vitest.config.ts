import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    reporters: ["default"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          environment: "node",
          include: ["tests/*.test.ts"],
          exclude: ["tests/auth.test.ts", "tests/d1.test.ts"],
        },
      },
      {
        extends: true,
        plugins: [
          cloudflareTest({
            remoteBindings: false,
            miniflare: {
              compatibilityDate: "2026-08-16",
              compatibilityFlags: ["nodejs_compat"],
              d1Databases: ["DB"],
              bindings: {
                APP_ENV: "production",
                AUTH_BASE_URL: "https://afterhoursoutreach.ca",
                BETTER_AUTH_SECRET:
                  "vitest-only-auth-secret-12345678901234567890",
                RESEND_API_KEY: "test-only-resend-key",
              },
            },
          }),
        ],
        test: {
          name: "runtime",
          include: ["tests/auth.test.ts", "tests/d1.test.ts"],
          setupFiles: ["tests/helpers/runtime-setup.ts"],
          provide: {
            migrations: await readD1Migrations(
              fileURLToPath(new URL("./drizzle", import.meta.url)),
            ),
          },
        },
      },
      {
        extends: true,
        test: {
          name: "worker",
          environment: "node",
          include: ["tests/worker/*.test.ts"],
          testTimeout: 60_000,
        },
      },
      {
        extends: true,
        test: {
          name: "preview",
          environment: "node",
          include: ["tests/preview/*.test.ts"],
        },
      },
    ],
  },
});
