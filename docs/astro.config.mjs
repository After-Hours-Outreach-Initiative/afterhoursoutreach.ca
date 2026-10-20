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
    }),
  ],
});
