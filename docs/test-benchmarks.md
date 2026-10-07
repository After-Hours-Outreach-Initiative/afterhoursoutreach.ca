# Test benchmark report

Measured 2026-10-07T20:07:59.494Z on `feat/patrol-scheduling-mockup` at `a82ebc4884166e11e0399a5a6b40ed6416548144`.

**Failed or incomplete runs: do not treat this as a passing performance baseline.**

All three measured rounds completed with stable test counts. Eight local UI
tests failed in every round: two expect the removed “Development account
controls” complementary landmark, and six try to use “View as” while the current
development-controls dialog is closed. These are stale expectations in the
existing suite; no tests were edited or removed for this benchmark. Their
durations include assertion timeouts rather than complete passing workflows.

- 118 distinct registered tests across 20 test files; 118 executed in at least one profile.
- 3 of the registered Node tests are parent/container tests; 115 are leaf cases. Parent timings include their children.
- 1 untimed warm-up round(s), then 3 measured rounds. Suites run sequentially; each test runner retains its normal parallelism.
- Local browser data: a temporary copy of the current working tree, a fresh local D1 database and synthetic fixtures; no developer server/database/secrets reused. State is reused across rounds, so test-created accounts accumulate.
- One-off development-server/database setup: 14.568 s; excluded from measured suite times. Builds, runner startup and browser startup are included in their respective wall times.
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
M README.md
 M package.json
?? scripts/benchmark-tests.mjs
?? scripts/test-benchmark-report.mjs
?? scripts/test-benchmark-reporter.mjs
```

## Suite and build benchmarks

| Phase                           | Files | Tests | Passed | Failed | Skipped | Median wall | Min      | Max      |
| ------------------------------- | ----- | ----- | ------ | ------ | ------- | ----------- | -------- | -------- |
| Node unit / local-runtime tests | 9     | 56    | 56     | 0      | 0       | 18.793 s    | 18.734 s | 18.994 s |
| Production build                | —     | —     | —      | —      | —       | 5.207 s     | 5.134 s  | 5.331 s  |
| Production Worker tests         | 4     | 39    | 39     | 0      | 0       | 19.515 s    | 19.234 s | 19.577 s |
| Preview build                   | —     | —     | —      | —      | —       | 5.112 s     | 5.096 s  | 5.532 s  |
| Preview Worker tests            | 1     | 1     | 1      | 0      | 0       | 3.244 s     | 3.179 s  | 3.257 s  |
| Local browser tests             | 6     | 22    | 10     | 8      | 4       | 16.463 s    | 16.379 s | 16.551 s |
| Deployed browser smoke tests    | 1     | 4     | 4      | 0      | 0       | 2.774 s     | 2.717 s  | 2.802 s  |

Counts above are per round, not multiplied by the number of repetitions. Local UI includes the deployed tests as skips; the deployed profile executes those same cases. Do not add profile counts to get the distinct total.

### Package-command equivalents

| Command/profile                 | Median wall including builds | Min      | Max      |
| ------------------------------- | ---------------------------- | -------- | -------- |
| pnpm test                       | 18.793 s                     | 18.734 s | 18.994 s |
| pnpm test:accounts              | 24.650 s                     | 24.565 s | 24.785 s |
| pnpm test:preview               | 8.341 s                      | 8.291 s  | 8.789 s  |
| pnpm test:ui (localhost)        | 16.463 s                     | 16.379 s | 16.551 s |
| Deployed smoke tests only       | 2.774 s                      | 2.717 s  | 2.802 s  |
| All measured phases, sequential | 71.135 s                     | 71.050 s | 71.445 s |

Build and test commands are launched separately so their costs are visible. The combined figures are the sum for each measured round, including both command launches; they are not measurements of one shell invocation of the package script. Node phases cover the same file globs as the package scripts. The root Node group also includes local D1/Miniflare tests, not only pure unit tests. Empty Node groups are recorded as zero tests without launching auto-discovery; regular package scripts may reject empty globs.

## Per-file benchmarks

These are summed top-level Node durations (including setup inside parent tests) or summed Playwright case durations, **not** file wall times. Nested child durations are not added a second time. Runner/process/browser startup outside cases is visible only in the suite wall times.

| Profile     | File                                         | Tests | Leaf cases | Median body time | Min      | Max      |
| ----------- | -------------------------------------------- | ----- | ---------- | ---------------- | -------- | -------- |
| unit        | tests/account-forms.test.ts                  | 2     | 2          | 0.002 s          | 0.001 s  | 0.002 s  |
| unit        | tests/auth.test.ts                           | 23    | 23         | 16.327 s         | 16.201 s | 16.532 s |
| unit        | tests/d1.test.ts                             | 1     | 1          | 0.622 s          | 0.606 s  | 0.631 s  |
| unit        | tests/database.test.ts                       | 9     | 9          | 0.044 s          | 0.040 s  | 0.046 s  |
| unit        | tests/event-policy.test.ts                   | 6     | 6          | 0.002 s          | 0.002 s  | 0.002 s  |
| unit        | tests/event-time.test.ts                     | 1     | 1          | 0.014 s          | 0.014 s  | 0.019 s  |
| unit        | tests/local-event-fixtures.test.ts           | 3     | 3          | 5.632 s          | 5.615 s  | 5.646 s  |
| unit        | tests/preview-event-fixtures.test.ts         | 5     | 5          | 0.424 s          | 0.412 s  | 0.465 s  |
| unit        | tests/previews.test.ts                       | 6     | 6          | 1.120 s          | 1.112 s  | 1.182 s  |
| worker      | tests/worker/accounts.test.ts                | 17    | 16         | 9.976 s          | 9.843 s  | 10.038 s |
| worker      | tests/worker/action-refresh.test.ts          | 2     | 2          | 3.619 s          | 3.528 s  | 3.786 s  |
| worker      | tests/worker/events.test.ts                  | 16    | 15         | 15.907 s         | 15.663 s | 16.040 s |
| worker      | tests/worker/organizer-notifications.test.ts | 4     | 3          | 3.300 s          | 3.133 s  | 3.441 s  |
| preview     | tests/preview/build.test.ts                  | 1     | 1          | 0.968 s          | 0.968 s  | 0.995 s  |
| ui-local    | tests/ui/account-forms.spec.ts               | 6     | 6          | 29.174 s         | 28.852 s | 29.702 s |
| ui-local    | tests/ui/deployed-site.spec.ts               | 4     | 4          | 0.011 s          | 0.009 s  | 0.011 s  |
| ui-local    | tests/ui/local-accounts.spec.ts              | 2     | 2          | 12.630 s         | 12.354 s | 12.693 s |
| ui-local    | tests/ui/local-notifications.spec.ts         | 1     | 1          | 2.925 s          | 2.664 s  | 3.477 s  |
| ui-local    | tests/ui/notification-choice.spec.ts         | 1     | 1          | 2.472 s          | 2.146 s  | 3.462 s  |
| ui-local    | tests/ui/volunteer.spec.ts                   | 8     | 8          | 46.430 s         | 46.366 s | 46.991 s |
| ui-deployed | tests/ui/deployed-site.spec.ts               | 4     | 4          | 1.928 s          | 1.874 s  | 2.063 s  |

## Complete test inventory and timings

Sorted by median measured case duration, slowest first. Skipped profiles are excluded from case timing statistics. Containers are marked; removing a child will affect its parent's inclusive duration too. Identities use file and full test name, not line numbers, so deleting earlier tests does not make unchanged tests appear renamed.

| File                                         | Test                                                                                                                                                                                          | Profiles/status                        | Median   | Min      | Max      |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | -------- | -------- | -------- |
| tests/worker/events.test.ts                  | real event and organizer flows in the built Worker (container)                                                                                                                                | worker: passed                         | 15.907 s | 15.663 s | 16.040 s |
| tests/worker/events.test.ts                  | real event and organizer flows in the built Worker › real browser UI supports event creation and signup with nav below heading on mobile                                                      | worker: passed                         | 12.679 s | 12.648 s | 12.912 s |
| tests/worker/accounts.test.ts                | production-built Worker enforces authentication, ownership, CSRF and private-page protections (container)                                                                                     | worker: passed                         | 9.557 s  | 9.448 s  | 9.653 s  |
| tests/ui/volunteer.spec.ts                   | View as lists actual D1 users and switching to Visitor ends only the current session                                                                                                          | ui-local: failed                       | 7.474 s  | 7.351 s  | 7.535 s  |
| tests/ui/volunteer.spec.ts                   | View as can choose an unregistered D1 account without changing it                                                                                                                             | ui-local: failed                       | 7.112 s  | 6.245 s  | 7.227 s  |
| tests/worker/accounts.test.ts                | production-built Worker enforces authentication, ownership, CSRF and private-page protections › browser edits persisted profile answers without browser storage or third-party requests       | worker: passed                         | 7.051 s  | 7.008 s  | 7.051 s  |
| tests/ui/volunteer.spec.ts                   | account edits persist in D1 and use the shared UI at 1280px                                                                                                                                   | ui-local: failed                       | 6.900 s  | 6.279 s  | 7.153 s  |
| tests/ui/volunteer.spec.ts                   | account edits persist in D1 and use the shared UI at 375px                                                                                                                                    | ui-local: failed                       | 6.784 s  | 6.239 s  | 7.026 s  |
| tests/ui/account-forms.spec.ts               | registration shows all required errors and saves after they are corrected                                                                                                                     | ui-local: passed                       | 6.618 s  | 6.005 s  | 8.050 s  |
| tests/ui/volunteer.spec.ts                   | View as simulates a verified factor without changing the user's real role or enrollment                                                                                                       | ui-local: failed                       | 6.576 s  | 6.158 s  | 6.968 s  |
| tests/ui/account-forms.spec.ts               | public and private headers keep the same font and geometry, and privacy is black                                                                                                              | ui-local: passed                       | 6.421 s  | 5.942 s  | 6.854 s  |
| tests/ui/volunteer.spec.ts                   | local account selection rejects cross-origin writes and unknown users                                                                                                                         | ui-local: failed                       | 6.403 s  | 6.299 s  | 7.189 s  |
| tests/ui/local-accounts.spec.ts              | local D1 email links are one-use and sign-in pages have no third-party requests                                                                                                               | ui-local: failed                       | 6.326 s  | 6.177 s  | 6.437 s  |
| tests/ui/local-accounts.spec.ts              | local D1 sign-in uses dialogs for delivery, errors and valid codes                                                                                                                            | ui-local: failed                       | 6.256 s  | 6.177 s  | 6.304 s  |
| tests/ui/account-forms.spec.ts               | authenticator setup and sign-in show inline required and code errors                                                                                                                          | ui-local: passed                       | 5.736 s  | 5.284 s  | 5.793 s  |
| tests/local-event-fixtures.test.ts           | the local seed refuses remote, preview, and production arguments before any writes                                                                                                            | unit: passed                           | 5.606 s  | 5.589 s  | 5.619 s  |
| tests/ui/volunteer.spec.ts                   | the shared sign-in panel is centered and left-aligned on desktop and mobile                                                                                                                   | ui-local: passed                       | 3.896 s  | 3.471 s  | 3.924 s  |
| tests/ui/account-forms.spec.ts               | email sign-in validates, loads, switches to code, and resets on /volunteer                                                                                                                    | ui-local: passed                       | 3.627 s  | 3.518 s  | 3.700 s  |
| tests/ui/account-forms.spec.ts               | email sign-in validates, loads, switches to code, and resets on /volunteer/sign-in                                                                                                            | ui-local: passed                       | 3.486 s  | 3.460 s  | 3.907 s  |
| tests/worker/organizer-notifications.test.ts | organizer emails require explicit opt-in in the built Worker (container)                                                                                                                      | worker: passed                         | 3.300 s  | 3.133 s  | 3.441 s  |
| tests/ui/local-notifications.spec.ts         | local approval notifications work without crypto.randomUUID                                                                                                                                   | ui-local: passed                       | 2.925 s  | 2.664 s  | 3.477 s  |
| tests/ui/account-forms.spec.ts               | real email cooldowns and empty HTTP 429 responses are readable and retryable                                                                                                                  | ui-local: passed                       | 2.917 s  | 2.814 s  | 3.596 s  |
| tests/ui/notification-choice.spec.ts         | organizer email choice defaults to no email and cancellation restores controls                                                                                                                | ui-local: passed                       | 2.472 s  | 2.146 s  | 3.462 s  |
| tests/worker/action-refresh.test.ts          | overlapping signup refreshes stay ordered                                                                                                                                                     | worker: passed                         | 1.874 s  | 1.868 s  | 1.960 s  |
| tests/ui/volunteer.spec.ts                   | event type buttons filter instantly, preserve deep links, and never submit a confirmation form                                                                                                | ui-local: passed                       | 1.823 s  | 1.718 s  | 2.037 s  |
| tests/worker/action-refresh.test.ts          | overlapping signup refreshes stay ordered after a failed refresh                                                                                                                              | worker: passed                         | 1.744 s  | 1.660 s  | 1.826 s  |
| tests/auth.test.ts                           | the per-address verification budget survives code rotation                                                                                                                                    | unit: passed                           | 1.571 s  | 1.546 s  | 1.580 s  |
| tests/auth.test.ts                           | passwordless two-factor enrollment and login cannot bypass the authenticator                                                                                                                  | unit: passed                           | 1.449 s  | 1.436 s  | 1.503 s  |
| tests/auth.test.ts                           | the global daily limit blocks email requests before creating challenges                                                                                                                       | unit: passed                           | 1.317 s  | 1.309 s  | 1.325 s  |
| tests/auth.test.ts                           | IP sending limits prevent cycling recipient addresses                                                                                                                                         | unit: passed                           | 1.207 s  | 1.192 s  | 1.213 s  |
| tests/preview/build.test.ts                  | the preview banner does not gate features or restrict accounts to preview hosts                                                                                                               | preview: passed                        | 0.968 s  | 0.968 s  | 0.995 s  |
| tests/auth.test.ts                           | event delivery retries use stable idempotency keys and atomic leases without exposing provider errors                                                                                         | unit: passed                           | 0.897 s  | 0.840 s  | 0.910 s  |
| tests/previews.test.ts                       | preview migrations match the shared binding and cannot target production                                                                                                                      | unit: passed                           | 0.891 s  | 0.878 s  | 0.937 s  |
| tests/ui/deployed-site.spec.ts               | deployed site uses real account features and shows a banner only on previews                                                                                                                  | ui-local: skipped, ui-deployed: passed | 0.891 s  | 0.885 s  | 0.950 s  |
| tests/auth.test.ts                           | local D1 event notifications never contact a provider, even with a real-shaped key                                                                                                            | unit: passed                           | 0.875 s  | 0.865 s  | 0.918 s  |
| tests/auth.test.ts                           | registration/editing persists all answers, keeps approval, and audits only changed field names                                                                                                | unit: passed                           | 0.870 s  | 0.857 s  | 0.907 s  |
| tests/auth.test.ts                           | three wrong codes invalidate both code and link                                                                                                                                               | unit: passed                           | 0.840 s  | 0.830 s  | 0.869 s  |
| tests/auth.test.ts                           | notifications share the sign-in sending budget and old pending mail is not blindly resent                                                                                                     | unit: passed                           | 0.760 s  | 0.757 s  | 0.803 s  |
| tests/auth.test.ts                           | real passwordless sign-in creates a verified volunteer and a host-only secure session                                                                                                         | unit: passed                           | 0.706 s  | 0.692 s  | 0.719 s  |
| tests/worker/organizer-notifications.test.ts | organizer emails require explicit opt-in in the built Worker › notify true applies to every organizer email                                                                                   | worker: passed                         | 0.698 s  | 0.639 s  | 0.767 s  |
| tests/auth.test.ts                           | email hourly limits still apply after the resend cooldown expires                                                                                                                             | unit: passed                           | 0.664 s  | 0.658 s  | 0.666 s  |
| tests/worker/organizer-notifications.test.ts | organizer emails require explicit opt-in in the built Worker › notify omitted applies to every organizer email                                                                                | worker: passed                         | 0.629 s  | 0.582 s  | 0.676 s  |
| tests/auth.test.ts                           | sign-out revokes the session rather than just removing the browser cookie                                                                                                                     | unit: passed                           | 0.624 s  | 0.612 s  | 0.663 s  |
| tests/d1.test.ts                             | Drizzle and capacity constraints work in the D1 runtime                                                                                                                                       | unit: passed                           | 0.622 s  | 0.606 s  | 0.631 s  |
| tests/auth.test.ts                           | requesting a new code invalidates the previous code                                                                                                                                           | unit: passed                           | 0.609 s  | 0.599 s  | 0.624 s  |
| tests/worker/organizer-notifications.test.ts | organizer emails require explicit opt-in in the built Worker › notify false applies to every organizer email                                                                                  | worker: passed                         | 0.608 s  | 0.580 s  | 0.630 s  |
| tests/auth.test.ts                           | link and code redemption race produces exactly one successful result                                                                                                                          | unit: passed                           | 0.586 s  | 0.585 s  | 0.622 s  |
| tests/worker/accounts.test.ts                | production-built Worker enforces authentication, ownership, CSRF and private-page protections › sign-in pages request no third-party scripts or frames                                        | worker: passed                         | 0.579 s  | 0.561 s  | 0.592 s  |
| tests/auth.test.ts                           | rate limits are atomic, persistent, and do not store raw email/IP keys                                                                                                                        | unit: passed                           | 0.571 s  | 0.571 s  | 0.577 s  |
| tests/auth.test.ts                           | the plugin stores hashed codes with ten-minute expiry                                                                                                                                         | unit: passed                           | 0.436 s  | 0.433 s  | 0.436 s  |
| tests/ui/deployed-site.spec.ts               | deployed sign-in is enabled with no third-party scripts or frames                                                                                                                             | ui-local: skipped, ui-deployed: passed | 0.413 s  | 0.397 s  | 0.413 s  |
| tests/auth.test.ts                           | email proofs are never returned in a public response, even by a capture service                                                                                                               | unit: passed                           | 0.412 s  | 0.388 s  | 0.417 s  |
| tests/ui/deployed-site.spec.ts               | account and organizer routes require sign-in without loading mockups                                                                                                                          | ui-local: skipped, ui-deployed: passed | 0.406 s  | 0.365 s  | 0.509 s  |
| tests/worker/accounts.test.ts                | a built Worker cannot enable account switching with local runtime vars                                                                                                                        | worker: passed                         | 0.395 s  | 0.384 s  | 0.419 s  |
| tests/preview-event-fixtures.test.ts         | preview seed refuses target overrides before running Wrangler                                                                                                                                 | unit: passed                           | 0.378 s  | 0.365 s  | 0.416 s  |
| tests/auth.test.ts                           | auth uses the configured site origin or request URL without trusting forwarded hosts                                                                                                          | unit: passed                           | 0.333 s  | 0.324 s  | 0.334 s  |
| tests/auth.test.ts                           | invalid email requests send no email and create no challenge                                                                                                                                  | unit: passed                           | 0.331 s  | 0.330 s  | 0.351 s  |
| tests/auth.test.ts                           | Resend receives the same sign-in message in every hosted environment and hides provider errors                                                                                                | unit: passed                           | 0.321 s  | 0.300 s  | 0.322 s  |
| tests/auth.test.ts                           | profile validation rejects privilege fields, invalid dates, absent/duplicate teams and oversized answers                                                                                      | unit: passed                           | 0.315 s  | 0.305 s  | 0.315 s  |
| tests/auth.test.ts                           | origins and redirect targets are checked; JSON bodies are bounded even without Content-Length                                                                                                 | unit: passed                           | 0.311 s  | 0.298 s  | 0.330 s  |
| tests/auth.test.ts                           | local email delivery never calls Resend, even with a configured key                                                                                                                           | unit: passed                           | 0.309 s  | 0.296 s  | 0.318 s  |
| tests/worker/events.test.ts                  | real event and organizer flows in the built Worker › volunteer signups and cancellations preserve records and audits without emails                                                           | worker: passed                         | 0.266 s  | 0.252 s  | 0.288 s  |
| tests/previews.test.ts                       | organizer bootstrap refuses implicit targets and production mode                                                                                                                              | unit: passed                           | 0.226 s  | 0.220 s  | 0.237 s  |
| tests/worker/events.test.ts                  | real event and organizer flows in the built Worker › organizer promotions require verified registration, not two-factor, and revoke sessions                                                  | worker: passed                         | 0.222 s  | 0.196 s  | 0.231 s  |
| tests/ui/deployed-site.spec.ts               | private pages exclude indexing and the database is available                                                                                                                                  | ui-local: skipped, ui-deployed: passed | 0.218 s  | 0.191 s  | 0.227 s  |
| tests/worker/accounts.test.ts                | production-built Worker enforces authentication, ownership, CSRF and private-page protections › session management lists only active owned sessions and revokes by ID without exposing tokens | worker: passed                         | 0.203 s  | 0.179 s  | 0.213 s  |
| tests/worker/events.test.ts                  | real event and organizer flows in the built Worker › bootstrap requires verified registration but not two-factor, is atomic and one-time                                                      | worker: passed                         | 0.190 s  | 0.162 s  | 0.196 s  |
| tests/worker/events.test.ts                  | real event and organizer flows in the built Worker › move rollback preserves source signup when destination is full                                                                           | worker: passed                         | 0.189 s  | 0.164 s  | 0.198 s  |
| tests/worker/events.test.ts                  | real event and organizer flows in the built Worker › capacity, optimistic edit conflicts, hidden and closed events are enforced                                                               | worker: passed                         | 0.186 s  | 0.172 s  | 0.190 s  |
| tests/worker/accounts.test.ts                | production-built Worker enforces authentication, ownership, CSRF and private-page protections › the Worker encrypts authenticator data and requires a second factor after email sign-in       | worker: passed                         | 0.181 s  | 0.179 s  | 0.201 s  |
| tests/worker/events.test.ts                  | real event and organizer flows in the built Worker › deactivation silently cancels future spots and last organizer cannot be removed                                                          | worker: passed                         | 0.141 s  | 0.139 s  | 0.155 s  |
| tests/worker/events.test.ts                  | real event and organizer flows in the built Worker › opted-in cancellation preserves records, cancels spots and queues notifications atomically                                               | worker: passed                         | 0.137 s  | 0.135 s  | 0.192 s  |
| tests/worker/events.test.ts                  | real event and organizer flows in the built Worker › orientation completion requires an actual past attendance and never approves patrols                                                     | worker: passed                         | 0.110 s  | 0.106 s  | 0.110 s  |
| tests/worker/events.test.ts                  | real event and organizer flows in the built Worker › organizers without two-factor can manage events and view audited profiles                                                                | worker: passed                         | 0.099 s  | 0.097 s  | 0.101 s  |
| tests/worker/events.test.ts                  | real event and organizer flows in the built Worker › approval without orientation grants patrol access, arbitrary client role does not                                                        | worker: passed                         | 0.080 s  | 0.074 s  | 0.084 s  |
| tests/worker/accounts.test.ts                | production-built Worker enforces authentication, ownership, CSRF and private-page protections › older sessions can edit their profile but must sign in again to list sessions                 | worker: passed                         | 0.078 s  | 0.077 s  | 0.082 s  |
| tests/worker/accounts.test.ts                | production-built Worker enforces authentication, ownership, CSRF and private-page protections › ending another person's session cannot revoke it                                              | worker: passed                         | 0.070 s  | 0.067 s  | 0.076 s  |
| tests/worker/events.test.ts                  | real event and organizer flows in the built Worker › last spot is atomic across simultaneous signups without queuing email                                                                    | worker: passed                         | 0.053 s  | 0.051 s  | 0.055 s  |
| tests/worker/accounts.test.ts                | production-built Worker enforces authentication, ownership, CSRF and private-page protections › unauthenticated profile access is rejected and registration redirects to sign-in              | worker: passed                         | 0.052 s  | 0.046 s  | 0.053 s  |
| tests/worker/events.test.ts                  | real event and organizer flows in the built Worker › visitors and volunteers cannot perform organizer actions; CSRF is rejected                                                               | worker: passed                         | 0.051 s  | 0.049 s  | 0.058 s  |
| tests/worker/accounts.test.ts                | production-built Worker enforces authentication, ownership, CSRF and private-page protections › sign-out removes the server-side session                                                      | worker: passed                         | 0.048 s  | 0.044 s  | 0.051 s  |
| tests/worker/accounts.test.ts                | production-built Worker enforces authentication, ownership, CSRF and private-page protections › registration and edits round-trip through the real API                                        | worker: passed                         | 0.047 s  | 0.045 s  | 0.065 s  |
| tests/worker/accounts.test.ts                | production-built Worker enforces authentication, ownership, CSRF and private-page protections › unconfigured email delivery fails closed and removes its code                                 | worker: passed                         | 0.040 s  | 0.034 s  | 0.040 s  |
| tests/worker/accounts.test.ts                | production-built Worker enforces authentication, ownership, CSRF and private-page protections › GET link pages do not consume codes or set session cookies                                    | worker: passed                         | 0.038 s  | 0.037 s  | 0.040 s  |
| tests/worker/accounts.test.ts                | production-built Worker enforces authentication, ownership, CSRF and private-page protections › site origins reject unrelated, preview and forwarded-host CSRF                                | worker: passed                         | 0.037 s  | 0.035 s  | 0.040 s  |
| tests/worker/events.test.ts                  | real event and organizer flows in the built Worker › new databases show a genuine empty event list, not sample fixtures                                                                       | worker: passed                         | 0.025 s  | 0.020 s  | 0.025 s  |
| tests/preview-event-fixtures.test.ts         | preview fixtures use the real schema without credentials, privileges, or queued email                                                                                                         | unit: passed                           | 0.019 s  | 0.018 s  | 0.019 s  |
| tests/local-event-fixtures.test.ts           | local fixtures restore open, full, hidden, and past events in the real schema                                                                                                                 | unit: passed                           | 0.018 s  | 0.018 s  | 0.018 s  |
| tests/worker/accounts.test.ts                | production-built Worker enforces authentication, ownership, CSRF and private-page protections › signed-out pages omit the signed-in account menu                                              | worker: passed                         | 0.016 s  | 0.015 s  | 0.018 s  |
| tests/worker/accounts.test.ts                | production-built Worker enforces authentication, ownership, CSRF and private-page protections › signed-in registration includes account navigation                                            | worker: passed                         | 0.015 s  | 0.013 s  | 0.016 s  |
| tests/event-time.test.ts                     | event calendar inputs always use Vancouver time                                                                                                                                               | unit: passed                           | 0.014 s  | 0.014 s  | 0.019 s  |
| tests/worker/events.test.ts                  | real event and organizer flows in the built Worker › real listings have no invented events, demo code or signed-out account menu                                                              | worker: passed                         | 0.013 s  | 0.013 s  | 0.016 s  |
| tests/worker/accounts.test.ts                | production-built Worker enforces authentication, ownership, CSRF and private-page protections › production assets contain no simulated sign-in or demo controls                               | worker: passed                         | 0.013 s  | 0.011 s  | 0.018 s  |
| tests/preview-event-fixtures.test.ts         | preview reseeding preserves existing accounts, fixture edits, and cancelled or ineligible signups                                                                                             | unit: passed                           | 0.010 s  | 0.010 s  | 0.011 s  |
| tests/preview-event-fixtures.test.ts         | preview reseeding does not rejoin a cancelled non-fixture signup                                                                                                                              | unit: passed                           | 0.009 s  | 0.006 s  | 0.009 s  |
| tests/preview-event-fixtures.test.ts         | preview fixture dates advance by Vancouver calendar days across daylight-saving changes                                                                                                       | unit: passed                           | 0.009 s  | 0.008 s  | 0.010 s  |
| tests/local-event-fixtures.test.ts           | rerunning the local seed preserves edits, cancellations, approvals, and unrelated data                                                                                                        | unit: passed                           | 0.008 s  | 0.008 s  | 0.009 s  |
| tests/database.test.ts                       | approval is independent of orientation completion                                                                                                                                             | unit: passed                           | 0.007 s  | 0.007 s  | 0.009 s  |
| tests/previews.test.ts                       | branch previews target the main Worker with non-production bindings, not version URLs                                                                                                         | unit: passed                           | 0.007 s  | 0.006 s  | 0.007 s  |
| tests/database.test.ts                       | only an organizer can be recorded as the approver                                                                                                                                             | unit: passed                           | 0.005 s  | 0.004 s  | 0.006 s  |
| tests/database.test.ts                       | last spot cannot be overbooked, including by reactivation or moving                                                                                                                           | unit: passed                           | 0.005 s  | 0.004 s  | 0.005 s  |
| tests/database.test.ts                       | emails are unique regardless of capitalization                                                                                                                                                | unit: passed                           | 0.005 s  | 0.004 s  | 0.005 s  |
| tests/database.test.ts                       | approval without any orientation allows patrol signup                                                                                                                                         | unit: passed                           | 0.005 s  | 0.004 s  | 0.006 s  |
| tests/database.test.ts                       | capacity cannot shrink below existing signups                                                                                                                                                 | unit: passed                           | 0.004 s  | 0.003 s  | 0.005 s  |
| tests/database.test.ts                       | inactive, unregistered, hidden and started events reject signups                                                                                                                              | unit: passed                           | 0.004 s  | 0.004 s  | 0.006 s  |
| tests/database.test.ts                       | duplicate confirmed signup is rejected, cancelled signup permits a new one                                                                                                                    | unit: passed                           | 0.004 s  | 0.004 s  | 0.006 s  |
| tests/database.test.ts                       | patrol cannot be recorded as an orientation completion                                                                                                                                        | unit: passed                           | 0.003 s  | 0.003 s  | 0.004 s  |
| tests/account-forms.test.ts                  | auth errors use the API message instead of Better Fetch's HTTP status                                                                                                                         | unit: passed                           | 0.002 s  | 0.001 s  | 0.002 s  |
| tests/event-policy.test.ts                   | approval allows patrol signup without orientation completion                                                                                                                                  | unit: passed                           | 0.001 s  | 0.001 s  | 0.002 s  |
| tests/previews.test.ts                       | the default environment does not use preview resources                                                                                                                                        | unit: passed                           | 0.001 s  | 0.001 s  | 0.001 s  |
| tests/previews.test.ts                       | deployment scripts explicitly select Worker Previews and their migration target                                                                                                               | unit: passed                           | 0.001 s  | 0.001 s  | 0.001 s  |
| tests/account-forms.test.ts                  | empty rate-limit and service errors have readable fallbacks                                                                                                                                   | unit: passed                           | 0.000 s  | 0.000 s  | 0.000 s  |
| tests/event-policy.test.ts                   | full, closed, started and invalid-date events reject signups                                                                                                                                  | unit: passed                           | 0.000 s  | 0.000 s  | 0.000 s  |
| tests/event-policy.test.ts                   | patrols require explicit approval                                                                                                                                                             | unit: passed                           | 0.000 s  | 0.000 s  | 0.000 s  |
| tests/previews.test.ts                       | Astro disables all remote bindings in development                                                                                                                                             | unit: passed                           | 0.000 s  | 0.000 s  | 0.000 s  |
| tests/event-policy.test.ts                   | organizer profile access requires two-factor only when enabled                                                                                                                                | unit: passed                           | 0.000 s  | 0.000 s  | 0.000 s  |
| tests/event-policy.test.ts                   | sign-in, registration and active status are required                                                                                                                                          | unit: passed                           | 0.000 s  | 0.000 s  | 0.000 s  |
| tests/event-policy.test.ts                   | unapproved volunteers can sign up for orientations                                                                                                                                            | unit: passed                           | 0.000 s  | 0.000 s  | 0.000 s  |

## Failures

Failure timings include assertion timeouts and may stop before completing the workflow. They are diagnostic measurements, not normal passing-flow costs. No failures were discarded from the samples or reclassified as skipped tests.

- ui-local, run 1: exit 1.
- ui-local, run 2: exit 1.
- ui-local, run 3: exit 1.
- Warm-up failed in ui-local; see raw logs.

- `tests/ui/local-accounts.spec.ts`: local D1 sign-in uses dialogs for delivery, errors and valid codes (failed). Failing locator: `getByRole('complementary', { name: 'Development account controls' })`.
- `tests/ui/local-accounts.spec.ts`: local D1 email links are one-use and sign-in pages have no third-party requests (failed). Failing locator: `getByRole('complementary', { name: 'Development account controls' })`.
- `tests/ui/volunteer.spec.ts`: View as lists actual D1 users and switching to Visitor ends only the current session (failed). Failing locator: `getByLabel('View as', { exact: true })`.
- `tests/ui/volunteer.spec.ts`: View as can choose an unregistered D1 account without changing it (failed). Failing locator: `getByLabel('View as', { exact: true })`.
- `tests/ui/volunteer.spec.ts`: account edits persist in D1 and use the shared UI at 1280px (failed). Failing locator: `getByLabel('View as', { exact: true })`.
- `tests/ui/volunteer.spec.ts`: account edits persist in D1 and use the shared UI at 375px (failed). Failing locator: `getByLabel('View as', { exact: true })`.
- `tests/ui/volunteer.spec.ts`: local account selection rejects cross-origin writes and unknown users (failed). Failing locator: `getByLabel('View as', { exact: true })`.
- `tests/ui/volunteer.spec.ts`: View as simulates a verified factor without changing the user's real role or enrollment (failed). Failing locator: `getByLabel('View as', { exact: true })`.

## Raw data

Structured measurements: `docs/benchmarks/test-baseline.json`. Raw runner JSON and command logs: `test-results/benchmarks/2026-10-07T20-07-59-494Z` (ignored by Git). The structured snapshot stores each measured run and every test name/duration; keep it with this report for future comparisons.
