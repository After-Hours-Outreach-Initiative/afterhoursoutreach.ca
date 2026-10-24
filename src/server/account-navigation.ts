import type { AccountNavigation } from "../data/account-navigation";
import { forwardCookies, type AuthBindings } from "./auth";
import { accountContext, canViewEvents } from "./db/access";

/** Resolve the header before rendering; personalized HTML must never be cached. */
export async function loadAccountNavigation(
  bindings: AuthBindings,
  request: Request,
  responseHeaders: Headers,
): Promise<AccountNavigation> {
  responseHeaders.set("Cache-Control", "no-store");
  const signedOut: AccountNavigation = {
    signedIn: false,
    name: "",
    greetingName: "Account",
    email: "",
    organizer: false,
    eventAccess: false,
  };
  if (!bindings.BETTER_AUTH_SECRET) return signedOut;
  try {
    const { actor, email, greetingName, headers } = await accountContext(
      bindings,
      request,
    );
    forwardCookies(headers, responseHeaders);
    return actor
      ? {
          signedIn: true,
          name: actor.name,
          greetingName,
          email,
          organizer: actor.role === "organizer",
          eventAccess: canViewEvents(actor),
        }
      : signedOut;
  } catch {
    // Public information must remain readable during an account-service outage.
    // Do not log adapter errors: they can include private values or SQL bindings.
    console.error(JSON.stringify({ event: "account_navigation_unavailable" }));
    return signedOut;
  }
}
