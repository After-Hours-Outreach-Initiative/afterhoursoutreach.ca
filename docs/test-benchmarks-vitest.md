# Vitest migration benchmark

Measured 2026-10-07T23:05:32.588Z on `chore/test-benchmark-baseline` at `45a0471cce095bf806edcc374527134592184de3`.

**Valid baseline: all measured runs and warm-ups passed.**

## What changed

- Migrated all non-browser tests from Node's built-in runner to Vitest 4.1.11.
- Auth and D1 source-level tests now execute inside `workerd` with
  `@cloudflare/vitest-plugin` 1.3.1, a test-only local D1 binding, and the actual
  SQL migrations. Storage is reset between cases without creating a new
  Miniflare instance for every auth test.
- Kept the built production/preview Worker checks in Node-hosted Vitest
  projects, including their embedded Playwright flows. The separate local and
  deployed browser suites remain on Playwright.
- Converted three parent tests to fixture suites. Vitest counts their leaf
  cases, not the suites as three additional tests. The event fixture's
  `with scheduled events` suite changes descendant names without removing
  assertions.
- Added five behavioral regression tests for benchmark parsing/reporting.
- Included the preceding development-tool separation: development modules live
  in `src/dev/` behind build-time guards, and deployed endpoint/session behavior
  replaces asset filename checks. Production browser checks also reject
  development controls. No deployment was performed for this measurement.

## Comparison with the previous passing snapshot

| Measure                                           | Simplified Node suite | Vitest suite | Change                                 |
| ------------------------------------------------- | --------------------- | ------------ | -------------------------------------- |
| Distinct leaf cases                               | 111                   | 116          | +5 benchmark regression cases          |
| Parent tests counted separately                   | 3                     | 0            | Converted to suites, not lost coverage |
| `pnpm test` median wall                           | 18.788 s              | 8.007 s      | -57.4%                                 |
| Production Worker tests median wall               | 14.379 s              | 14.484 s     | +0.7%                                  |
| Preview Worker tests median wall                  | 3.276 s               | 3.776 s      | +15.3%                                 |
| All measured phases median wall, including builds | 60.210 s              | 49.108 s     | -18.4%                                 |

These compare against `docs/benchmarks/test-simplified.json`. The largest
improvement is in the source-level auth/D1 phase; changing runners did not make
every phase faster. This is an end-to-end migration comparison, including
runtime dependency and fixture-lifecycle changes plus the preceding
development-tool changes, not a controlled experiment of runner overhead alone.

The original snapshot's total was **71.135 s**, versus **49.108 s** now
(-31.0%), but it had eight stale local UI failures and assertion timeouts. That
comparison includes the earlier test cleanup, so it cannot measure the Vitest
migration alone. Both historical Markdown reports and JSON snapshots remain
unchanged. The detailed original-baseline comparison below includes renamed
and regrouped cases in its added/removed-name lists.

## Measurement summary

- 116 distinct registered tests across 21 test files; 116 executed in at least one profile.
- 116 leaf cases and 0 legacy parent/container tests. Vitest describes are suites, not extra test cases; historical Node parent timings include their children.
- 1 untimed warm-up round(s), then 3 measured rounds. Suites run sequentially; each test runner retains its normal parallelism.
- Local browser data: a temporary copy of the current working tree, a fresh local D1 database and synthetic fixtures; no developer server/database/secrets reused. State is reused across rounds, so test-created accounts accumulate.
- One-off development-server/database setup: 14.104 s; excluded from measured suite times. Builds, runner startup and browser startup are included in their respective wall times.
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
| vitest                               | 4.1.11                             |
| @cloudflare/vitest-plugin            | 1.3.1                              |
| Chromium                             | Chromium 151.0.7922.173 Arch Linux |
| Playwright configured workers        | 8                                  |

Working-tree changes at the start (the snapshot includes these changes, not just HEAD):

```text
M README.md
 M docs/accounts.md
 M docs/deployment.md
 M package.json
 M pnpm-lock.yaml
 M scripts/benchmark-tests.mjs
 M scripts/test-benchmark-report.mjs
 D scripts/test-benchmark-reporter.mjs
 D src/scripts/account-switcher.ts
 M src/scripts/account.ts
 D src/scripts/local-email-dialog.ts
 M src/scripts/volunteer.ts
 D src/server/auth/development.ts
 M src/server/auth/index.ts
 D src/styles/local-email-dialog.css
 M tests/account-forms.test.ts
 M tests/auth.test.ts
 M tests/d1.test.ts
 M tests/database.test.ts
 M tests/event-policy.test.ts
 M tests/event-time.test.ts
 M tests/local-event-fixtures.test.ts
 M tests/preview-event-fixtures.test.ts
 M tests/preview/build.test.ts
 M tests/previews.test.ts
 M tests/worker/accounts.test.ts
 M tests/worker/action-refresh.test.ts
 M tests/worker/events.test.ts
 M tests/worker/organizer-notifications.test.ts
?? docs/testing.md
?? src/dev/
?? tests/helpers/runtime-setup.ts
?? tests/test-benchmark.test.ts
?? tests/vitest.d.ts
?? vitest.config.ts
```

## Suite and build benchmarks

| Phase                                  | Files | Tests | Passed | Failed | Skipped | Median wall | Min      | Max      |
| -------------------------------------- | ----- | ----- | ------ | ------ | ------- | ----------- | -------- | -------- |
| Vitest unit / Cloudflare runtime tests | 10    | 60    | 60     | 0      | 0       | 8.007 s     | 7.728 s  | 8.134 s  |
| Production build                       | —     | —     | —      | —      | —       | 4.923 s     | 4.866 s  | 5.228 s  |
| Production Worker tests                | 4     | 35    | 35     | 0      | 0       | 14.484 s    | 14.407 s | 14.620 s |
| Preview build                          | —     | —     | —      | —      | —       | 4.883 s     | 4.834 s  | 5.072 s  |
| Preview Worker tests                   | 1     | 1     | 1      | 0      | 0       | 3.776 s     | 3.766 s  | 3.865 s  |
| Local browser tests                    | 6     | 20    | 16     | 0      | 4       | 10.167 s    | 10.161 s | 10.278 s |
| Deployed browser smoke tests           | 1     | 4     | 4      | 0      | 0       | 2.632 s     | 2.631 s  | 2.688 s  |

Counts above are per round, not multiplied by the number of repetitions. Local UI includes the deployed tests as skips; the deployed profile executes those same cases. Do not add profile counts to get the distinct total.

### Package-command equivalents

| Command/profile                 | Median wall including builds | Min      | Max      |
| ------------------------------- | ---------------------------- | -------- | -------- |
| pnpm test                       | 8.007 s                      | 7.728 s  | 8.134 s  |
| pnpm test:accounts              | 19.543 s                     | 19.272 s | 19.712 s |
| pnpm test:preview               | 8.699 s                      | 8.648 s  | 8.848 s  |
| pnpm test:ui (localhost)        | 10.167 s                     | 10.161 s | 10.278 s |
| Deployed smoke tests only       | 2.632 s                      | 2.631 s  | 2.688 s  |
| All measured phases, sequential | 49.108 s                     | 48.555 s | 49.486 s |

Build and test commands are launched separately so their costs are visible. The combined figures are the sum for each measured round, including both command launches; they are not measurements of one shell invocation of the package script. Vitest phases select the same projects as the package scripts. The unit phase includes Node utility tests and source-level tests inside Cloudflare's runtime. Built Worker tests remain in Node-hosted Vitest projects to exercise the actual production/preview artifacts. Empty groups are recorded as zero tests without launching a runner.

## Per-file benchmarks

Vitest JSON reports each file's elapsed span from its first leaf case to its last, including intervening hooks but excluding outer beforeAll/afterAll and collection. Historical Node snapshots use summed top-level durations, including setup inside parent tests; Playwright uses summed case durations. These measures are not directly equivalent. Full fixture, runner and browser costs are captured by phase wall times.

| Profile     | File                                         | Tests | Leaf cases | Median file/test time | Min      | Max      |
| ----------- | -------------------------------------------- | ----- | ---------- | --------------------- | -------- | -------- |
| unit        | tests/account-forms.test.ts                  | 2     | 2          | 0.002 s               | 0.002 s  | 0.003 s  |
| unit        | tests/auth.test.ts                           | 23    | 23         | 0.866 s               | 0.833 s  | 0.896 s  |
| unit        | tests/d1.test.ts                             | 1     | 1          | 0.035 s               | 0.030 s  | 0.067 s  |
| unit        | tests/database.test.ts                       | 9     | 9          | 0.049 s               | 0.035 s  | 0.051 s  |
| unit        | tests/event-policy.test.ts                   | 6     | 6          | 0.003 s               | 0.002 s  | 0.003 s  |
| unit        | tests/event-time.test.ts                     | 1     | 1          | 0.017 s               | 0.012 s  | 0.020 s  |
| unit        | tests/local-event-fixtures.test.ts           | 3     | 3          | 5.508 s               | 5.436 s  | 5.642 s  |
| unit        | tests/preview-event-fixtures.test.ts         | 5     | 5          | 0.394 s               | 0.390 s  | 0.440 s  |
| unit        | tests/previews.test.ts                       | 5     | 5          | 1.141 s               | 1.135 s  | 1.160 s  |
| unit        | tests/test-benchmark.test.ts                 | 5     | 5          | 0.007 s               | 0.006 s  | 0.009 s  |
| worker      | tests/worker/accounts.test.ts                | 15    | 15         | 8.302 s               | 7.286 s  | 8.443 s  |
| worker      | tests/worker/action-refresh.test.ts          | 2     | 2          | 3.322 s               | 3.260 s  | 3.384 s  |
| worker      | tests/worker/events.test.ts                  | 15    | 15         | 9.445 s               | 9.349 s  | 9.470 s  |
| worker      | tests/worker/organizer-notifications.test.ts | 3     | 3          | 1.738 s               | 1.735 s  | 1.793 s  |
| preview     | tests/preview/build.test.ts                  | 1     | 1          | 0.879 s               | 0.878 s  | 0.882 s  |
| ui-local    | tests/ui/account-forms.spec.ts               | 5     | 5          | 21.303 s              | 20.770 s | 21.599 s |
| ui-local    | tests/ui/deployed-site.spec.ts               | 4     | 4          | 0.011 s               | 0.010 s  | 0.015 s  |
| ui-local    | tests/ui/local-accounts.spec.ts              | 2     | 2          | 10.045 s              | 8.883 s  | 10.228 s |
| ui-local    | tests/ui/local-notifications.spec.ts         | 1     | 1          | 3.966 s               | 3.601 s  | 4.293 s  |
| ui-local    | tests/ui/notification-choice.spec.ts         | 1     | 1          | 2.599 s               | 2.573 s  | 3.102 s  |
| ui-local    | tests/ui/volunteer.spec.ts                   | 7     | 7          | 17.908 s              | 17.073 s | 18.101 s |
| ui-deployed | tests/ui/deployed-site.spec.ts               | 4     | 4          | 1.702 s               | 1.680 s  | 1.718 s  |

## Complete test inventory and timings

Sorted by median measured case duration, slowest first. Skipped profiles are excluded from case timing statistics. Legacy containers are marked; removing a child affects its parent's inclusive duration too. Vitest case timings exclude suite-level fixture hooks. Identities use file and full test name, not line numbers, so deleting earlier tests does not make unchanged tests appear renamed.

| File                                         | Test                                                                                                                                                                                          | Profiles/status                        | Median  | Min     | Max     |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | ------- | ------- | ------- |
| tests/worker/events.test.ts                  | real event and organizer flows in the built Worker › with scheduled events › browser organizer and volunteer workflows save in place and remain usable on mobile                              | worker: passed                         | 7.782 s | 7.690 s | 7.803 s |
| tests/worker/accounts.test.ts                | production-built Worker enforces authentication, ownership, CSRF and private-page protections › browser edits persisted profile answers without browser storage or third-party requests       | worker: passed                         | 6.671 s | 5.635 s | 6.762 s |
| tests/ui/account-forms.spec.ts               | registration shows all required errors and saves after they are corrected                                                                                                                     | ui-local: passed                       | 6.399 s | 6.233 s | 6.411 s |
| tests/ui/account-forms.spec.ts               | authenticator setup and sign-in show inline required and code errors                                                                                                                          | ui-local: passed                       | 6.238 s | 6.166 s | 6.534 s |
| tests/local-event-fixtures.test.ts           | the local seed refuses remote, preview, and production arguments before any writes                                                                                                            | unit: passed                           | 5.483 s | 5.410 s | 5.615 s |
| tests/ui/local-accounts.spec.ts              | local D1 sign-in uses dialogs for delivery, errors and valid codes                                                                                                                            | ui-local: passed                       | 5.226 s | 4.585 s | 5.489 s |
| tests/ui/local-accounts.spec.ts              | local D1 email links are one-use and sign-in pages have no third-party requests                                                                                                               | ui-local: passed                       | 4.556 s | 4.298 s | 5.002 s |
| tests/ui/local-notifications.spec.ts         | local approval notifications work without crypto.randomUUID                                                                                                                                   | ui-local: passed                       | 3.966 s | 3.601 s | 4.293 s |
| tests/ui/volunteer.spec.ts                   | View as lists actual D1 users and switching to Visitor ends only the current session                                                                                                          | ui-local: passed                       | 3.497 s | 3.226 s | 3.922 s |
| tests/ui/volunteer.spec.ts                   | account navigation and profile controls are usable on desktop and mobile                                                                                                                      | ui-local: passed                       | 3.398 s | 3.232 s | 3.489 s |
| tests/ui/account-forms.spec.ts               | email sign-in validates, loads, switches to code, and resets                                                                                                                                  | ui-local: passed                       | 3.390 s | 3.271 s | 3.502 s |
| tests/ui/account-forms.spec.ts               | real email cooldowns and empty HTTP 429 responses are readable and retryable                                                                                                                  | ui-local: passed                       | 3.357 s | 2.555 s | 3.363 s |
| tests/ui/volunteer.spec.ts                   | View as can choose an unregistered D1 account without changing it                                                                                                                             | ui-local: passed                       | 2.636 s | 2.304 s | 2.680 s |
| tests/ui/notification-choice.spec.ts         | organizer email choice defaults to no email and cancellation restores controls                                                                                                                | ui-local: passed                       | 2.599 s | 2.573 s | 3.102 s |
| tests/ui/volunteer.spec.ts                   | local account selection rejects cross-origin writes and unknown users                                                                                                                         | ui-local: passed                       | 2.347 s | 2.189 s | 2.573 s |
| tests/ui/volunteer.spec.ts                   | View as simulates a verified factor without changing the user's real role or enrollment                                                                                                       | ui-local: passed                       | 2.339 s | 2.323 s | 2.612 s |
| tests/ui/account-forms.spec.ts               | private pages make no third-party requests and remain usable on mobile                                                                                                                        | ui-local: passed                       | 2.169 s | 1.907 s | 2.177 s |
| tests/ui/volunteer.spec.ts                   | event type buttons filter instantly, preserve deep links, and never submit a confirmation form                                                                                                | ui-local: passed                       | 1.881 s | 1.873 s | 2.136 s |
| tests/worker/action-refresh.test.ts          | overlapping signup refreshes stay ordered                                                                                                                                                     | worker: passed                         | 1.719 s | 1.690 s | 1.748 s |
| tests/worker/action-refresh.test.ts          | overlapping signup refreshes stay ordered after a failed refresh                                                                                                                              | worker: passed                         | 1.574 s | 1.569 s | 1.665 s |
| tests/ui/volunteer.spec.ts                   | volunteer-page sign-in is usable on mobile and opens the shared code form                                                                                                                     | ui-local: passed                       | 1.473 s | 1.429 s | 1.523 s |
| tests/previews.test.ts                       | preview migrations match the shared binding and cannot target production                                                                                                                      | unit: passed                           | 0.904 s | 0.895 s | 0.925 s |
| tests/preview/build.test.ts                  | preview builds support real account features but reject development endpoints                                                                                                                 | preview: passed                        | 0.879 s | 0.878 s | 0.882 s |
| tests/ui/deployed-site.spec.ts               | deployed site uses real account features and shows a banner only on previews                                                                                                                  | ui-local: skipped, ui-deployed: passed | 0.845 s | 0.838 s | 0.867 s |
| tests/worker/organizer-notifications.test.ts | organizer emails require explicit opt-in in the built Worker › notify true applies to every organizer email                                                                                   | worker: passed                         | 0.640 s | 0.626 s | 0.641 s |
| tests/worker/organizer-notifications.test.ts | organizer emails require explicit opt-in in the built Worker › notify omitted applies to every organizer email                                                                                | worker: passed                         | 0.554 s | 0.542 s | 0.565 s |
| tests/worker/organizer-notifications.test.ts | organizer emails require explicit opt-in in the built Worker › notify false applies to every organizer email                                                                                  | worker: passed                         | 0.551 s | 0.547 s | 0.599 s |
| tests/worker/accounts.test.ts                | production-built Worker enforces authentication, ownership, CSRF and private-page protections › sign-in pages request no third-party scripts or frames                                        | worker: passed                         | 0.536 s | 0.532 s | 0.555 s |
| tests/worker/accounts.test.ts                | a built Worker cannot enable account switching with local runtime vars                                                                                                                        | worker: passed                         | 0.380 s | 0.369 s | 0.381 s |
| tests/ui/deployed-site.spec.ts               | deployed sign-in is enabled with no third-party scripts or frames                                                                                                                             | ui-local: skipped, ui-deployed: passed | 0.380 s | 0.373 s | 0.391 s |
| tests/preview-event-fixtures.test.ts         | preview seed refuses target overrides before running Wrangler                                                                                                                                 | unit: passed                           | 0.346 s | 0.343 s | 0.395 s |
| tests/ui/deployed-site.spec.ts               | account and organizer routes require sign-in without loading mockups                                                                                                                          | ui-local: skipped, ui-deployed: passed | 0.277 s | 0.271 s | 0.298 s |
| tests/worker/events.test.ts                  | real event and organizer flows in the built Worker › with scheduled events › volunteer signups and cancellations preserve records and audits without emails                                   | worker: passed                         | 0.222 s | 0.220 s | 0.237 s |
| tests/previews.test.ts                       | organizer bootstrap refuses implicit targets and production mode                                                                                                                              | unit: passed                           | 0.220 s | 0.217 s | 0.230 s |
| tests/worker/events.test.ts                  | real event and organizer flows in the built Worker › with scheduled events › organizer promotions require verified registration, not two-factor, and revoke sessions                          | worker: passed                         | 0.205 s | 0.201 s | 0.213 s |
| tests/ui/deployed-site.spec.ts               | private pages exclude indexing and the database is available                                                                                                                                  | ui-local: skipped, ui-deployed: passed | 0.184 s | 0.183 s | 0.193 s |
| tests/worker/accounts.test.ts                | production-built Worker enforces authentication, ownership, CSRF and private-page protections › session management lists only active owned sessions and revokes by ID without exposing tokens | worker: passed                         | 0.177 s | 0.176 s | 0.178 s |
| tests/worker/events.test.ts                  | real event and organizer flows in the built Worker › with scheduled events › capacity, optimistic edit conflicts, hidden and closed events are enforced                                       | worker: passed                         | 0.174 s | 0.171 s | 0.180 s |
| tests/worker/accounts.test.ts                | production-built Worker enforces authentication, ownership, CSRF and private-page protections › the Worker encrypts authenticator data and requires a second factor after email sign-in       | worker: passed                         | 0.165 s | 0.154 s | 0.176 s |
| tests/worker/events.test.ts                  | real event and organizer flows in the built Worker › bootstrap requires verified registration but not two-factor, is atomic and one-time                                                      | worker: passed                         | 0.165 s | 0.155 s | 0.169 s |
| tests/worker/events.test.ts                  | real event and organizer flows in the built Worker › with scheduled events › move rollback preserves source signup when destination is full                                                   | worker: passed                         | 0.158 s | 0.154 s | 0.183 s |
| tests/worker/events.test.ts                  | real event and organizer flows in the built Worker › with scheduled events › opted-in cancellation preserves records, cancels spots and queues notifications atomically                       | worker: passed                         | 0.140 s | 0.129 s | 0.151 s |
| tests/worker/events.test.ts                  | real event and organizer flows in the built Worker › with scheduled events › deactivation silently cancels future spots and last organizer cannot be removed                                  | worker: passed                         | 0.128 s | 0.123 s | 0.129 s |
| tests/worker/events.test.ts                  | real event and organizer flows in the built Worker › with scheduled events › orientation completion requires an actual past attendance and never approves patrols                             | worker: passed                         | 0.097 s | 0.094 s | 0.105 s |
| tests/auth.test.ts                           | the per-address verification budget survives code rotation                                                                                                                                    | unit: passed                           | 0.095 s | 0.084 s | 0.107 s |
| tests/worker/events.test.ts                  | real event and organizer flows in the built Worker › with scheduled events › organizers without two-factor can manage events and view audited profiles                                        | worker: passed                         | 0.088 s | 0.078 s | 0.109 s |
| tests/auth.test.ts                           | passwordless two-factor enrollment and login cannot bypass the authenticator                                                                                                                  | unit: passed                           | 0.086 s | 0.079 s | 0.088 s |
| tests/worker/accounts.test.ts                | production-built Worker enforces authentication, ownership, CSRF and private-page protections › ending another person's session cannot revoke it                                              | worker: passed                         | 0.071 s | 0.069 s | 0.085 s |
| tests/worker/events.test.ts                  | real event and organizer flows in the built Worker › with scheduled events › approval without orientation grants patrol access, arbitrary client role does not                                | worker: passed                         | 0.068 s | 0.068 s | 0.075 s |
| tests/worker/accounts.test.ts                | production-built Worker enforces authentication, ownership, CSRF and private-page protections › older sessions can edit their profile but must sign in again to list sessions                 | worker: passed                         | 0.064 s | 0.059 s | 0.066 s |
| tests/auth.test.ts                           | local D1 event notifications never contact a provider, even with a real-shaped key                                                                                                            | unit: passed                           | 0.062 s | 0.060 s | 0.066 s |
| tests/auth.test.ts                           | IP sending limits prevent cycling recipient addresses                                                                                                                                         | unit: passed                           | 0.057 s | 0.051 s | 0.060 s |
| tests/auth.test.ts                           | registration/editing persists all answers, keeps approval, and audits only changed field names                                                                                                | unit: passed                           | 0.057 s | 0.043 s | 0.064 s |
| tests/auth.test.ts                           | the global daily limit blocks email requests before creating challenges                                                                                                                       | unit: passed                           | 0.054 s | 0.050 s | 0.068 s |
| tests/worker/events.test.ts                  | real event and organizer flows in the built Worker › visitors and volunteers cannot perform organizer actions; CSRF is rejected                                                               | worker: passed                         | 0.051 s | 0.048 s | 0.057 s |
| tests/worker/events.test.ts                  | real event and organizer flows in the built Worker › with scheduled events › last spot is atomic across simultaneous signups without queuing email                                            | worker: passed                         | 0.045 s | 0.043 s | 0.056 s |
| tests/auth.test.ts                           | event delivery retries use stable idempotency keys and atomic leases without exposing provider errors                                                                                         | unit: passed                           | 0.042 s | 0.037 s | 0.057 s |
| tests/worker/accounts.test.ts                | production-built Worker enforces authentication, ownership, CSRF and private-page protections › sign-out removes the server-side session                                                      | worker: passed                         | 0.041 s | 0.039 s | 0.051 s |
| tests/worker/accounts.test.ts                | production-built Worker enforces authentication, ownership, CSRF and private-page protections › registration and edits round-trip through the real API                                        | worker: passed                         | 0.040 s | 0.038 s | 0.069 s |
| tests/auth.test.ts                           | real passwordless sign-in creates a verified volunteer and a host-only secure session                                                                                                         | unit: passed                           | 0.038 s | 0.038 s | 0.046 s |
| tests/auth.test.ts                           | three wrong codes invalidate both code and link                                                                                                                                               | unit: passed                           | 0.038 s | 0.037 s | 0.038 s |
| tests/worker/accounts.test.ts                | production-built Worker enforces authentication, ownership, CSRF and private-page protections › GET link pages do not consume codes or set session cookies                                    | worker: passed                         | 0.036 s | 0.033 s | 0.038 s |
| tests/auth.test.ts                           | notifications share the sign-in sending budget and old pending mail is not blindly resent                                                                                                     | unit: passed                           | 0.036 s | 0.035 s | 0.050 s |
| tests/auth.test.ts                           | link and code redemption race produces exactly one successful result                                                                                                                          | unit: passed                           | 0.036 s | 0.032 s | 0.047 s |
| tests/d1.test.ts                             | Drizzle and capacity constraints work in the D1 runtime                                                                                                                                       | unit: passed                           | 0.035 s | 0.030 s | 0.067 s |
| tests/worker/accounts.test.ts                | production-built Worker enforces authentication, ownership, CSRF and private-page protections › unconfigured email delivery fails closed and removes its code                                 | worker: passed                         | 0.031 s | 0.031 s | 0.044 s |
| tests/auth.test.ts                           | email hourly limits still apply after the resend cooldown expires                                                                                                                             | unit: passed                           | 0.028 s | 0.026 s | 0.043 s |
| tests/auth.test.ts                           | sign-out revokes the session rather than just removing the browser cookie                                                                                                                     | unit: passed                           | 0.028 s | 0.026 s | 0.042 s |
| tests/auth.test.ts                           | requesting a new code invalidates the previous code                                                                                                                                           | unit: passed                           | 0.027 s | 0.026 s | 0.041 s |
| tests/worker/accounts.test.ts                | production-built Worker enforces authentication, ownership, CSRF and private-page protections › production builds reject development account endpoints without changing sessions              | worker: passed                         | 0.024 s | 0.022 s | 0.026 s |
| tests/auth.test.ts                           | rate limits are atomic, persistent, and do not store raw email/IP keys                                                                                                                        | unit: passed                           | 0.024 s | 0.024 s | 0.031 s |
| tests/worker/accounts.test.ts                | production-built Worker enforces authentication, ownership, CSRF and private-page protections › unauthenticated profile access is rejected and registration redirects to sign-in              | worker: passed                         | 0.024 s | 0.024 s | 0.026 s |
| tests/auth.test.ts                           | invalid email requests send no email and create no challenge                                                                                                                                  | unit: passed                           | 0.021 s | 0.017 s | 0.037 s |
| tests/auth.test.ts                           | the plugin stores hashed codes with ten-minute expiry                                                                                                                                         | unit: passed                           | 0.019 s | 0.018 s | 0.019 s |
| tests/auth.test.ts                           | email proofs are never returned in a public response, even by a capture service                                                                                                               | unit: passed                           | 0.019 s | 0.015 s | 0.023 s |
| tests/preview-event-fixtures.test.ts         | preview fixtures use the real schema without credentials, privileges, or queued email                                                                                                         | unit: passed                           | 0.018 s | 0.017 s | 0.021 s |
| tests/local-event-fixtures.test.ts           | local fixtures restore open, full, hidden, and past events in the real schema                                                                                                                 | unit: passed                           | 0.018 s | 0.016 s | 0.018 s |
| tests/worker/events.test.ts                  | real event and organizer flows in the built Worker › new databases show a genuine empty event list, not sample fixtures                                                                       | worker: passed                         | 0.017 s | 0.017 s | 0.026 s |
| tests/event-time.test.ts                     | event calendar inputs always use Vancouver time                                                                                                                                               | unit: passed                           | 0.017 s | 0.012 s | 0.020 s |
| tests/worker/accounts.test.ts                | production-built Worker enforces authentication, ownership, CSRF and private-page protections › signed-out pages omit the signed-in account menu                                              | worker: passed                         | 0.015 s | 0.011 s | 0.019 s |
| tests/worker/events.test.ts                  | real event and organizer flows in the built Worker › with scheduled events › real listings have no invented events, demo code or signed-out account menu                                      | worker: passed                         | 0.013 s | 0.011 s | 0.016 s |
| tests/auth.test.ts                           | profile validation rejects privilege fields, invalid dates, absent/duplicate teams and oversized answers                                                                                      | unit: passed                           | 0.013 s | 0.012 s | 0.017 s |
| tests/auth.test.ts                           | Resend receives the same sign-in message in every hosted environment and hides provider errors                                                                                                | unit: passed                           | 0.013 s | 0.011 s | 0.019 s |
| tests/worker/accounts.test.ts                | production-built Worker enforces authentication, ownership, CSRF and private-page protections › site origins reject unrelated, preview and forwarded-host CSRF                                | worker: passed                         | 0.012 s | 0.010 s | 0.012 s |
| tests/auth.test.ts                           | auth uses the configured site origin or request URL without trusting forwarded hosts                                                                                                          | unit: passed                           | 0.012 s | 0.012 s | 0.015 s |
| tests/auth.test.ts                           | origins and redirect targets are checked; JSON bodies are bounded even without Content-Length                                                                                                 | unit: passed                           | 0.012 s | 0.012 s | 0.012 s |
| tests/preview-event-fixtures.test.ts         | preview fixture dates advance by Vancouver calendar days across daylight-saving changes                                                                                                       | unit: passed                           | 0.011 s | 0.010 s | 0.012 s |
| tests/auth.test.ts                           | local email delivery never calls Resend, even with a configured key                                                                                                                           | unit: passed                           | 0.011 s | 0.010 s | 0.017 s |
| tests/preview-event-fixtures.test.ts         | preview reseeding preserves existing accounts, fixture edits, and cancelled or ineligible signups                                                                                             | unit: passed                           | 0.009 s | 0.009 s | 0.011 s |
| tests/previews.test.ts                       | branch previews target the main Worker with non-production bindings, not version URLs                                                                                                         | unit: passed                           | 0.008 s | 0.007 s | 0.009 s |
| tests/local-event-fixtures.test.ts           | rerunning the local seed preserves edits, cancellations, approvals, and unrelated data                                                                                                        | unit: passed                           | 0.008 s | 0.007 s | 0.009 s |
| tests/preview-event-fixtures.test.ts         | preview reseeding does not rejoin a cancelled non-fixture signup                                                                                                                              | unit: passed                           | 0.007 s | 0.007 s | 0.008 s |
| tests/database.test.ts                       | approval is independent of orientation completion                                                                                                                                             | unit: passed                           | 0.006 s | 0.006 s | 0.009 s |
| tests/database.test.ts                       | last spot cannot be overbooked, including by reactivation or moving                                                                                                                           | unit: passed                           | 0.006 s | 0.004 s | 0.006 s |
| tests/database.test.ts                       | duplicate confirmed signup is rejected, cancelled signup permits a new one                                                                                                                    | unit: passed                           | 0.005 s | 0.004 s | 0.006 s |
| tests/database.test.ts                       | inactive, unregistered, hidden and started events reject signups                                                                                                                              | unit: passed                           | 0.005 s | 0.004 s | 0.006 s |
| tests/database.test.ts                       | capacity cannot shrink below existing signups                                                                                                                                                 | unit: passed                           | 0.005 s | 0.004 s | 0.005 s |
| tests/database.test.ts                       | emails are unique regardless of capitalization                                                                                                                                                | unit: passed                           | 0.005 s | 0.003 s | 0.006 s |
| tests/database.test.ts                       | approval without any orientation allows patrol signup                                                                                                                                         | unit: passed                           | 0.005 s | 0.003 s | 0.006 s |
| tests/database.test.ts                       | only an organizer can be recorded as the approver                                                                                                                                             | unit: passed                           | 0.004 s | 0.003 s | 0.005 s |
| tests/database.test.ts                       | patrol cannot be recorded as an orientation completion                                                                                                                                        | unit: passed                           | 0.004 s | 0.003 s | 0.006 s |
| tests/test-benchmark.test.ts                 | Vitest benchmark results count leaf cases, skips, todos and failures                                                                                                                          | unit: passed                           | 0.004 s | 0.003 s | 0.004 s |
| tests/event-policy.test.ts                   | approval allows patrol signup without orientation completion                                                                                                                                  | unit: passed                           | 0.002 s | 0.001 s | 0.002 s |
| tests/account-forms.test.ts                  | auth errors use the API message instead of Better Fetch's HTTP status                                                                                                                         | unit: passed                           | 0.002 s | 0.002 s | 0.002 s |
| tests/test-benchmark.test.ts                 | benchmark comparisons distinguish retired Node containers from lost leaf coverage                                                                                                             | unit: passed                           | 0.001 s | 0.001 s | 0.002 s |
| tests/previews.test.ts                       | the default environment does not use preview resources                                                                                                                                        | unit: passed                           | 0.001 s | 0.001 s | 0.008 s |
| tests/test-benchmark.test.ts                 | Vitest benchmark results reject missing summaries, count mismatches and unknown statuses                                                                                                      | unit: passed                           | 0.001 s | 0.001 s | 0.001 s |
| tests/previews.test.ts                       | deployment scripts explicitly select Worker Previews and their migration target                                                                                                               | unit: passed                           | 0.001 s | 0.001 s | 0.001 s |
| tests/test-benchmark.test.ts                 | a failed Vitest fixture is not counted as a passing benchmark                                                                                                                                 | unit: passed                           | 0.000 s | 0.000 s | 0.000 s |
| tests/test-benchmark.test.ts                 | Vitest benchmark results retain a passing empty inventory without inventing cases                                                                                                             | unit: passed                           | 0.000 s | 0.000 s | 0.000 s |
| tests/account-forms.test.ts                  | empty rate-limit and service errors have readable fallbacks                                                                                                                                   | unit: passed                           | 0.000 s | 0.000 s | 0.001 s |
| tests/event-policy.test.ts                   | patrols require explicit approval                                                                                                                                                             | unit: passed                           | 0.000 s | 0.000 s | 0.001 s |
| tests/event-policy.test.ts                   | full, closed, started and invalid-date events reject signups                                                                                                                                  | unit: passed                           | 0.000 s | 0.000 s | 0.000 s |
| tests/event-policy.test.ts                   | sign-in, registration and active status are required                                                                                                                                          | unit: passed                           | 0.000 s | 0.000 s | 0.000 s |
| tests/event-policy.test.ts                   | organizer profile access requires two-factor only when enabled                                                                                                                                | unit: passed                           | 0.000 s | 0.000 s | 0.000 s |
| tests/event-policy.test.ts                   | unapproved volunteers can sign up for orientations                                                                                                                                            | unit: passed                           | 0.000 s | 0.000 s | 0.001 s |

## Comparison with baseline

Baseline: 2026-10-07T20:07:59.494Z, commit `a82ebc4884166e11e0399a5a6b40ed6416548144`. Distinct registered tests: 118 → 116 (-2).
Leaf cases: 115 → 116. Parent/container counts: 3 → 0. A runner changing its suite-counting convention is not a coverage reduction.

**Environment or benchmark options differ. Treat runtime deltas as non-equivalent until you repeat with matching conditions.**

| Phase                                  | Tests before → after | Wall before → after | Delta     | Delta % |
| -------------------------------------- | -------------------- | ------------------- | --------- | ------- |
| Vitest unit / Cloudflare runtime tests | 56 → 60              | 18.793 s → 8.007 s  | -10.786 s | -57.4%  |
| Production build                       | — → —                | 5.207 s → 4.923 s   | -0.284 s  | -5.5%   |
| Production Worker tests                | 39 → 35              | 19.515 s → 14.484 s | -5.031 s  | -25.8%  |
| Preview build                          | — → —                | 5.112 s → 4.883 s   | -0.230 s  | -4.5%   |
| Preview Worker tests                   | 1 → 1                | 3.244 s → 3.776 s   | +0.532 s  | 16.4%   |
| Local browser tests                    | 22 → 20              | 16.463 s → 10.167 s | -6.296 s  | -38.2%  |
| Deployed browser smoke tests           | 4 → 4                | 2.774 s → 2.632 s   | -0.142 s  | -5.1%   |

### Removed tests

- `tests/previews.test.ts`: Astro disables all remote bindings in development
- `tests/worker/accounts.test.ts`: production-built Worker enforces authentication, ownership, CSRF and private-page protections › signed-in registration includes account navigation
- `tests/worker/accounts.test.ts`: production-built Worker enforces authentication, ownership, CSRF and private-page protections › production assets contain no simulated sign-in or demo controls
- `tests/worker/accounts.test.ts`: production-built Worker enforces authentication, ownership, CSRF and private-page protections
- `tests/worker/events.test.ts`: real event and organizer flows in the built Worker › real listings have no invented events, demo code or signed-out account menu
- `tests/worker/events.test.ts`: real event and organizer flows in the built Worker › last spot is atomic across simultaneous signups without queuing email
- `tests/worker/events.test.ts`: real event and organizer flows in the built Worker › approval without orientation grants patrol access, arbitrary client role does not
- `tests/worker/events.test.ts`: real event and organizer flows in the built Worker › volunteer signups and cancellations preserve records and audits without emails
- `tests/worker/events.test.ts`: real event and organizer flows in the built Worker › organizers without two-factor can manage events and view audited profiles
- `tests/worker/events.test.ts`: real event and organizer flows in the built Worker › capacity, optimistic edit conflicts, hidden and closed events are enforced
- `tests/worker/events.test.ts`: real event and organizer flows in the built Worker › move rollback preserves source signup when destination is full
- `tests/worker/events.test.ts`: real event and organizer flows in the built Worker › orientation completion requires an actual past attendance and never approves patrols
- `tests/worker/events.test.ts`: real event and organizer flows in the built Worker › deactivation silently cancels future spots and last organizer cannot be removed
- `tests/worker/events.test.ts`: real event and organizer flows in the built Worker › opted-in cancellation preserves records, cancels spots and queues notifications atomically
- `tests/worker/events.test.ts`: real event and organizer flows in the built Worker › organizer promotions require verified registration, not two-factor, and revoke sessions
- `tests/worker/events.test.ts`: real event and organizer flows in the built Worker › real browser UI supports event creation and signup with nav below heading on mobile
- `tests/worker/events.test.ts`: real event and organizer flows in the built Worker
- `tests/worker/organizer-notifications.test.ts`: organizer emails require explicit opt-in in the built Worker
- `tests/preview/build.test.ts`: the preview banner does not gate features or restrict accounts to preview hosts
- `tests/ui/account-forms.spec.ts`: email sign-in validates, loads, switches to code, and resets on /volunteer
- `tests/ui/account-forms.spec.ts`: email sign-in validates, loads, switches to code, and resets on /volunteer/sign-in
- `tests/ui/account-forms.spec.ts`: public and private headers keep the same font and geometry, and privacy is black
- `tests/ui/volunteer.spec.ts`: the shared sign-in panel is centered and left-aligned on desktop and mobile
- `tests/ui/volunteer.spec.ts`: account edits persist in D1 and use the shared UI at 1280px
- `tests/ui/volunteer.spec.ts`: account edits persist in D1 and use the shared UI at 375px

### Added tests

- `tests/test-benchmark.test.ts`: Vitest benchmark results count leaf cases, skips, todos and failures
- `tests/test-benchmark.test.ts`: a failed Vitest fixture is not counted as a passing benchmark
- `tests/test-benchmark.test.ts`: Vitest benchmark results reject missing summaries, count mismatches and unknown statuses
- `tests/test-benchmark.test.ts`: Vitest benchmark results retain a passing empty inventory without inventing cases
- `tests/test-benchmark.test.ts`: benchmark comparisons distinguish retired Node containers from lost leaf coverage
- `tests/worker/accounts.test.ts`: production-built Worker enforces authentication, ownership, CSRF and private-page protections › production builds reject development account endpoints without changing sessions
- `tests/worker/events.test.ts`: real event and organizer flows in the built Worker › with scheduled events › real listings have no invented events, demo code or signed-out account menu
- `tests/worker/events.test.ts`: real event and organizer flows in the built Worker › with scheduled events › last spot is atomic across simultaneous signups without queuing email
- `tests/worker/events.test.ts`: real event and organizer flows in the built Worker › with scheduled events › approval without orientation grants patrol access, arbitrary client role does not
- `tests/worker/events.test.ts`: real event and organizer flows in the built Worker › with scheduled events › volunteer signups and cancellations preserve records and audits without emails
- `tests/worker/events.test.ts`: real event and organizer flows in the built Worker › with scheduled events › organizers without two-factor can manage events and view audited profiles
- `tests/worker/events.test.ts`: real event and organizer flows in the built Worker › with scheduled events › capacity, optimistic edit conflicts, hidden and closed events are enforced
- `tests/worker/events.test.ts`: real event and organizer flows in the built Worker › with scheduled events › move rollback preserves source signup when destination is full
- `tests/worker/events.test.ts`: real event and organizer flows in the built Worker › with scheduled events › orientation completion requires an actual past attendance and never approves patrols
- `tests/worker/events.test.ts`: real event and organizer flows in the built Worker › with scheduled events › deactivation silently cancels future spots and last organizer cannot be removed
- `tests/worker/events.test.ts`: real event and organizer flows in the built Worker › with scheduled events › opted-in cancellation preserves records, cancels spots and queues notifications atomically
- `tests/worker/events.test.ts`: real event and organizer flows in the built Worker › with scheduled events › organizer promotions require verified registration, not two-factor, and revoke sessions
- `tests/worker/events.test.ts`: real event and organizer flows in the built Worker › with scheduled events › browser organizer and volunteer workflows save in place and remain usable on mobile
- `tests/preview/build.test.ts`: preview builds support real account features but reject development endpoints
- `tests/ui/account-forms.spec.ts`: email sign-in validates, loads, switches to code, and resets
- `tests/ui/account-forms.spec.ts`: private pages make no third-party requests and remain usable on mobile
- `tests/ui/volunteer.spec.ts`: volunteer-page sign-in is usable on mobile and opens the shared code form
- `tests/ui/volunteer.spec.ts`: account navigation and profile controls are usable on desktop and mobile

## Raw data

Structured measurements: `docs/benchmarks/test-vitest.json`. Raw runner JSON and command logs: `test-results/benchmarks/2026-10-07T23-05-32-588Z` (ignored by Git). The structured snapshot stores each measured run and every test name/duration; keep it with this report for future comparisons.
