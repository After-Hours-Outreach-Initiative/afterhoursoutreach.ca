import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  account: vi.fn(),
  save: vi.fn(),
  confirm: vi.fn(),
  rate: vi.fn(),
  job: vi.fn(),
  statements: vi.fn(() => []),
}));
vi.mock("cloudflare:workers", () => ({
  env: {
    DB: {},
    APP_ENV: "production",
    BETTER_AUTH_SECRET: "test-only-secret",
  },
}));
vi.mock("@/server/auth", () => ({ forwardCookies: vi.fn() }));
vi.mock("@/server/db/access", () => ({ accountContext: mocks.account }));
vi.mock("@/server/db/profiles", () => ({ saveProfile: mocks.save }));
vi.mock("@/server/db/naloxone", () => ({
  confirmNaloxoneCompletion: mocks.confirm,
}));
vi.mock("@/server/db/rate-limits", () => ({ takeRateLimit: mocks.rate }));
vi.mock("@/server/db/submission-notifications", () => ({
  submissionNotificationStatements: () => mocks.statements,
}));
vi.mock("@/server/submission-notifications", () => ({
  runSubmissionNotificationJob: mocks.job,
}));
import { POST } from "../src/pages/api/v1/account/profile";
import { POST as confirmNaloxone } from "../src/pages/api/v1/account/naloxone";

beforeEach(() => {
  mocks.account.mockResolvedValue({
    actor: { id: "applicant", twoFactorEnabled: false },
    headers: new Headers(),
  });
  mocks.save.mockResolvedValue({
    firstSubmitted: true,
    operationId: "winning-operation",
    answers: {},
  });
  mocks.job.mockResolvedValue({ failed: 1 }); // Catch-safe delivery result, not a save failure.
  mocks.confirm.mockResolvedValue({
    completedAt: 123,
    reviewOperationId: "winning-operation",
  });
});
afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

function invoke(
  intent: "submit" | "edit",
  waitUntil = (_promise: Promise<unknown>) => {},
) {
  // Minimal Astro context: the endpoint uses only request and cfContext.
  return POST({
    request: new Request(
      "https://afterhoursoutreach.ca/api/v1/account/profile",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          applicationUserId: "applicant",
          intent,
          ...(intent === "submit"
            ? { draft: { revision: null, generation: null } }
            : { baseline: {} }),
          firstName: "Sample",
          codeOfConductAccepted: true,
        }),
      },
    ),
    locals: { cfContext: { waitUntil } },
  } as Parameters<typeof POST>[0]);
}

function invokeConfirmation(waitUntil = (_promise: Promise<unknown>) => {}) {
  return confirmNaloxone({
    request: new Request(
      "https://afterhoursoutreach.ca/api/v1/account/naloxone",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: "applicant", completed: true }),
      },
    ),
    locals: { cfContext: { waitUntil } },
  } as Parameters<typeof confirmNaloxone>[0]);
}

test("successful initial form submission never enqueues or schedules organizer email", async () => {
  const response = await invoke("submit");
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    firstSubmitted: boolean;
    next: string;
  };
  assert.equal(body.firstSubmitted, true);
  assert.equal(body.next, "/events");
  assert.equal(mocks.save.mock.calls[0][1], "applicant");
  assert.equal(
    mocks.save.mock.calls[0][3].firstSubmissionStatements,
    undefined,
  );
  assert.equal(mocks.job.mock.calls.length, 0);
});

test("review entry passes a transactional intent hook and schedules a bounded, separate job", async () => {
  const background: Promise<unknown>[] = [];
  const response = await invokeConfirmation((promise) => {
    background.push(promise);
  });
  assert.equal(response.status, 200);
  assert.equal(
    mocks.confirm.mock.calls[0][3].reviewStatements,
    mocks.statements,
  );
  assert.deepEqual(mocks.job.mock.calls[0][1], {
    operationId: "winning-operation",
    limit: 3,
    timeoutMs: 20_000,
  });
  assert.equal(background.length, 1);
  await Promise.all(background);
});

test("waitUntil scheduling failures cannot turn committed review entry into an error response or leak details", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const response = await invokeConfirmation(() => {
    throw new Error("private address and answers");
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as { completedAt: number };
  assert.equal(body.completedAt, 123);
  assert.deepEqual(log.mock.calls, [
    [
      JSON.stringify({
        event: "application_submission_notifications",
        error: "scheduling_unavailable",
      }),
    ],
  ]);
});

test("profile edits, duplicate submissions and repeated course confirmations do not start notification jobs", async () => {
  for (const intent of ["submit", "edit"] as const) {
    mocks.save.mockResolvedValue({
      firstSubmitted: false,
      alreadySubmitted: intent === "submit",
      answers: {},
    });
    const response = await invoke(intent);
    assert.equal(response.status, 200);
    const body = (await response.json()) as { next: string };
    assert.equal(
      body.next,
      intent === "submit" ? "/events" : "/volunteer/account",
    );
  }
  mocks.confirm.mockResolvedValue({ completedAt: 123 });
  assert.equal((await invokeConfirmation()).status, 200);
  assert.equal(mocks.job.mock.calls.length, 0);
});
