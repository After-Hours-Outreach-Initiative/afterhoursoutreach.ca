---
title: Discord
description: Dedicated bot setup, consented account linking, authoritative role synchronization, and recovery.
---

## Application and account workflow

New applications proceed through form submission, Naloxone 101, **Connect Discord**,
then organizer review. Applicants consent on the website and on Discord to identity
access and joining the After Hours Outreach server (`identify guilds.join`). A
successful OAuth callback links the identity but does **not** complete the step:
the bot must GET that specific server member and verify full membership. If
Membership Screening is enabled, the applicant must accept the rules in Discord;
the bot does not bypass screening by assigning a role.

Migration `0020_discord_connect.sql` adds requirements only on future profile
inserts. Existing submitted profiles are not backfilled, including currently
unapproved volunteers, and keep website access without linking. Unsubmitted
accounts/drafts become new applicants when they submit. Existing volunteers may
connect from **Account settings → Discord**, without backfilling old course dates. Linking does not
change email sign-in, enable Discord login, merge accounts by email, or grant
website privileges from Discord roles.

The application tracker, account settings, and organizer's authorized profile
review display connection/sync status. Account status polls for two minutes and
has a manual refresh button. A separate application-page refresh reveals newly
completed milestones. Do not treat “linked” as “verified member” or “roles synced”.

## Authoritative role rules

All three roles require a submitted profile, an **active, application-approved**
website account, a link, and verified full Discord membership.

| Role      | Additional requirement                                                                 |
| --------- | -------------------------------------------------------------------------------------- |
| Volunteer | None                                                                                   |
| Organizer | Website organizer status                                                               |
| Medic     | Medic team selected, patrol approved, and at least one recorded orientation completion |

There is **no Outreach or separate patrol-approved role**. Organizer status never
bypasses active/application approval for Discord. Certification expiry is not an
additional Discord eligibility condition. Deactivation or revoked application
approval removes all managed roles. Reactivation or restored approval adds the
currently eligible roles. Team edits, role changes, status changes and orientation
insert/update/delete enqueue reconciliation atomically via SQLite triggers.

Only individual add/remove-role REST endpoints are used. Unrelated roles,
nicknames, channels, messages, and server membership are never replaced or removed.
The bot never kicks or bans. Role changes made manually in Discord do not alter
website eligibility and are corrected by periodic reconciliation.

## Dedicated bot and server setup

1. Create a **new dedicated application and bot** in the Discord Developer Portal;
   do not reuse another bot or a personal user token. Keep it private. Its bot token
   and OAuth client credentials must belong to the same application.
2. Install it into the intended server with **Manage Roles** and **Create Instant
   Invite** (required for Add Guild Member). Do not grant Administrator, Kick
   Members, Ban Members, or message-reading permissions. This integration uses
   REST for individual members, not Gateway events or the privileged member-list
   intent. Ensure server-level 2FA requirements are satisfied by the bot owner.
3. Identify the Volunteer, Organizer, and Medic roles. Place the bot's highest
   role above all three. They must be distinct, ordinary editable roles, not
   `@everyone` or integration-managed roles. Review their channel permissions and
   ensure other auto-role integrations do not assign these three roles.
4. Enable Developer Mode in Discord to copy IDs. Configure these **non-secret**
   variables in source `wrangler.jsonc`, preserving string values (snowflakes are
   not safe JavaScript numbers):

   | Variable                    | Value                    |
   | --------------------------- | ------------------------ |
   | `DISCORD_CLIENT_ID`         | Dedicated application ID |
   | `DISCORD_GUILD_ID`          | Server ID                |
   | `DISCORD_VOLUNTEER_ROLE_ID` | Volunteer role ID        |
   | `DISCORD_ORGANIZER_ROLE_ID` | Organizer role ID        |
   | `DISCORD_MEDIC_ROLE_ID`     | Medic role ID            |

5. Register the exact production OAuth redirect URI:
   `https://afterhoursoutreach.ca/api/v1/account/discord/callback`.
   Production uses the configured `AUTH_BASE_URL`; forwarded hosts cannot choose
   the callback. A separately configured local sandbox bot needs its exact local
   callback URI registered as well.

### Private secret configuration

Configure runtime secrets separately; **never** put values in `wrangler.jsonc`,
public Astro variables, documentation, commits, command arguments, logs, or chat:

| Secret                         | Purpose                                   |
| ------------------------------ | ----------------------------------------- |
| `DISCORD_CLIENT_SECRET`        | OAuth authorization-code exchange         |
| `DISCORD_BOT_TOKEN`            | Dedicated bot REST authentication         |
| `DISCORD_TOKEN_ENCRYPTION_KEY` | Base64-encoded random 32-byte AES-GCM key |

Generate the encryption key privately with a secure random generator (for example,
`openssl rand -base64 32`) and store it in the organization's secret manager.
Use interactive input or a protected file/stdin mechanism to configure secrets.
For local sandbox work use ignored `.dev.vars`, owner-only permissions, and no
production credentials. The encryption key must be consistent across retry
invocations; do not rotate it while encrypted join tokens are pending without
arranging reauthorization. Refresh tokens are not stored. The short-lived access
token is encrypted with account/Discord/server identity as authenticated data,
then erased after successful joining or membership verification, or at expiry.

Use `cf` OAuth for Cloudflare resource/secret configuration. Discover the installed
command with `cf cli search "worker secrets"`, inspect its `--help`, explicitly set
`CLOUDFLARE_ACCOUNT_ID=76222ab803494dc84947546283e1a63a`, and verify Worker
`afterhoursoutreach-ca` before making changes. Do not infer `cf` access from Wrangler
credentials. Keep the existing `pnpm build` / `pnpm deploy` migration and
framework-generated Wrangler pipeline; no tooling migration is needed.

The optional Discord configuration fails closed when IDs/secrets are missing or
invalid; email sign-in remains available. **Do not launch new applications until
the bot, IDs, secrets, and privacy-policy notice are ready.** Secret names are not
added to the global required-secret list so unrelated account deployments and
previews can still run without a live bot.

### Preview and local isolation

`APP_ENV=preview` disables OAuth and sync regardless of IDs or secrets. Never set
production Discord secrets in Previews Base or branch previews; their D1 is shared.
Existing sample personas model grandfathered volunteers, not invented Discord
consent. The development-only **Simulate Discord connection** shortcut stores a
fictional `local-only` server/identity with no tokens and makes no provider calls.
It is excluded from hosted builds. Only use sample data in local/preview testing.

## Durable retries and monitoring

`discord_link` is a coalescing, versioned D1 outbox. Eligibility changes increment
its version and make it due immediately, in the same database transaction. A
one-minute Cron Trigger drains bounded work; successful links are also checked
hourly to repair role drift or detect departures. The callback may start an early
drain tied to Worker lifetime; durability never depends on that early attempt.

One token-owned database lease serializes the dedicated bot across invocations.
Each call renews the lease and uses a shorter HTTP timeout. Before a role write,
the persisted membership cache is invalidated so a crash or lost response forces
a fresh membership GET. The job recomputes live eligibility before every role
operation; conditional version checkpoints cannot mark newer changes as synced.
Idempotent role operations make replay safe. Unrelated roles are never sent as a
replacement list. There is no time-based expiry of required role-removal jobs.

The worker honors `Retry-After`, JSON `retry_after`, and exhausted-bucket
`X-RateLimit-Reset-After` responses. It conservatively pauses the whole dedicated
bot, persisting the cooldown across routes and isolates, rather than sleeping in
an invocation. A separate conservative burst ceiling bounds unexpected bursts;
it is not a replacement for Discord's response limits. Network/provider failures
retry with bounded backoff; bot authentication/permission failures pause for an
hour to avoid invalid-request storms. No raw provider error, token, or profile
answer is logged. Cron logs contain aggregate `discord_sync` results or a
sanitized `discord_sync_failed` event.

Inspect only user IDs, versions, attempts, error codes, next-attempt times, and
last-synced times during troubleshooting, not token ciphertext or OAuth verifiers.
Pending/failed work remains visible on account/review pages. Investigate persistent
backlog or `bot_permissions`; check the exact server, installed application,
credentials, role hierarchy, and permissions before clearing a cooldown. Do not
reset work by deleting links. A role/server ID change needs an explicit migration
plan to remove old managed roles first; links pin the server and cannot silently
move identities to another server.

Joining is never an ongoing background consent: the stored join token is used only
for that authorization attempt. Once it is erased, leaving the server produces a
missing-membership status and no automatic rejoin. Fresh **Reconnect the same
Discord account** consent can join again. OAuth exchange/identity errors require
the person to start authorization again; an authorization code is not persisted
as an indefinitely retryable credential.

## Security and account recovery

OAuth uses S256 PKCE and random state. The expiring, single-use D1 record is bound
to the initiating website account, exact session, origin and separate HttpOnly,
SameSite=Lax browser cookie. Starting again invalidates the older flow. The
callback validates Discord's issuer and rechecks live verified-email/second-factor
session authorization before storing a link. Signing out, revoking the session,
switching accounts or replaying the callback cannot attach another identity.
Uniqueness constraints resolve concurrent duplicate links; an immutable-identity
trigger rejects swaps. Neither Discord's email nor a client-provided Discord ID
selects the linked account.

For a correction or consent-withdrawal request, verify the requester using an
established website/contact channel. There is no self-service identity swap:

1. Deactivate the website account (or revoke application approval) and wait until
   all three managed roles have been confirmed removed. If Discord is unavailable,
   keep the link and removal work pending; do not delete the retry record.
2. An authorized operator must verify the member's actual roles in Discord before
   removing the link record and any pending OAuth record. Record the request and
   action privately under the privacy retention rules. Do not kick the member or
   remove unrelated roles. Account deletion is deliberately blocked while a link
   exists, so role-removal obligations cannot disappear through a cascade.
3. For a correction, let the volunteer authorize the intended identity afresh;
   never edit `discord_id` in place or attach a Discord ID based on an email match.
   Restore website activity/approval only when appropriate. Existing volunteers
   stay exempt; new applicants still need the required step. For consent withdrawal,
   explain any effect on participation and retained decision records.

Reference APIs: [Discord OAuth2](https://docs.discord.com/developers/topics/oauth2),
[guild members and roles](https://docs.discord.com/developers/resources/guild),
[Discord rate limits](https://docs.discord.com/developers/topics/rate-limits), and
[Workers Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/).
