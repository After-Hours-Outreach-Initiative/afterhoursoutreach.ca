# Task7 integration readiness — 2026-10-20

## Scope and deployment

- Integrated tasks1–6 on `feat/patrol-scheduling-mockup`; production Worker and
  production D1 binding remain untouched (the Worker still has its placeholder ID).
- Public branch Preview, explicitly approved by the user:
  https://feat-patrol-scheduling-mockup-afterhoursoutreach-ca.ivanzheng9905.workers.dev
- Preview deployment `48479c5c-56b2-4b7e-a5bb-3aebde714ef9` targets only the existing
  shared `afterhoursoutreach-staging` D1 in account
  `76222ab803494dc84947546283e1a63a`. Normal sign-in/organizer authorization remains;
  development account-switching endpoints are absent. This is not an Access-protected URL.
- Applied only `0014_patrol_submission_integration.sql` to that non-production
  database. All historical SQL/meta files are preserved; the journal is append-only.

## Integration fixes and verified contracts

- Generated migration through `pnpm db:generate` only. Fixed the installed Drizzle
  generator's rebuild-copy bug: newly added columns must receive their declared
  defaults/NULL, not be selected from the old table. Populated SQLite and D1
  upgrade regressions cover this, including existing referenced event records.
- Recurrence schema includes effective templates, permanent stop boundary,
  immutable nominal occurrence identities, and database-enforced three-occurrence
  signup windows. Actual day/time edits retain IDs, bookings, earlier templates,
  individual exceptions and cancellation history; organizers can manage dates
  beyond the signup window. Series email retries recognize `patrol_series_audit` IDs.
- Kept both task3 conflict/transaction tests and task4 approval-queue tests in
  `tests/d1.test.ts`; all 17 tests pass against the generated migration history.
  Updated the recurring-controls fixture to use the merged submission contract
  and real generated migrations instead of source-schema/ledger stand-ins.
- First submission and fixed-recipient notification intents commit together using
  `saveProfile.firstSubmissionStatements`; duplicate submissions/profile edits do
  not enqueue again. Immediate bounded `waitUntil` delivery and the existing
  hourly production cron remain independent of medic discovery/delivery.
- Submission/event/medic delivery share the same 80-email UTC-day budget, including
  concurrent reservations. Provider retries use frozen requests/keys within the
  23-hour safety window. Unattempted submission mail survives outages; expired
  unresolved submission records remain for human follow-up, not fresh-key resends.
- Preview submission mail has no payload and is permanently suppressed. Local mail
  is simulated without quota. Added the same build-time Preview gate to medic cron
  delivery, so incorrect production runtime variables cannot enable it in a Preview.
- Privacy-page changes are wording only: implemented first-submission behavior,
  actual fixed inboxes, delivery ledger, and local/Preview behavior now match code.
  The policy remains a draft, not approval to collect real applications.

## Validation

All checks below exclude `docs/`; no documentation-site tests were written or run.

| Check                                                   | Result                                                                                                                  |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `pnpm db:generate --name=patrol_submission_integration` | Generated migration 0014; full history validates                                                                        |
| `pnpm db:check`                                         | Pass                                                                                                                    |
| `pnpm check`                                            | 230 files; 0 errors, warnings, hints                                                                                    |
| `pnpm test`                                             | 253/253; 29 files                                                                                                       |
| `pnpm build`                                            | Pass                                                                                                                    |
| `pnpm exec vitest run --project worker`                 | 76/76; 11 files, including production browser recurrence/queue workflows                                                |
| `pnpm build:preview`                                    | Pass                                                                                                                    |
| `pnpm exec vitest run --project preview`                | 2/2, including integrated local built-Preview walkthrough                                                               |
| Focused existing UI regressions, two workers            | 37/37: drafts, cross-device conflicts, approval, scoped email feedback, mobile/header, notification simulation, polling |
| Built Preview `wrangler deploy --dry-run`               | Pass; packaging only, no production deployment                                                                          |
| Remote Preview migration                                | 0014 applied; foreign-key check clean                                                                                   |
| Existing deployed-site read-only browser smoke          | 4/4                                                                                                                     |
| Authenticated remote synthetic walkthrough              | Pass: submission/retry, profile merges/conflicts, approval filter/count, recurrence/window/stop and email suppression   |
| Changed-file formatting and `git diff --check`          | Pass                                                                                                                    |

The first generator attempt exposed the rebuild defect above. The initial new
Preview walkthrough also used the wrong public JSON response shape; corrected
that test assertion to the established `{ events }` contract. Both were fixed and
rerun successfully. The temporary remote runner's module/JSON parsing issues were
also corrected; the completed remote walkthrough passed. No unresolved check failures.

Remote walkthrough details:

- Used one-use hashed challenge fixtures for synthetic `.invalid` addresses, then
  the normal OTP sign-in endpoint and signed sessions. No authentication bypass
  was deployed; actual email transport/inbox delivery was deliberately not tested.
- Submitted an application through the browser, retried its original request,
  checked private-draft exclusion, merged different-field edits, and resolved a
  same-field conflict explicitly in separate browser tabs.
- Reviewed/approved the sample application through the organizer dialog, retaining
  the awaiting filter and correct global count, without sending an email.
- Created a fortnightly series, reserved a spot, rejected a far-future signup,
  opened that date's editor as an organizer, shifted actual day/time without
  changing nominal IDs/bookings, rejected stale versions, and retried a series
  operation ID. A bounded synthetic start-time fixture verified window rollover.
  Stopping cancelled future bookings; extending did not restart the series.
- Six first-submission ledger rows were `preview`/`suppressed`, with NULL payloads
  and zero attempts; later edits/retries added none. No action emails were queued.
  Browser error count: zero.
- Completed fixture label: `task7-2fcffa02`. An earlier runner-only attempt used
  `task7-f8f52533`. Both runs' submitted sample accounts are inactive, synthetic
  organizer roles removed, and sessions revoked; private-draft fixtures removed.
  Stopped recurrence tombstones and suppressed delivery history remain, as designed.
  The orphaned one-use challenge from runner initialization was removed by exact ID.
  Post-cleanup queries confirmed zero own live sessions, active accounts or live
  future occurrences, and no foreign-key violations. The final automated total is
  372 passing tests plus this authenticated remote walkthrough.

## Human launch blockers (not implemented by task7)

- Approve the privacy policy's retention wording/schedule, responsible privacy
  role and public title, effective date, and monitoring of the privacy contact.
- Review collection notices **before autosave starts**, including account/browser
  draft storage, optional sensitive/lived-experience answers, emergency-contact
  information, and whether full birth-date collection is necessary. A policy
  link or Code of Conduct acknowledgement is not a substitute for that review.
- Approve operational access/correction/deletion/complaint handling, identity
  verification, immutable-submission correction handling, and backup/recovery
  responsibilities. No general automated retention or self-service deletion
  exists; do not promise deadlines or universal erasure.
- Confirm Cloudflare/Resend processing locations, agreements, support access,
  provider/log/trace/backup retention and email-inbox handling. Website wording
  does not establish these operational practices.
- Confirm the fixed notification inboxes and monitored delivery follow-up:
  `ivan.zheng@afterhoursoutreach.ca`, `info@afterhoursoutreach.ca`, and
  `molina.dewilde@afterhoursoutreach.ca` (older TODO entries list different addresses).
  Real provider/inbox delivery is not tested by synthetic Preview validation;
  verify production secrets/sender separately before launch. Monitor backlog and
  unresolved expired deliveries; an accepted provider request is not inbox proof.
- Production mobile/sign-in/OTP-expiry and real-inbox launch acceptance remains a
  human cutover step, not authorization to deploy production during this task.

## Exact task8 handoff (separate fresh agent)

Create/migrate a **dedicated production D1 only** in confirmed account
`76222ab803494dc84947546283e1a63a` for Worker `afterhoursoutreach-ca`. Prepare a
migration-only configuration targeting that dedicated database; preserve/apply
the complete 15-migration journal through `0014_patrol_submission_integration.sql`.
Verify migration ledger and foreign keys. Do not reuse the shared Preview D1.

Put human connection/cutover instructions at the **top of `TODO.md`**, including
the dedicated database identifier and migration-only config. **Do not connect or
deploy the production Worker**: leave its current production database ID
placeholder until a human explicitly connects it. Task7 did not create, migrate,
bind or deploy a production database or Worker.
