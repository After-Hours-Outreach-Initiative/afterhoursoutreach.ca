import { beforeEach, expect, test, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  account: vi.fn(),
  prepare: vi.fn(),
  bind: vi.fn(),
  run: vi.fn(),
}));
vi.mock("cloudflare:workers", () => ({
  env: { DB: { prepare: mocks.prepare } },
}));
vi.mock("@/server/auth", () => ({ forwardCookies: vi.fn() }));
vi.mock("@/server/db/access", async (original) => ({
  ...(await original<typeof import("@/server/db/access")>()),
  accountContext: mocks.account,
}));
import { POST } from "../src/pages/api/v1/account/notifications";
beforeEach(() => {
  vi.clearAllMocks();
  mocks.account.mockResolvedValue({
    actor: {
      id: "organizer",
      sessionId: "session",
      role: "organizer",
      active: true,
      applicationSubmitted: true,
      twoFactorEnabled: false,
    },
    headers: new Headers(),
  });
  mocks.prepare.mockReturnValue({ bind: mocks.bind });
  mocks.bind.mockReturnValue({ run: mocks.run });
  mocks.run.mockResolvedValue({ meta: { changes: 1 } });
});
function save(body: object) {
  return POST({
    request: new Request(
      "https://afterhoursoutreach.ca/api/v1/account/notifications",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    ),
  } as Parameters<typeof POST>[0]);
}
test("organizers can enable and disable notifications for their own account", async () => {
  for (const enabled of [true, false]) {
    expect(
      (await save({ userId: "organizer", applicationReviewEmails: enabled }))
        .status,
    ).toBe(200);
    expect(mocks.bind).toHaveBeenLastCalledWith(
      Number(enabled),
      "organizer",
      "organizer",
      "session",
      expect.any(Number),
    );
  }
});
test("volunteers and signed-out visitors cannot change notification settings", async () => {
  for (const actor of [
    null,
    {
      id: "volunteer",
      role: "volunteer",
      active: true,
      applicationSubmitted: true,
      applicationComplete: true,
      applicationApproved: true,
    },
  ]) {
    mocks.account.mockResolvedValue({ actor, headers: new Headers() });
    expect(
      (await save({ userId: "volunteer", applicationReviewEmails: true }))
        .status,
    ).toBeGreaterThanOrEqual(400);
  }
  expect(mocks.run).not.toHaveBeenCalled();
});
test("rejects account changes and non-boolean preferences", async () => {
  expect(
    (await save({ userId: "other", applicationReviewEmails: true })).status,
  ).toBe(403);
  expect(
    (await save({ userId: "organizer", applicationReviewEmails: "false" }))
      .status,
  ).toBe(400);
  expect(mocks.run).not.toHaveBeenCalled();
});
