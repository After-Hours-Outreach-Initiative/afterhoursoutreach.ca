import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ submission: vi.fn(), medic: vi.fn() }));
vi.mock("@astrojs/cloudflare/handler", () => ({ handle: vi.fn() }));
vi.mock("../src/server/submission-notifications", () => ({
  runSubmissionNotificationJob: mocks.submission,
  submissionDeliveryCron: "30 * * * *",
}));
vi.mock("../src/server/medic-certifications", () => ({
  processMedicCertificationNotifications: mocks.medic,
  medicDeliveryCron: "30 * * * *",
  medicDiscoveryCron: "0 16 * * *",
}));
import worker from "../src/worker";

afterEach(() => {
  vi.resetAllMocks();
  vi.restoreAllMocks();
});
const scheduled = (cron: string) =>
  worker.scheduled({ cron } as ScheduledController, {} as Env);

test("the existing hourly cron automatically drains submission intents independently of medic delivery", async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  mocks.submission.mockResolvedValue({ failed: 1 }); // Catch-safe failure in its own job.
  mocks.medic.mockResolvedValue({ sent: 0 });
  await scheduled("30 * * * *");
  assert.equal(mocks.submission.mock.calls.length, 1);
  assert.equal(mocks.medic.mock.calls.length, 1);
  assert.equal(mocks.medic.mock.calls[0][1], false);
});

test("daily medic discovery and unrelated triggers do not sweep submission or event/access mail", async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  mocks.medic.mockResolvedValue({ sent: 0 });
  await scheduled("0 16 * * *");
  await scheduled("unknown");
  assert.equal(mocks.submission.mock.calls.length, 0);
  assert.equal(mocks.medic.mock.calls.length, 1);
  assert.equal(mocks.medic.mock.calls[0][1], true);
});
