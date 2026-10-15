import type { AccountNavigation } from "../data/account-navigation";
import { forwardCookies, type AuthBindings } from "./auth";
import { accountContext } from "./db/access";

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
  };
  if (!bindings.BETTER_AUTH_SECRET) return signedOut;
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
      }
    : signedOut;
}
