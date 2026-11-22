import { createAuth } from "../../src/server/auth";

/** Use the official server-only generator without sending mail from a test. */
export async function createSignInOTP(
  DB: Env["DB"],
  secret: string,
  address: string,
) {
  const email = address.trim().toLowerCase();
  const auth = createAuth({
    DB,
    BETTER_AUTH_SECRET: secret,
    AUTH_BASE_URL: "https://afterhoursoutreach.ca",
    APP_ENV: "production",
    EMAIL: undefined as unknown as SendEmail,
  });
  const otp = await auth.api.createVerificationOTP({
    body: { email, type: "sign-in" },
  });
  return { email, otp };
}
