import { expect, type APIRequestContext } from "@playwright/test";

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
  const challenge = await request.post("/api/auth/email/request", {
    headers,
    data: { email },
  });
  expect(challenge.status(), await challenge.text()).toBe(200);
  const proof: { id: string; localEmail: { code: string } } =
    await challenge.json();
  const verified = await request.post("/api/auth/email/verify", {
    headers,
    data: { id: proof.id, code: proof.localEmail.code },
  });
  expect(verified.status(), await verified.text()).toBe(200);
  if (registered) {
    const profile = await request.post("/api/account/profile", {
      headers,
      data: sampleAnswers,
    });
    expect(profile.status(), await profile.text()).toBe(200);
  }
  const current = await request.get("/api/auth/get-session", { headers });
  const { user }: { user: { id: string } } = await current.json();
  return { id: user.id, email, name: sampleAnswers.name };
}
