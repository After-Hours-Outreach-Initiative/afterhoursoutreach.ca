// @ts-check
import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";
import { chmod } from "node:fs/promises";

import tailwindcss from "@tailwindcss/vite";

// https://astro.build/config
export default defineConfig({
  adapter: cloudflare({ imageService: "compile", remoteBindings: false }),
  // Better Auth will own database-backed sessions, not Astro's KV sessions.
  session: false,
  integrations: [
    {
      name: "private-build-secrets",
      hooks: {
        "astro:build:done": async ({ dir }) => {
          // The Cloudflare plugin copies local secrets next to the server bundle.
          // Keep that ignored copy owner-only, just like the original .dev.vars.
          try {
            await chmod(new URL("../server/.dev.vars", dir), 0o600);
          } catch (error) {
            if (!(
              error instanceof Error &&
              "code" in error &&
              error.code === "ENOENT"
            ))
              throw error;
          }
        },
      },
    },
  ],
  vite: {
    plugins: [tailwindcss()],
  },
});
