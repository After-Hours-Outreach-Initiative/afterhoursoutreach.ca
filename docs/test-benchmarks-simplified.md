# Simplified test-suite benchmark

Measured 2026-10-07T21:05:05.033Z on `chore/test-benchmark-baseline` at `3ea789d333d5d4c7e7424a745d5b52d4d0c79894`.

**Valid baseline: all measured runs and warm-ups passed.**

## What changed

- Removed cosmetic assertions for exact colours, fonts, pixel geometry,
  decoration, scrollbar styling, and animation implementation details.
- Kept one full sign-in validation flow, with a short mobile interaction check
  for the shared form on the volunteer page.
- Replaced two repeated profile-edit workflows with one desktop/mobile
  navigation and control-usability check. Profile persistence remains covered by
  the registration/edit browser test and production-Worker browser test.
- Removed the generic registration-navigation test and the source-text-only
  `remoteBindings: false` check. The actual Astro configuration is unchanged;
  production/preview database separation and local D1 binding checks remain.
- Replaced whole package-command string equality with checks for the preview
  build mode, migration guard/target, deployment target, and operation order.
- Updated the local sign-in prerequisite and account-switcher interactions to
  match the current dialog and accessible combobox. Retained authentication,
  session isolation, cross-origin rejection, notification consent, keyboard
  interaction, loading/duplicate protection, and no-navigation checks.

The net count is **118 → 114 registered tests** (115 → 111 leaf cases).
Some retained tests were renamed, so the added/removed-name lists below also
include replacements rather than only outright deletions.

The median sequential pipeline, including builds, changed from **71.135 s to
60.210 s**, a **15.4% reduction**. The original snapshot had eight failing UI
tests, whereas this snapshot passes every executed test. Its old assertion
timeouts contributed to the difference: this is a comparison of the complete
cleanup, not a controlled measurement of cosmetic-check removal alone. The
original baseline JSON and report have not been overwritten.

## Measurement summary

- 114 distinct registered tests across 20 test files; 114 executed in at least one profile.
- 3 of the registered Node tests are parent/container tests; 111 are leaf cases. Parent timings include their children.
- 1 untimed warm-up round(s), then 3 measured rounds. Suites run sequentially; each test runner retains its normal parallelism.
- Local browser data: a temporary copy of the current working tree, a fresh local D1 database and synthetic fixtures; no developer server/database/secrets reused. State is reused across rounds, so test-created accounts accumulate.
- One-off development-server/database setup: 14.191 s; excluded from measured suite times. Builds, runner startup and browser startup are included in their respective wall times.
- Deployed smoke-test target: https://feat-patrol-scheduling-mockup-afterhoursoutreach-ca.ivanzheng9905.workers.dev. These read-only network checks are reported separately.
- This is a warm-cache baseline, not a cold-cache benchmark. Per-test timings do not sum to elapsed time because tests can overlap.
- Timing and test-count reductions do not prove redundancy or preserved coverage. Review what each removed test protects.

## Repeat and compare

Keep the baseline JSON unchanged and run:

```sh
pnpm test:benchmark --baseline docs/benchmarks/test-baseline.json --deployed-url https://feat-patrol-scheduling-mockup-afterhoursoutreach-ca.ivanzheng9905.workers.dev
```

The default outputs are `test-results/benchmarks/latest.md` and `test-results/benchmarks/latest.json`. The report lists test-count/runtime deltas and added/removed test names. Use the same machine, package versions, target, concurrency and run count. Avoid other builds/tests while measuring. Small changes within the observed min–max range may just be noise.

Use `--runs N` or `--warmups N` to change sampling, `--report FILE.md` and `--output FILE.json` to retain another snapshot, or `--local-url http://localhost:PORT` to opt into an existing development database. The default starts and stops its own Astro background server; it never stops your existing server. No deployment or remote database mutation is performed.

## Environment

| Setting                              | Value                              |
| ------------------------------------ | ---------------------------------- |
| Node / pnpm                          | v22.22.3 / 11.9.0                  |
| Platform                             | linux x64                          |
| CPU                                  | AMD Ryzen 7 5700X 8-Core Processor |
| Logical CPUs / available parallelism | 16 / 16                            |
| Memory                               | 15.535 GiB                         |
| astro                                | 7.2.2                              |
| wrangler                             | 4.135.0                            |
| tsx                                  | 4.23.15                            |
| @playwright/test                     | 1.63.0                             |
| miniflare                            | 5.20260811.0-alpha                 |
| Chromium                             | Chromium 151.0.7922.173 Arch Linux |
| Playwright configured workers        | 8                                  |

Working-tree changes at the start (the snapshot includes these changes, not just HEAD):

```text
M tests/helpers/in-place-action.ts
 M tests/helpers/local-account.ts
 M tests/previews.test.ts
 M tests/ui/account-forms.spec.ts
 M tests/ui/local-accounts.spec.ts
 M tests/ui/local-notifications.spec.ts
 M tests/ui/volunteer.spec.ts
 M tests/worker/accounts.test.ts
 M tests/worker/events.test.ts
```

## Suite and build benchmarks

| Phase                           | Files | Tests | Passed | Failed | Skipped | Median wall | Min      | Max      |
| ------------------------------- | ----- | ----- | ------ | ------ | ------- | ----------- | -------- | -------- |
| Node unit / local-runtime tests | 9     | 55    | 55     | 0      | 0       | 18.788 s    | 17.414 s | 18.931 s |
| Production build                | —     | —     | —      | —      | —       | 5.086 s     | 5.023 s  | 5.188 s  |
| Production Worker tests         | 4     | 38    | 38     | 0      | 0       | 14.379 s    | 13.550 s | 14.545 s |
| Preview build                   | —     | —     | —      | —      | —       | 5.093 s     | 4.978 s  | 5.108 s  |
| Preview Worker tests            | 1     | 1     | 1      | 0      | 0       | 3.276 s     | 3.030 s  | 3.282 s  |
| Local browser tests             | 6     | 20    | 16     | 0      | 4       | 10.676 s    | 10.455 s | 10.754 s |
| Deployed browser smoke tests    | 1     | 4     | 4      | 0      | 0       | 2.815 s     | 2.739 s  | 2.853 s  |

Counts above are per round, not multiplied by the number of repetitions. Local UI includes the deployed tests as skips; the deployed profile executes those same cases. Do not add profile counts to get the distinct total.

### Package-command equivalents

| Command/profile                 | Median wall including builds | Min      | Max      |
| ------------------------------- | ---------------------------- | -------- | -------- |
| pnpm test                       | 18.788 s                     | 17.414 s | 18.931 s |
| pnpm test:accounts              | 19.465 s                     | 18.738 s | 19.567 s |
| pnpm test:preview               | 8.369 s                      | 8.008 s  | 8.389 s  |
| pnpm test:ui (localhost)        | 10.676 s                     | 10.455 s | 10.754 s |
| Deployed smoke tests only       | 2.815 s                      | 2.739 s  | 2.853 s  |
| All measured phases, sequential | 60.210 s                     | 57.469 s | 60.282 s |

Build and test commands are launched separately so their costs are visible. The combined figures are the sum for each measured round, including both command launches; they are not measurements of one shell invocation of the package script. Node phases cover the same file globs as the package scripts. The root Node group also includes local D1/Miniflare tests, not only pure unit tests. Empty Node groups are recorded as zero tests without launching auto-discovery; regular package scripts may reject empty globs.

## Per-file benchmarks

These are summed top-level Node durations (including setup inside parent tests) or summed Playwright case durations, **not** file wall times. Nested child durations are not added a second time. Runner/process/browser startup outside cases is visible only in the suite wall times.

| Profile     | File                                         | Tests | Leaf cases | Median body time | Min      | Max      |
| ----------- | -------------------------------------------- | ----- | ---------- | ---------------- | -------- | -------- |
| unit        | tests/account-forms.test.ts                  | 2     | 2          | 0.001 s          | 0.001 s  | 0.001 s  |
| unit        | tests/auth.test.ts                           | 23    | 23         | 16.369 s         | 15.203 s | 16.500 s |
| unit        | tests/d1.test.ts                             | 1     | 1          | 0.591 s          | 0.569 s  | 0.596 s  |
| unit        | tests/database.test.ts                       | 9     | 9          | 0.033 s          | 0.033 s  | 0.043 s  |
| unit        | tests/event-policy.test.ts                   | 6     | 6          | 0.002 s          | 0.001 s  | 0.004 s  |
| unit        | tests/event-time.test.ts                     | 1     | 1          | 0.016 s          | 0.013 s  | 0.019 s  |
| unit        | tests/local-event-fixtures.test.ts           | 3     | 3          | 5.609 s          | 5.315 s  | 5.716 s  |
| unit        | tests/preview-event-fixtures.test.ts         | 5     | 5          | 0.367 s          | 0.362 s  | 0.395 s  |
| unit        | tests/previews.test.ts                       | 5     | 5          | 1.138 s          | 1.115 s  | 1.142 s  |
| worker      | tests/worker/accounts.test.ts                | 16    | 15         | 9.545 s          | 8.179 s  | 9.568 s  |
| worker      | tests/worker/action-refresh.test.ts          | 2     | 2          | 3.424 s          | 3.237 s  | 3.478 s  |
| worker      | tests/worker/events.test.ts                  | 16    | 15         | 10.864 s         | 10.260 s | 10.955 s |
| worker      | tests/worker/organizer-notifications.test.ts | 4     | 3          | 3.115 s          | 2.818 s  | 3.152 s  |
| preview     | tests/preview/build.test.ts                  | 1     | 1          | 0.974 s          | 0.918 s  | 0.992 s  |
| ui-local    | tests/ui/account-forms.spec.ts               | 5     | 5          | 22.168 s         | 21.983 s | 22.592 s |
| ui-local    | tests/ui/deployed-site.spec.ts               | 4     | 4          | 0.014 s          | 0.013 s  | 0.017 s  |
| ui-local    | tests/ui/local-accounts.spec.ts              | 2     | 2          | 9.901 s          | 9.541 s  | 10.473 s |
| ui-local    | tests/ui/local-notifications.spec.ts         | 1     | 1          | 4.028 s          | 3.829 s  | 4.038 s  |
| ui-local    | tests/ui/notification-choice.spec.ts         | 1     | 1          | 3.601 s          | 3.098 s  | 3.677 s  |
| ui-local    | tests/ui/volunteer.spec.ts                   | 7     | 7          | 18.301 s         | 17.963 s | 19.292 s |
| ui-deployed | tests/ui/deployed-site.spec.ts               | 4     | 4          | 1.860 s          | 1.855 s  | 2.405 s  |

## Complete test inventory and timings

Sorted by median measured case duration, slowest first. Skipped profiles are excluded from case timing statistics. Containers are marked; removing a child will affect its parent's inclusive duration too. Identities use file and full test name, not line numbers, so deleting earlier tests does not make unchanged tests appear renamed.

| File                                         | Test                                                                                                                                                                                          | Profiles/status                        | Median   | Min      | Max      |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | -------- | -------- | -------- |
| tests/worker/events.test.ts                  | real event and organizer flows in the built Worker (container)                                                                                                                                | worker: passed                         | 10.864 s | 10.260 s | 10.955 s |
| tests/worker/accounts.test.ts                | production-built Worker enforces authentication, ownership, CSRF and private-page protections (container)                                                                                     | worker: passed                         | 9.117 s  | 7.785 s  | 9.170 s  |
| tests/worker/events.test.ts                  | real event and organizer flows in the built Worker › browser organizer and volunteer workflows save in place and remain usable on mobile                                                      | worker: passed                         | 7.967 s  | 7.564 s  | 8.023 s  |
| tests/ui/account-forms.spec.ts               | registration shows all required errors and saves after they are corrected                                                                                                                     | ui-local: passed                       | 6.814 s  | 6.531 s  | 7.205 s  |
| tests/worker/accounts.test.ts                | production-built Worker enforces authentication, ownership, CSRF and private-page protections › browser edits persisted profile answers without browser storage or third-party requests       | worker: passed                         | 6.788 s  | 5.612 s  | 6.798 s  |
| tests/ui/account-forms.spec.ts               | authenticator setup and sign-in show inline required and code errors                                                                                                                          | ui-local: passed                       | 6.345 s  | 6.265 s  | 6.405 s  |
| tests/local-event-fixtures.test.ts           | the local seed refuses remote, preview, and production arguments before any writes                                                                                                            | unit: passed                           | 5.583 s  | 5.291 s  | 5.692 s  |
| tests/ui/local-accounts.spec.ts              | local D1 sign-in uses dialogs for delivery, errors and valid codes                                                                                                                            | ui-local: passed                       | 5.116 s  | 4.943 s  | 5.168 s  |
| tests/ui/local-accounts.spec.ts              | local D1 email links are one-use and sign-in pages have no third-party requests                                                                                                               | ui-local: passed                       | 4.785 s  | 4.598 s  | 5.305 s  |
| tests/ui/local-notifications.spec.ts         | local approval notifications work without crypto.randomUUID                                                                                                                                   | ui-local: passed                       | 4.028 s  | 3.829 s  | 4.038 s  |
| tests/ui/volunteer.spec.ts                   | View as lists actual D1 users and switching to Visitor ends only the current session                                                                                                          | ui-local: passed                       | 3.939 s  | 3.918 s  | 3.952 s  |
| tests/ui/notification-choice.spec.ts         | organizer email choice defaults to no email and cancellation restores controls                                                                                                                | ui-local: passed                       | 3.601 s  | 3.098 s  | 3.677 s  |
| tests/ui/account-forms.spec.ts               | email sign-in validates, loads, switches to code, and resets                                                                                                                                  | ui-local: passed                       | 3.558 s  | 3.514 s  | 3.684 s  |
| tests/ui/volunteer.spec.ts                   | account navigation and profile controls are usable on desktop and mobile                                                                                                                      | ui-local: passed                       | 3.471 s  | 3.260 s  | 3.475 s  |
| tests/ui/account-forms.spec.ts               | real email cooldowns and empty HTTP 429 responses are readable and retryable                                                                                                                  | ui-local: passed                       | 3.340 s  | 3.109 s  | 3.477 s  |
| tests/worker/organizer-notifications.test.ts | organizer emails require explicit opt-in in the built Worker (container)                                                                                                                      | worker: passed                         | 3.115 s  | 2.818 s  | 3.152 s  |
| tests/ui/volunteer.spec.ts                   | View as can choose an unregistered D1 account without changing it                                                                                                                             | ui-local: passed                       | 2.522 s  | 2.278 s  | 2.776 s  |
| tests/ui/volunteer.spec.ts                   | View as simulates a verified factor without changing the user's real role or enrollment                                                                                                       | ui-local: passed                       | 2.507 s  | 2.287 s  | 2.587 s  |
| tests/ui/volunteer.spec.ts                   | local account selection rejects cross-origin writes and unknown users                                                                                                                         | ui-local: passed                       | 2.436 s  | 2.426 s  | 2.645 s  |
| tests/ui/volunteer.spec.ts                   | event type buttons filter instantly, preserve deep links, and never submit a confirmation form                                                                                                | ui-local: passed                       | 2.169 s  | 1.710 s  | 2.186 s  |
| tests/ui/account-forms.spec.ts               | private pages make no third-party requests and remain usable on mobile                                                                                                                        | ui-local: passed                       | 2.144 s  | 2.098 s  | 2.254 s  |
| tests/worker/action-refresh.test.ts          | overlapping signup refreshes stay ordered                                                                                                                                                     | worker: passed                         | 1.766 s  | 1.682 s  | 1.809 s  |
| tests/ui/volunteer.spec.ts                   | volunteer-page sign-in is usable on mobile and opens the shared code form                                                                                                                     | ui-local: passed                       | 1.688 s  | 1.591 s  | 1.733 s  |
| tests/worker/action-refresh.test.ts          | overlapping signup refreshes stay ordered after a failed refresh                                                                                                                              | worker: passed                         | 1.659 s  | 1.555 s  | 1.670 s  |
| tests/auth.test.ts                           | the per-address verification budget survives code rotation                                                                                                                                    | unit: passed                           | 1.566 s  | 1.476 s  | 1.582 s  |
| tests/auth.test.ts                           | passwordless two-factor enrollment and login cannot bypass the authenticator                                                                                                                  | unit: passed                           | 1.442 s  | 1.370 s  | 1.450 s  |
| tests/auth.test.ts                           | the global daily limit blocks email requests before creating challenges                                                                                                                       | unit: passed                           | 1.301 s  | 1.209 s  | 1.307 s  |
| tests/auth.test.ts                           | IP sending limits prevent cycling recipient addresses                                                                                                                                         | unit: passed                           | 1.209 s  | 1.102 s  | 1.229 s  |
| tests/preview/build.test.ts                  | the preview banner does not gate features or restrict accounts to preview hosts                                                                                                               | preview: passed                        | 0.974 s  | 0.918 s  | 0.992 s  |
| tests/ui/deployed-site.spec.ts               | deployed site uses real account features and shows a banner only on previews                                                                                                                  | ui-local: skipped, ui-deployed: passed | 0.933 s  | 0.859 s  | 0.986 s  |
| tests/previews.test.ts                       | preview migrations match the shared binding and cannot target production                                                                                                                      | unit: passed                           | 0.912 s  | 0.895 s  | 0.917 s  |
| tests/auth.test.ts                           | registration/editing persists all answers, keeps approval, and audits only changed field names                                                                                                | unit: passed                           | 0.878 s  | 0.815 s  | 0.886 s  |
| tests/auth.test.ts                           | local D1 event notifications never contact a provider, even with a real-shaped key                                                                                                            | unit: passed                           | 0.868 s  | 0.801 s  | 0.869 s  |
| tests/auth.test.ts                           | event delivery retries use stable idempotency keys and atomic leases without exposing provider errors                                                                                         | unit: passed                           | 0.837 s  | 0.827 s  | 0.844 s  |
| tests/auth.test.ts                           | three wrong codes invalidate both code and link                                                                                                                                               | unit: passed                           | 0.831 s  | 0.781 s  | 0.918 s  |
| tests/auth.test.ts                           | notifications share the sign-in sending budget and old pending mail is not blindly resent                                                                                                     | unit: passed                           | 0.762 s  | 0.709 s  | 0.767 s  |
| tests/auth.test.ts                           | real passwordless sign-in creates a verified volunteer and a host-only secure session                                                                                                         | unit: passed                           | 0.701 s  | 0.624 s  | 0.730 s  |
| tests/auth.test.ts                           | email hourly limits still apply after the resend cooldown expires                                                                                                                             | unit: passed                           | 0.655 s  | 0.624 s  | 0.670 s  |
| tests/auth.test.ts                           | link and code redemption race produces exactly one successful result                                                                                                                          | unit: passed                           | 0.644 s  | 0.545 s  | 0.712 s  |
| tests/worker/organizer-notifications.test.ts | organizer emails require explicit opt-in in the built Worker › notify true applies to every organizer email                                                                                   | worker: passed                         | 0.635 s  | 0.581 s  | 0.660 s  |
| tests/auth.test.ts                           | sign-out revokes the session rather than just removing the browser cookie                                                                                                                     | unit: passed                           | 0.618 s  | 0.584 s  | 0.633 s  |
| tests/auth.test.ts                           | requesting a new code invalidates the previous code                                                                                                                                           | unit: passed                           | 0.614 s  | 0.559 s  | 0.615 s  |
| tests/auth.test.ts                           | rate limits are atomic, persistent, and do not store raw email/IP keys                                                                                                                        | unit: passed                           | 0.592 s  | 0.544 s  | 0.594 s  |
| tests/d1.test.ts                             | Drizzle and capacity constraints work in the D1 runtime                                                                                                                                       | unit: passed                           | 0.591 s  | 0.569 s  | 0.596 s  |
| tests/worker/organizer-notifications.test.ts | organizer emails require explicit opt-in in the built Worker › notify omitted applies to every organizer email                                                                                | worker: passed                         | 0.588 s  | 0.530 s  | 0.594 s  |
| tests/worker/organizer-notifications.test.ts | organizer emails require explicit opt-in in the built Worker › notify false applies to every organizer email                                                                                  | worker: passed                         | 0.573 s  | 0.524 s  | 0.595 s  |
| tests/worker/accounts.test.ts                | production-built Worker enforces authentication, ownership, CSRF and private-page protections › sign-in pages request no third-party scripts or frames                                        | worker: passed                         | 0.530 s  | 0.492 s  | 0.547 s  |
| tests/auth.test.ts                           | email proofs are never returned in a public response, even by a capture service                                                                                                               | unit: passed                           | 0.427 s  | 0.381 s  | 0.427 s  |
| tests/auth.test.ts                           | the plugin stores hashed codes with ten-minute expiry                                                                                                                                         | unit: passed                           | 0.412 s  | 0.407 s  | 0.442 s  |
| tests/ui/deployed-site.spec.ts               | deployed sign-in is enabled with no third-party scripts or frames                                                                                                                             | ui-local: skipped, ui-deployed: passed | 0.406 s  | 0.390 s  | 0.418 s  |
| tests/worker/accounts.test.ts                | a built Worker cannot enable account switching with local runtime vars                                                                                                                        | worker: passed                         | 0.398 s  | 0.393 s  | 0.428 s  |
| tests/ui/deployed-site.spec.ts               | account and organizer routes require sign-in without loading mockups                                                                                                                          | ui-local: skipped, ui-deployed: passed | 0.385 s  | 0.300 s  | 0.579 s  |
| tests/auth.test.ts                           | auth uses the configured site origin or request URL without trusting forwarded hosts                                                                                                          | unit: passed                           | 0.326 s  | 0.316 s  | 0.332 s  |
| tests/auth.test.ts                           | invalid email requests send no email and create no challenge                                                                                                                                  | unit: passed                           | 0.321 s  | 0.307 s  | 0.340 s  |
| tests/preview-event-fixtures.test.ts         | preview seed refuses target overrides before running Wrangler                                                                                                                                 | unit: passed                           | 0.320 s  | 0.313 s  | 0.338 s  |
| tests/auth.test.ts                           | origins and redirect targets are checked; JSON bodies are bounded even without Content-Length                                                                                                 | unit: passed                           | 0.316 s  | 0.309 s  | 0.317 s  |
| tests/auth.test.ts                           | Resend receives the same sign-in message in every hosted environment and hides provider errors                                                                                                | unit: passed                           | 0.316 s  | 0.298 s  | 0.335 s  |
| tests/auth.test.ts                           | local email delivery never calls Resend, even with a configured key                                                                                                                           | unit: passed                           | 0.306 s  | 0.296 s  | 0.329 s  |
| tests/auth.test.ts                           | profile validation rejects privilege fields, invalid dates, absent/duplicate teams and oversized answers                                                                                      | unit: passed                           | 0.301 s  | 0.296 s  | 0.318 s  |
| tests/worker/events.test.ts                  | real event and organizer flows in the built Worker › volunteer signups and cancellations preserve records and audits without emails                                                           | worker: passed                         | 0.229 s  | 0.222 s  | 0.289 s  |
| tests/previews.test.ts                       | organizer bootstrap refuses implicit targets and production mode                                                                                                                              | unit: passed                           | 0.213 s  | 0.212 s  | 0.218 s  |
| tests/worker/events.test.ts                  | real event and organizer flows in the built Worker › organizer promotions require verified registration, not two-factor, and revoke sessions                                                  | worker: passed                         | 0.194 s  | 0.188 s  | 0.229 s  |
| tests/ui/deployed-site.spec.ts               | private pages exclude indexing and the database is available                                                                                                                                  | ui-local: skipped, ui-deployed: passed | 0.193 s  | 0.184 s  | 0.487 s  |
| tests/worker/accounts.test.ts                | production-built Worker enforces authentication, ownership, CSRF and private-page protections › the Worker encrypts authenticator data and requires a second factor after email sign-in       | worker: passed                         | 0.181 s  | 0.167 s  | 0.192 s  |
| tests/worker/events.test.ts                  | real event and organizer flows in the built Worker › bootstrap requires verified registration but not two-factor, is atomic and one-time                                                      | worker: passed                         | 0.176 s  | 0.165 s  | 0.182 s  |
| tests/worker/accounts.test.ts                | production-built Worker enforces authentication, ownership, CSRF and private-page protections › session management lists only active owned sessions and revokes by ID without exposing tokens | worker: passed                         | 0.165 s  | 0.154 s  | 0.195 s  |
| tests/worker/events.test.ts                  | real event and organizer flows in the built Worker › move rollback preserves source signup when destination is full                                                                           | worker: passed                         | 0.153 s  | 0.147 s  | 0.198 s  |
| tests/worker/events.test.ts                  | real event and organizer flows in the built Worker › capacity, optimistic edit conflicts, hidden and closed events are enforced                                                               | worker: passed                         | 0.143 s  | 0.133 s  | 0.164 s  |
| tests/worker/events.test.ts                  | real event and organizer flows in the built Worker › deactivation silently cancels future spots and last organizer cannot be removed                                                          | worker: passed                         | 0.131 s  | 0.096 s  | 0.148 s  |
| tests/worker/events.test.ts                  | real event and organizer flows in the built Worker › opted-in cancellation preserves records, cancels spots and queues notifications atomically                                               | worker: passed                         | 0.121 s  | 0.117 s  | 0.126 s  |
| tests/worker/events.test.ts                  | real event and organizer flows in the built Worker › orientation completion requires an actual past attendance and never approves patrols                                                     | worker: passed                         | 0.112 s  | 0.091 s  | 0.118 s  |
| tests/worker/events.test.ts                  | real event and organizer flows in the built Worker › organizers without two-factor can manage events and view audited profiles                                                                | worker: passed                         | 0.086 s  | 0.078 s  | 0.104 s  |
| tests/worker/accounts.test.ts                | production-built Worker enforces authentication, ownership, CSRF and private-page protections › older sessions can edit their profile but must sign in again to list sessions                 | worker: passed                         | 0.082 s  | 0.079 s  | 0.090 s  |
| tests/worker/events.test.ts                  | real event and organizer flows in the built Worker › approval without orientation grants patrol access, arbitrary client role does not                                                        | worker: passed                         | 0.081 s  | 0.067 s  | 0.089 s  |
| tests/worker/accounts.test.ts                | production-built Worker enforces authentication, ownership, CSRF and private-page protections › ending another person's session cannot revoke it                                              | worker: passed                         | 0.072 s  | 0.060 s  | 0.076 s  |
| tests/worker/events.test.ts                  | real event and organizer flows in the built Worker › visitors and volunteers cannot perform organizer actions; CSRF is rejected                                                               | worker: passed                         | 0.051 s  | 0.037 s  | 0.062 s  |
| tests/worker/accounts.test.ts                | production-built Worker enforces authentication, ownership, CSRF and private-page protections › registration and edits round-trip through the real API                                        | worker: passed                         | 0.045 s  | 0.041 s  | 0.055 s  |
| tests/worker/events.test.ts                  | real event and organizer flows in the built Worker › last spot is atomic across simultaneous signups without queuing email                                                                    | worker: passed                         | 0.042 s  | 0.041 s  | 0.043 s  |
| tests/worker/accounts.test.ts                | production-built Worker enforces authentication, ownership, CSRF and private-page protections › unauthenticated profile access is rejected and registration redirects to sign-in              | worker: passed                         | 0.041 s  | 0.039 s  | 0.049 s  |
| tests/worker/accounts.test.ts                | production-built Worker enforces authentication, ownership, CSRF and private-page protections › sign-out removes the server-side session                                                      | worker: passed                         | 0.039 s  | 0.038 s  | 0.056 s  |
| tests/worker/accounts.test.ts                | production-built Worker enforces authentication, ownership, CSRF and private-page protections › GET link pages do not consume codes or set session cookies                                    | worker: passed                         | 0.033 s  | 0.032 s  | 0.042 s  |
| tests/worker/accounts.test.ts                | production-built Worker enforces authentication, ownership, CSRF and private-page protections › unconfigured email delivery fails closed and removes its code                                 | worker: passed                         | 0.032 s  | 0.030 s  | 0.033 s  |
| tests/worker/accounts.test.ts                | production-built Worker enforces authentication, ownership, CSRF and private-page protections › site origins reject unrelated, preview and forwarded-host CSRF                                | worker: passed                         | 0.031 s  | 0.030 s  | 0.032 s  |
| tests/worker/events.test.ts                  | real event and organizer flows in the built Worker › new databases show a genuine empty event list, not sample fixtures                                                                       | worker: passed                         | 0.020 s  | 0.019 s  | 0.024 s  |
| tests/preview-event-fixtures.test.ts         | preview fixtures use the real schema without credentials, privileges, or queued email                                                                                                         | unit: passed                           | 0.018 s  | 0.017 s  | 0.020 s  |
| tests/event-time.test.ts                     | event calendar inputs always use Vancouver time                                                                                                                                               | unit: passed                           | 0.016 s  | 0.013 s  | 0.019 s  |
| tests/local-event-fixtures.test.ts           | local fixtures restore open, full, hidden, and past events in the real schema                                                                                                                 | unit: passed                           | 0.016 s  | 0.016 s  | 0.016 s  |
| tests/worker/accounts.test.ts                | production-built Worker enforces authentication, ownership, CSRF and private-page protections › signed-out pages omit the signed-in account menu                                              | worker: passed                         | 0.014 s  | 0.011 s  | 0.016 s  |
| tests/preview-event-fixtures.test.ts         | preview fixture dates advance by Vancouver calendar days across daylight-saving changes                                                                                                       | unit: passed                           | 0.012 s  | 0.009 s  | 0.013 s  |
| tests/preview-event-fixtures.test.ts         | preview reseeding preserves existing accounts, fixture edits, and cancelled or ineligible signups                                                                                             | unit: passed                           | 0.012 s  | 0.009 s  | 0.013 s  |
| tests/worker/events.test.ts                  | real event and organizer flows in the built Worker › real listings have no invented events, demo code or signed-out account menu                                                              | worker: passed                         | 0.011 s  | 0.011 s  | 0.012 s  |
| tests/preview-event-fixtures.test.ts         | preview reseeding does not rejoin a cancelled non-fixture signup                                                                                                                              | unit: passed                           | 0.010 s  | 0.009 s  | 0.011 s  |
| tests/worker/accounts.test.ts                | production-built Worker enforces authentication, ownership, CSRF and private-page protections › production assets contain no simulated sign-in or demo controls                               | worker: passed                         | 0.009 s  | 0.009 s  | 0.010 s  |
| tests/local-event-fixtures.test.ts           | rerunning the local seed preserves edits, cancellations, approvals, and unrelated data                                                                                                        | unit: passed                           | 0.008 s  | 0.008 s  | 0.010 s  |
| tests/previews.test.ts                       | branch previews target the main Worker with non-production bindings, not version URLs                                                                                                         | unit: passed                           | 0.006 s  | 0.006 s  | 0.008 s  |
| tests/database.test.ts                       | approval is independent of orientation completion                                                                                                                                             | unit: passed                           | 0.005 s  | 0.005 s  | 0.005 s  |
| tests/database.test.ts                       | last spot cannot be overbooked, including by reactivation or moving                                                                                                                           | unit: passed                           | 0.004 s  | 0.004 s  | 0.007 s  |
| tests/database.test.ts                       | patrol cannot be recorded as an orientation completion                                                                                                                                        | unit: passed                           | 0.004 s  | 0.003 s  | 0.005 s  |
| tests/database.test.ts                       | approval without any orientation allows patrol signup                                                                                                                                         | unit: passed                           | 0.004 s  | 0.003 s  | 0.005 s  |
| tests/database.test.ts                       | duplicate confirmed signup is rejected, cancelled signup permits a new one                                                                                                                    | unit: passed                           | 0.004 s  | 0.004 s  | 0.004 s  |
| tests/database.test.ts                       | inactive, unregistered, hidden and started events reject signups                                                                                                                              | unit: passed                           | 0.004 s  | 0.003 s  | 0.006 s  |
| tests/database.test.ts                       | only an organizer can be recorded as the approver                                                                                                                                             | unit: passed                           | 0.003 s  | 0.003 s  | 0.004 s  |
| tests/database.test.ts                       | emails are unique regardless of capitalization                                                                                                                                                | unit: passed                           | 0.003 s  | 0.003 s  | 0.003 s  |
| tests/database.test.ts                       | capacity cannot shrink below existing signups                                                                                                                                                 | unit: passed                           | 0.003 s  | 0.003 s  | 0.003 s  |
| tests/account-forms.test.ts                  | auth errors use the API message instead of Better Fetch's HTTP status                                                                                                                         | unit: passed                           | 0.001 s  | 0.001 s  | 0.001 s  |
| tests/event-policy.test.ts                   | approval allows patrol signup without orientation completion                                                                                                                                  | unit: passed                           | 0.001 s  | 0.001 s  | 0.001 s  |
| tests/previews.test.ts                       | deployment scripts explicitly select Worker Previews and their migration target                                                                                                               | unit: passed                           | 0.001 s  | 0.001 s  | 0.001 s  |
| tests/previews.test.ts                       | the default environment does not use preview resources                                                                                                                                        | unit: passed                           | 0.001 s  | 0.001 s  | 0.002 s  |
| tests/event-policy.test.ts                   | full, closed, started and invalid-date events reject signups                                                                                                                                  | unit: passed                           | 0.000 s  | 0.000 s  | 0.000 s  |
| tests/event-policy.test.ts                   | patrols require explicit approval                                                                                                                                                             | unit: passed                           | 0.000 s  | 0.000 s  | 0.002 s  |
| tests/account-forms.test.ts                  | empty rate-limit and service errors have readable fallbacks                                                                                                                                   | unit: passed                           | 0.000 s  | 0.000 s  | 0.000 s  |
| tests/event-policy.test.ts                   | organizer profile access requires two-factor only when enabled                                                                                                                                | unit: passed                           | 0.000 s  | 0.000 s  | 0.000 s  |
| tests/event-policy.test.ts                   | sign-in, registration and active status are required                                                                                                                                          | unit: passed                           | 0.000 s  | 0.000 s  | 0.000 s  |
| tests/event-policy.test.ts                   | unapproved volunteers can sign up for orientations                                                                                                                                            | unit: passed                           | 0.000 s  | 0.000 s  | 0.000 s  |

## Comparison with baseline

Baseline: 2026-10-07T20:07:59.494Z, commit `a82ebc4884166e11e0399a5a6b40ed6416548144`. Distinct registered tests: 118 → 114 (-4).

| Phase                           | Tests before → after | Wall before → after | Delta    | Delta % |
| ------------------------------- | -------------------- | ------------------- | -------- | ------- |
| Node unit / local-runtime tests | 56 → 55              | 18.793 s → 18.788 s | -0.005 s | -0.0%   |
| Production build                | — → —                | 5.207 s → 5.086 s   | -0.122 s | -2.3%   |
| Production Worker tests         | 39 → 38              | 19.515 s → 14.379 s | -5.136 s | -26.3%  |
| Preview build                   | — → —                | 5.112 s → 5.093 s   | -0.020 s | -0.4%   |
| Preview Worker tests            | 1 → 1                | 3.244 s → 3.276 s   | +0.032 s | 1.0%    |
| Local browser tests             | 22 → 20              | 16.463 s → 10.676 s | -5.787 s | -35.2%  |
| Deployed browser smoke tests    | 4 → 4                | 2.774 s → 2.815 s   | +0.041 s | 1.5%    |

### Removed tests

- `tests/previews.test.ts`: Astro disables all remote bindings in development
- `tests/worker/accounts.test.ts`: production-built Worker enforces authentication, ownership, CSRF and private-page protections › signed-in registration includes account navigation
- `tests/worker/events.test.ts`: real event and organizer flows in the built Worker › real browser UI supports event creation and signup with nav below heading on mobile
- `tests/ui/account-forms.spec.ts`: email sign-in validates, loads, switches to code, and resets on /volunteer
- `tests/ui/account-forms.spec.ts`: email sign-in validates, loads, switches to code, and resets on /volunteer/sign-in
- `tests/ui/account-forms.spec.ts`: public and private headers keep the same font and geometry, and privacy is black
- `tests/ui/volunteer.spec.ts`: the shared sign-in panel is centered and left-aligned on desktop and mobile
- `tests/ui/volunteer.spec.ts`: account edits persist in D1 and use the shared UI at 1280px
- `tests/ui/volunteer.spec.ts`: account edits persist in D1 and use the shared UI at 375px

### Added tests

- `tests/worker/events.test.ts`: real event and organizer flows in the built Worker › browser organizer and volunteer workflows save in place and remain usable on mobile
- `tests/ui/account-forms.spec.ts`: email sign-in validates, loads, switches to code, and resets
- `tests/ui/account-forms.spec.ts`: private pages make no third-party requests and remain usable on mobile
- `tests/ui/volunteer.spec.ts`: volunteer-page sign-in is usable on mobile and opens the shared code form
- `tests/ui/volunteer.spec.ts`: account navigation and profile controls are usable on desktop and mobile

## Raw data

Structured measurements: `docs/benchmarks/test-simplified.json`. Raw runner JSON and command logs: `test-results/benchmarks/2026-10-07T21-05-05-033Z` (ignored by Git). The structured snapshot stores each measured run and every test name/duration; keep it with this report for future comparisons.
