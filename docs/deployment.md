# Deployment

- Domain: [afterhoursoutreach.ca](https://afterhoursoutreach.ca)
- DNS registrar: Porkbun
- DNS manager: Cloudflare DNS
- Hosting: Cloudflare Worker named `afterhoursoutreach-ca`
- Codebase:
  https://github.com/After-Hours-Outreach-Initiative/afterhoursoutreach.ca

## Branch previews

- Public Workers Previews under `afterhoursoutreach-ca`, not version URLs.
- Config: `previews` in `wrangler.jsonc`; Wrangler 4.135.0.
- URL: `<branch-slug>-afterhoursoutreach-ca.ivanzheng9905.workers.dev`.
- All previews share D1 `afterhoursoutreach-staging` unless their bindings and
  `wrangler.preview-migrations.jsonc` both specify a separate database.

Run `pnpm deploy:preview` to build, migrate the preview database, and run
`wrangler preview`. The preview name defaults to the Git branch.
`pnpm preview` remains local Astro previewing.

Previews have a banner, indexing protection, and sample-data warnings; UI mockups
are local-only. Sign-in URLs use the exact preview host.
Account secrets: `BETTER_AUTH_SECRET`, `RESEND_API_KEY`.
Use `wrangler preview base-config secret put NAME` for new previews, or
`wrangler preview secret put NAME --name BRANCH` for an existing preview.
Account secrets are configured in Previews Base. Email requests remain rate limited.
`pnpm test:accounts` uses local data only.

Production: `pnpm deploy`, blocked while its D1 ID is a placeholder or shares a
preview database. Preview deployments never deploy production code.
The separate `afterhoursoutreach-ca-staging` Worker and `staging.afterhoursoutreach.ca`
domain were retired after live preview checks; the shared D1 database was retained.
