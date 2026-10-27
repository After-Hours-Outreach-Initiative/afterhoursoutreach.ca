## Development

When starting the dev server, use background mode:

```
astro dev --background
```

Manage the background server with `astro dev stop`, `astro dev status`, and `astro dev logs`.

Do not write or run tests for the documentation site (`docs/`), including
browser/Playwright tests for its diagrams or editing controls.

## Cloudflare tooling

Use `cf` for Cloudflare account and resource configuration management, including
Workers Builds production and preview build/deploy settings. Keep the existing
Astro and Wrangler pipeline, invoked through the project's `pnpm` scripts, for
building and deploying the application.

- Keep `wrangler.jsonc` as the project's source configuration and deploy the
  framework-generated Wrangler configuration through the existing scripts.
- Do not run `cf migrate`, `cf dev`, `cf build`, or `cf deploy`, or introduce
  `cloudflare.config.ts`, unless a tooling migration is explicitly requested.
  Resource/configuration commands work alongside Wrangler without migration.
- Use OAuth for interactive access. `cf` and Wrangler keep separate credentials;
  a Wrangler OAuth permission error does not mean `cf` lacks access. In
  particular, use `cf`'s OAuth grant for Workers Builds configuration.
- `cf` resource commands do not read `account_id` from `wrangler.jsonc`. Explicitly
  set `CLOUDFLARE_ACCOUNT_ID` to the account configured there and verify the target
  Worker/resource before making changes.
- Discover commands with `cf cli search` using generic task descriptions without
  account/resource identifiers, then inspect the selected command's `--help`.

## Design

Do not use UI eyebrows: the small, uppercase, letter-spaced label sitting above
a heading or field value. Let the heading or the value carry the section on its
own, and where a label is genuinely needed, write it in sentence case at normal
weight.

Use icon components for arrows in UI, never Unicode or text arrow glyphs.

## Documentation

Full documentation: https://docs.astro.build

Consult these guides before working on related tasks:

- [Adding pages, dynamic routes, or middleware](https://docs.astro.build/en/guides/routing/)
- [Working with Astro components](https://docs.astro.build/en/basics/astro-components/)
- [Using React, Vue, Svelte, or other framework components](https://docs.astro.build/en/guides/framework-components/)
- [Adding or managing content](https://docs.astro.build/en/guides/content-collections/)
- [Adding styles or using Tailwind](https://docs.astro.build/en/guides/styling/)
- [Supporting multiple languages](https://docs.astro.build/en/guides/internationalization/)
