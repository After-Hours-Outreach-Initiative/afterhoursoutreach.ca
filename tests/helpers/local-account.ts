import { expect, type APIRequestContext, type Page } from "@playwright/test";

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
  name: "Database Test Volunteer",
  pronouns: "they/them",
  phone: "604-555-0100",
  birthDate: "1995-04-12",
  emergencyName: "Sample Contact",
  emergencyPhone: "604-555-0101",
  emergencyRelationship: "Friend",
  heardAboutUs: "A friend",
  motivation: "Sample answer",
  teams: ["outreach"],
  certification: "None",
  experience: "None",
  medicalConditions: "Sample private answer",
};

export async function createLocalAccount(
  request: APIRequestContext,
  origin: string,
  registered = true,
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
  if (registered) {
    const profile = await request.post("/api/v1/account/profile", {
      headers,
      data: { ...sampleAnswers, codeOfConductAccepted: true },
    });
    expect(profile.status(), await profile.text()).toBe(200);
  }
  const current = await request.get("/api/v1/auth/get-session", { headers });
  const { user }: { user: { id: string } } = await current.json();
  return { id: user.id, email, name: sampleAnswers.name };
}
