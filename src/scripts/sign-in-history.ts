const storageKey = "aho:sign-in-emails:v1";
const historyLimit = 5;

function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    ? email
    : null;
}

export function rememberedSignInEmails(): string[] {
  try {
    const stored: unknown = JSON.parse(
      localStorage.getItem(storageKey) ?? "[]",
    );
    if (!Array.isArray(stored)) return [];
    return [
      ...new Set(stored.map(normalizeEmail).filter((email) => email !== null)),
    ].slice(0, historyLimit);
  } catch {
    // Browser storage can be blocked, unavailable or contain invalid JSON.
    return [];
  }
}

export function rememberSuccessfulSignIn(result: object) {
  // Only completed auth responses qualify, never delivery or two-factor challenges.
  if (
    ("twoFactorRedirect" in result && result.twoFactorRedirect === true) ||
    !("token" in result) ||
    typeof result.token !== "string" ||
    !result.token ||
    !("user" in result) ||
    !result.user ||
    typeof result.user !== "object" ||
    !("email" in result.user)
  )
    return;
  const email = normalizeEmail(result.user.email);
  if (!email) return;
  try {
    // Persist email addresses only, never the auth response, session token or codes.
    localStorage.setItem(
      storageKey,
      JSON.stringify(
        [
          email,
          ...rememberedSignInEmails().filter((saved) => saved !== email),
        ].slice(0, historyLimit),
      ),
    );
  } catch {
    // Remembering an address must never prevent sign-in.
  }
}

export function forgetSignInEmails() {
  try {
    localStorage.removeItem(storageKey);
  } catch {
    // Sign-in remains usable when browser storage is blocked.
  }
}
