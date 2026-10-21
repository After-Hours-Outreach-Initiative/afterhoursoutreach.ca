// @ts-check
import { defineConfig } from "astro/config";
import { fileURLToPath } from "node:url";
import starlight from "@astrojs/starlight";
import react from "@astrojs/react";
import diagramFiles from "./src/integrations/diagram-files.ts";
import localDashboard from "./src/integrations/local-dashboard.ts";

// This is a standalone local reader, not part of the application's build.
export default defineConfig({
  server: {
    host: "127.0.0.1",
    port: 4322,
  },
  vite: {
    // Astro check/build use production React. Keep their optimized dependencies
    // separate so they cannot replace the running dev server's JSX runtime.
    cacheDir: fileURLToPath(
      new URL(
        `./node_modules/.vite/${process.env.NODE_ENV === "production" ? "production" : "development"}/`,
        import.meta.url,
      ),
    ),
    server: {
      strictPort: true,
      // Saving must not reload the page and discard edits in other canvases.
      watch: { ignored: ["**/public/diagrams/*.excalidraw*"] },
      // Local admin logs and application secrets must not be served by Vite's
      // workspace filesystem endpoint either.
      fs: {
        deny: [
          ".env",
          ".env.*",
          "*.{crt,pem}",
          "**/.git/**",
          "**/.dev.vars*",
          "**/.wrangler/**",
          "**/.cloudflare/**",
        ],
      },
    },
  },
  integrations: [
    diagramFiles(),
    localDashboard(),
    react(),
    starlight({
      title: "After Hours Outreach docs",
      customCss: ["./src/styles/layout.css", "./src/styles/diagrams.css"],
      // Pagefind needs a build; this reader only uses the development server.
      pagefind: false,
      sidebar: [
        { label: "Overview", slug: "" },
        { label: "Operations dashboard", link: "/dashboard/" },
        {
          label: "Application workflows",
          items: [
            { label: "Accounts", slug: "accounts" },
            { label: "Events", slug: "events" },
          ],
        },
        {
          label: "Architecture and operations",
          items: [
            { label: "System architecture", slug: "system-architecture" },
            { label: "Backend", slug: "backend" },
            { label: "Deployment", slug: "deployment" },
            { label: "Dashboard administration", slug: "operations-dashboard" },
          ],
        },
        { label: "Privacy review", slug: "privacy" },
        {
          label: "Testing",
          items: [
            { label: "Testing guide", slug: "testing" },
            {
              label: "Historical benchmarks",
              collapsed: true,
              items: [
                { label: "Original baseline", slug: "test-benchmarks" },
                {
                  label: "Simplified suite",
                  slug: "test-benchmarks-simplified",
                },
                { label: "Vitest migration", slug: "test-benchmarks-vitest" },
              ],
            },
          ],
        },
        { label: "Docs site", slug: "docs-site" },
      ],
    }),
  ],
});
