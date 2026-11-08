import { expect, test } from "vitest";
import {
  isApplicationComplete,
  isApplicationReadyForReview,
} from "../src/server/db/application-progress";

test.each([
  { submittedAt: null, naloxoneCompletedAt: null, ready: false },
  { submittedAt: null, naloxoneCompletedAt: 0, ready: false },
  { submittedAt: 0, naloxoneCompletedAt: null, ready: false },
  { submittedAt: 0, naloxoneCompletedAt: 0, ready: true },
])(
  "review readiness requires every applicant step: $submittedAt / $naloxoneCompletedAt",
  ({ ready, ...progress }) => {
    expect(isApplicationReadyForReview(progress)).toBe(ready);
    expect(
      isApplicationComplete({ ...progress, applicationApproved: false }),
    ).toBe(false);
    expect(
      isApplicationComplete({ ...progress, applicationApproved: true }),
    ).toBe(ready);
    // Disabled Discord linking must not prevent review of the active three steps.
    expect(
      isApplicationReadyForReview({
        ...progress,
        discordRequired: true,
        discordCompletedAt: null,
      }),
    ).toBe(ready);
  },
);
