// @ts-check
import { defineConfig } from "astro/config";
import { fileURLToPath } from "node:url";
import starlight from "@astrojs/starlight";
import react from "@astrojs/react";
import diagramFiles from "./src/integrations/diagram-files.ts";
import localDashboard from "./src/integrations/local-dashboard.ts";

// This is a standalone local reader, not part of the application's build.
export default defineConfig({
  // Keep bookmarked guide URLs working after the documentation reorganization.
  redirects: {
    "/accounts": "/specification/accounts/",
    "/events": "/specification/events/",
    "/discord": "/specification/discord/",
    "/privacy": "/planning/privacy/",
    "/backend": "/implementation/backend/",
    "/system-architecture": "/implementation/system-architecture/",
    "/deployment": "/implementation/deployment/",
    "/operations-dashboard": "/implementation/operations-dashboard/",
    "/testing": "/implementation/testing/",
    "/docs-site": "/implementation/docs-site/",
    "/emails": "/implementation/emails/",
  },
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
      title: "AHOI Docs",
      components: {
        Header: "./src/components/DocsHeader.astro",
        PageTitle: "./src/components/DocsPageTitle.astro",
      },
      customCss: ["./src/styles/layout.css", "./src/styles/diagrams.css"],
      // Pagefind needs a build; this reader only uses the development server.
      pagefind: false,
      sidebar: [
        { label: "Overview", slug: "" },
        {
          label: "Planning",
          items: [
            { label: "TODO", slug: "planning/todo" },
            { label: "TBD", slug: "planning/tbd" },
          ],
        },
        {
          label: "Specification",
          items: [
            { label: "Overview", slug: "specification" },
            { label: "Site map", slug: "specification/site-map" },
            {
              label: "Accounts",
              items: [
                { label: "Overview", slug: "specification/accounts" },
                {
                  label: "Sign-in and account settings",
                  slug: "specification/accounts/sign-in-and-settings",
                },
                {
                  label: "Applications",
                  slug: "specification/accounts/applications",
                },
                { label: "Profiles", slug: "specification/accounts/profiles" },
                {
                  label: "Roles and access",
                  slug: "specification/accounts/roles-and-access",
                },
              ],
            },
            { label: "Events", slug: "specification/events" },
            { label: "Discord", slug: "specification/discord" },
            { label: "Notifications", slug: "specification/notifications" },
            { label: "Privacy", slug: "specification/privacy" },
          ],
        },
        {
          label: "Implementation",
          items: [
            { label: "Overview", slug: "implementation" },
            {
              label: "System architecture",
              slug: "implementation/system-architecture",
            },
            { label: "Backend and database", slug: "implementation/backend" },
            { label: "Local development", slug: "implementation/development" },
            {
              label: "Accounts and authentication",
              slug: "implementation/accounts",
            },
            {
              label: "Events and registrations",
              slug: "implementation/events",
            },
            { label: "Discord integration", slug: "implementation/discord" },
            {
              label: "Notification delivery",
              slug: "implementation/notifications",
            },
            { label: "Deployment", slug: "implementation/deployment" },
            { label: "Testing", slug: "implementation/testing" },
            {
              label: "Privacy implementation review",
              slug: "implementation/privacy",
            },
            { label: "Email previews", slug: "implementation/emails" },
            { label: "Operations dashboard", link: "/dashboard/" },
            {
              label: "Dashboard administration",
              slug: "implementation/operations-dashboard",
            },
            {
              label: "Maintaining these docs",
              slug: "implementation/docs-site",
            },
          ],
        },
      ],
    }),
  ],
});
