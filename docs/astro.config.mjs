// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

// This is a standalone local reader, not part of the application's build.
export default defineConfig({
  server: {
    host: "127.0.0.1",
    port: 4322,
  },
  vite: {
    server: { strictPort: true },
  },
  integrations: [
    starlight({
      title: "After Hours Outreach docs",
      // Pagefind needs a build; this reader only uses the development server.
      pagefind: false,
      sidebar: [
        { label: "Overview", slug: "" },
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
            { label: "Backend", slug: "backend" },
            { label: "Deployment", slug: "deployment" },
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
