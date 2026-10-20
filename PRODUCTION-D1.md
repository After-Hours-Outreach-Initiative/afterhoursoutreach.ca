# Production D1 preparation and human cutover

Prepared 2026-10-20. **No production Worker connection/deployment is authorized
by this preparation.** The detailed checklist is also at the top of locally
Git-excluded `TODO.md`; this tracked handoff preserves the operational instructions.

## Prepared target

| Resource                        | Value                                                                 |
| ------------------------------- | --------------------------------------------------------------------- |
| Cloudflare account              | `76222ab803494dc84947546283e1a63a`                                    |
| Intended Worker                 | `afterhoursoutreach-ca`                                               |
| Dedicated D1                    | `afterhoursoutreach-production`                                       |
| Dedicated D1 ID                 | `ca19de7e-de80-41a5-827a-7130c34ea3da`                                |
| Migration-only config / binding | `wrangler.production-migrations.jsonc` / `PRODUCTION_DB`              |
| Unchanged Preview D1            | `afterhoursoutreach-staging` / `4412ad44-0ca9-4ebd-8f08-78bb1092bc0d` |

All 15 historical/generated migrations through
`0014_patrol_submission_integration.sql` are applied. Remote ledger matches
the journal; no pending migrations, foreign keys enabled, no violations,
`quick_check=ok`. All 23 application tables are empty; their schema, 28 named
indexes and 24 triggers match a full local migration replay. No data seeded.
The production binding in `wrangler.jsonc` is **still its placeholder**.

The migration-only config has no entrypoint/assets and refuses deployment.
`pnpm db:migrate:production` validates history and the pinned account/database,
rejects argument/environment target overrides, then invokes only D1 migrations.
Never use this config to deploy a Worker or repoint Preview scripts to production.

## Open launch gates

- [ ] Explicit human privacy and cutover approval. Complete the human blockers
      in `LAUNCH-READINESS.md`: notices before autosave, sensitive/emergency-contact/
      birth-date collection, policy effective date and responsible role, retention,
      access/correction/deletion/complaint processes, monitored contacts, provider
      locations/agreements, logs/traces/backups and inbox handling. A draft policy
      or passing Preview tests do not approve collection.
- [ ] Production secrets: read-only secret list and settings bindings were both
      empty. Neither `BETTER_AUTH_SECRET` nor `RESEND_API_KEY`, canonical
      `AUTH_BASE_URL` nor production `APP_ENV` was present live. Source declarations
      and local `.dev.vars` do not establish deployed configuration.
- [ ] Resend operator verifies `afterhoursoutreach.ca`, SPF/DKIM, enabled sending,
      and approved key/domain restrictions for **both**
      `accounts@afterhoursoutreach.ca` and `noreply@afterhoursoutreach.ca`.
      Read-only `GET /domains` using the available local send-only key was denied
      (401 `restricted_api_key`); it is not proof of a production key or sender.
      Use authorized read access/dashboard; do not broaden the send key or send
      test mail before approval.
- [ ] Confirm the actual fixed recipients and monitored delivery follow-up:
      `ivan.zheng@afterhoursoutreach.ca`, `info@afterhoursoutreach.ca`, and
      `molina.dewilde@afterhoursoutreach.ca`. These supersede older Tudor/`molina.@`
      backlog entries. Provider acceptance is not inbox-delivery proof.
- [ ] Reconcile live scheduling: production schedules were empty. Desired source
      crons are `0 16 * * *` (16:00 UTC daily, 08:00 PST / 09:00 PDT) and
      `30 * * * *` (hourly delivery/retries). A production deploy can enable
      delivery as well as collection; no cron was installed during preparation.
- [ ] Name database/recovery owner and backup approver; approve access, recovery
      objectives, export storage/retention if required, deletion implications and
      incident procedure. Read-only Time Travel bookmark retrieval works on the
      production backend; no restore/drill was performed. Actual plan/history
      entitlement remains unverified: 7 days on Free / 30 on Paid per docs.
      Restore overwrites D1 and cancels queries; Worker rollback does not undo
      data changes. A recovery drill requires separate approval.
- [ ] Confirm residency expectations before real collection: primary WNAM,
      jurisdiction restriction `null`, replication disabled. WNAM is not a
      Canada-only storage/processing guarantee.

## Future human connection commands (not executed by task8)

1. After approval, use pinned project Wrangler 4.135.0 and verify identity/account.
   D1 creation needs product Admin (or accepted legacy D1 Write); migration needs
   D1 Editor/write access on this database. Worker deployment needs Workers Editor
   on this Worker, plus affected-zone route permission if changing routes. Prefer
   narrowly scoped account-owned tokens for automation; never disclose token values.

   ```sh
   pnpm exec wrangler whoami --account 76222ab803494dc84947546283e1a63a
   pnpm exec wrangler d1 info PRODUCTION_DB --config wrangler.production-migrations.jsonc --json
   pnpm exec wrangler secret list --config wrangler.jsonc --name afterhoursoutreach-ca
   pnpm db:migrate:production
   pnpm exec wrangler d1 migrations list PRODUCTION_DB --config wrangler.production-migrations.jsonc --remote
   pnpm exec wrangler d1 execute PRODUCTION_DB --config wrangler.production-migrations.jsonc --remote --command 'SELECT name FROM d1_migrations ORDER BY id; PRAGMA foreign_keys; PRAGMA foreign_key_check; PRAGMA quick_check;'
   pnpm exec wrangler d1 time-travel info PRODUCTION_DB --config wrangler.production-migrations.jsonc --json
   ```

   Stop on mismatched identity/resource/ledger. Save a fresh bookmark securely;
   bookmarks expire. No restore is authorized here. Future schema changes use
   `pnpm db:generate` / `pnpm db:check`; never edit historical SQL or import Preview data.

2. **Human edit:** replace only the top-level production D1 entry in
   `wrangler.jsonc` with the following and remove its obsolete placeholder comment.
   Preserve all Preview settings. `remote: false` protects local development;
   it does not disable the binding when deployed.

   ```json
   {
     "binding": "DB",
     "database_name": "afterhoursoutreach-production",
     "database_id": "ca19de7e-de80-41a5-827a-7130c34ea3da",
     "migrations_dir": "drizzle",
     "remote": false
   }
   ```

3. Approved operator prepares a mode-0600 secrets JSON file **outside the repo**,
   containing production `BETTER_AUTH_SECRET` (independent, high-entropy, at least
   32 characters) and approved domain-scoped `RESEND_API_KEY`. Do not implicitly
   copy local/Preview credentials. Replace the example path below. `secret put`
   and `secret bulk` deploy immediately; do not use them as preparation.

   ```sh
   pnpm db:check
   pnpm check
   pnpm build
   pnpm exec wrangler deploy --config dist/server/wrangler.json --secrets-file /secure/path/aho-production.json --dry-run
   ```

   Review generated `dist/server/wrangler.json`, not just source: correct account,
   Worker and dedicated DB ID; `APP_ENV=production`,
   `AUTH_BASE_URL=https://afterhoursoutreach.ca`, both crons, logs/traces and
   query-string redaction. Reconcile dashboard routes/settings; preserve Preview
   isolation. Dry run checks packaging, not live secrets, inboxes or privacy.

4. **Only after explicit human authorization of actual production cutover:**

   ```sh
   pnpm exec wrangler deploy --config dist/server/wrangler.json --secrets-file /secure/path/aho-production.json
   pnpm exec wrangler secret list --config wrangler.jsonc --name afterhoursoutreach-ca
   ```

   Verify live settings/schedules in dashboard/API: both secret names, canonical
   URL, environment, dedicated binding, both crons and deployment ID. Never use
   a migration config, Preview build or stale `dist`. Protect/remove the secrets
   file under the approved credential procedure; record cutover/recovery owner.

5. After separate approval for controlled real-account/real-inbox checks, verify
   mobile/desktop sign-in mail from `accounts@`, code/link expiry and reuse rejection,
   denied organizer access, draft resume/cross-device conflicts, submit/retry without
   duplicate mail, delivery from `noreply@` to all three fixed inboxes, organizer
   approval, orientation booking/cancellation and recurring patrol/signup-window
   behavior. Observe hourly retries/medic delivery safely without forced duplicate
   sends. Monitor quota/backlog/expired unresolved intents and actual inboxes; do
   not log codes, tokens or application bodies. Arrange separately approved,
   audited first-production-organizer provisioning: the bootstrap helper supports
   only local/Preview and must not be repointed. Handle test data under the approved
   retention policy; keep general collection closed until acceptance is signed off.

References: [D1 commands](https://developers.cloudflare.com/d1/wrangler-commands/),
[Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/),
[limits](https://developers.cloudflare.com/d1/platform/limits/),
[roles](https://developers.cloudflare.com/workers/authorization/),
[secrets](https://developers.cloudflare.com/workers/configuration/secrets/).
