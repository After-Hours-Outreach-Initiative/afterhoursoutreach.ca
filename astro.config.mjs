// @ts-check
import { defineConfig, fontProviders } from "astro/config";
import cloudflare from "@astrojs/cloudflare";
import { chmod } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";

// https://astro.build/config
export default defineConfig({
  adapter: cloudflare({ imageService: "compile", remoteBindings: false }),
  fonts: [
    {
      provider: fontProviders.google(),
      name: "Public Sans",
      cssVariable: "--font-public-sans",
      weights: [400, 500, 600, 700],
      styles: ["normal"],
      subsets: ["latin"],
    },
  ],
  // Better Auth will own database-backed sessions, not Astro's KV sessions.
  session: false,
  integrations: [
    {
      name: "local-ui-playground",
      hooks: {
        "astro:config:setup": ({ command, injectRoute }) => {
          // Register no routes or playground imports in either hosted build.
          if (command !== "dev") return;
          injectRoute({
            pattern: "/dev/ui",
            entrypoint: new URL(
              "./src/dev/ui/Playground.astro",
              import.meta.url,
            ),
            prerender: false,
          });
          injectRoute({
            pattern: "/dev/ui/discord",
            entrypoint: new URL(
              "./src/dev/ui/DiscordPreview.astro",
              import.meta.url,
            ),
            prerender: false,
          });
          injectRoute({
            pattern: "/dev/ui/organizer-profile",
            entrypoint: new URL(
              "./src/dev/ui/OrganizerProfilePlayground.astro",
              import.meta.url,
            ),
            prerender: false,
          });
          injectRoute({
            pattern: "/dev/ui/organizer-profile/preview",
            entrypoint: new URL(
              "./src/dev/ui/OrganizerProfilePreview.astro",
              import.meta.url,
            ),
            prerender: false,
          });
        },
      },
    },
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
    // Check/sync/build must not replace dependencies used by the running dev Worker.
    cacheDir: fileURLToPath(
      new URL(
        `./node_modules/.vite/${process.env.NODE_ENV === "production" ? "production" : "development"}/`,
        import.meta.url,
      ),
    ),
    plugins: [tailwindcss()],
    // Discover account dependencies before a cold-start reload can reset a form.
    optimizeDeps: {
      include: [
        "better-auth/client",
        "better-auth/client/plugins",
        "qrcode",
        "zod",
      ],
    },
    // Avoid restarting the dev Worker when Astro's server imports are discovered.
    environments: {
      ssr: {
        optimizeDeps: {
          include: ["astro/app/manifest", "astro/logger/json"],
        },
      },
    },
    // Account pages disallow inline scripts; keep Astro's scripts external.
    build: {
      assetsInlineLimit: (path) => (path.endsWith(".js") ? false : undefined),
    },
  },
});
