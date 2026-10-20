import {
  expect,
  type APIRequestContext,
  type Locator,
  type Page,
} from "@playwright/test";
import { fillDateInput } from "./date-input";

export async function fillApplicationField(
  scope: Page | Locator,
  name: string,
  value: string,
) {
  if (!["birthDate", "certificationExpiry"].includes(name)) {
    await scope.locator(`[name="${name}"]`).fill(value);
    return;
  }
  await fillDateInput(scope, name, value);
}

export async function openLocalAccountSwitcher(page: Page) {
  await page
    .getByRole("button", { name: "Development controls", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Local development",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  // Keep the locator usable for selection assertions after navigation closes the dialog.
  const profiles = page.getByRole("group", {
    name: "View as",
    exact: true,
    includeHidden: true,
  });
  await expect(profiles).toBeVisible();
  await expect(profiles).toHaveAttribute("aria-busy", "false");
  await expect(
    profiles.getByRole("button", { name: "Visitor", exact: true }),
  ).toBeEnabled();
  return profiles;
}

export const sampleAnswers = {
  firstName: "Database",
  middleNames: "Test",
  lastName: "Volunteer",
  preferredName: "Database Test Volunteer",
  pronouns: "they/them",
  phone: "604-555-0100",
  birthDate: "1995-04-12",
  emergencyName: "Sample Contact",
  emergencyPhone: "604-555-0101",
  emergencyRelationship: "Friend",
  heardAboutUs: "A friend",
  heardAboutUsSources: ["friend-word-of-mouth"],
  heardAboutUsOther: "",
  motivation: "Sample answer",
  teams: ["outreach"],
  certification: "None",
  certifications: [],
  certificationExpiry: "",
  experience: "None",
  training: ["none"],
  otherTraining: "",
  medicalConditions: "Sample private answer",
};

function localApplicationProgressScope(page: Page) {
  return (page.viewportSize()?.width ?? 1280) < 1024
    ? "[data-contents-menu]"
    : ".volunteer-contents-actions";
}

export function localApplicationSaveIndicator(page: Page) {
  return page.locator(
    `${localApplicationProgressScope(page)} [data-draft-save-indicator]`,
  );
}

export function localApplicationReviewButton(
  page: Page,
  placement: "progress" | "bottom" = "progress",
) {
  const scope =
    placement === "bottom"
      ? "[data-application-draft-actions]"
      : localApplicationProgressScope(page);
  return page.locator(`${scope} [data-application-review]`);
}

export async function reviewLocalApplication(page: Page) {
  if ((page.viewportSize()?.width ?? 1280) < 1024) {
    const tracker = page.locator("[data-application-contents]");
    const menu = tracker.locator("[data-contents-menu]");
    if (!(await menu.evaluate((element: HTMLDetailsElement) => element.open)))
      await menu.locator("summary").click();
  }
  await localApplicationReviewButton(page).click();
}

export async function submitLocalApplication(page: Page) {
  await reviewLocalApplication(page);
  await page.locator('[name="codeOfConductAccepted"]').check();
  await page
    .getByRole("button", { name: "Submit application", exact: true })
    .click();
}

export async function createLocalAccount(
  request: APIRequestContext,
  origin: string,
  applicationSubmitted = true,
) {
  const email = `ui-${crypto.randomUUID()}@example.org`;
  const bytes = crypto.getRandomValues(new Uint8Array(2));
  const headers = {
    origin,
    "cf-connecting-ip": `198.18.${bytes[0]}.${bytes[1]}`,
  };
  const challenge = await request.post(
    "/api/v1/auth/email-otp/send-verification-otp",
    {
      headers,
      data: { email, type: "sign-in" },
    },
  );
  expect(challenge.status(), await challenge.text()).toBe(200);
  const proof: { localEmail: { code: string } } = await challenge.json();
  const verified = await request.post("/api/v1/auth/sign-in/email-otp", {
    headers,
    data: { email, otp: proof.localEmail.code },
  });
  expect(verified.status(), await verified.text()).toBe(200);
  const current = await request.get("/api/v1/auth/get-session", { headers });
  const { user }: { user: { id: string } } = await current.json();
  if (applicationSubmitted) {
    const profile = await request.post("/api/v1/account/profile", {
      headers,
      data: {
        ...sampleAnswers,
        codeOfConductAccepted: true,
        applicationUserId: user.id,
        intent: "submit",
        draft: { revision: null, generation: null },
      },
    });
    expect(profile.status(), await profile.text()).toBe(200);
  }
  return { id: user.id, email, name: sampleAnswers.preferredName };
}

export async function approveLocalApplication(
  organizer: APIRequestContext,
  origin: string,
  userId: string,
) {
  const profile = await organizer.get(`/volunteer/volunteers/${userId}`);
  expect(profile.status(), await profile.text()).toBe(200);
  const version = (await profile.text()).match(
    /name="version" value="(\d+)"/,
  )?.[1];
  expect(version).toBeDefined();
  const approved = await organizer.post("/api/v1/organizer/action", {
    headers: { origin },
    data: {
      action: "status",
      userId,
      version: Number(version),
      active: true,
      applicationApproved: true,
      patrolApproved: false,
    },
  });
  expect(approved.status(), await approved.text()).toBe(200);
}
