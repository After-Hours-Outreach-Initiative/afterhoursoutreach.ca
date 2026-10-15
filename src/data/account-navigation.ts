export interface AccountNavigation {
  signedIn: boolean;
  name: string;
  greetingName: string;
  email: string;
  organizer: boolean;
}

export function accountGreeting(
  answers?: { firstName?: string | null; preferredName?: string | null } | null,
  name?: string,
) {
  return (
    answers?.preferredName?.trim() ||
    answers?.firstName?.trim() ||
    name?.trim().split(/\s+/)[0] ||
    "Account"
  );
}
