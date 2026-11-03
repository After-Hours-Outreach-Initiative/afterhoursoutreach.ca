import { personDisplayName, type PersonName } from "./person-name";

export const signInDestination = "/volunteer";

export interface AccountNavigation {
  signedIn: boolean;
  name: string;
  greetingName: string;
  email: string;
  organizer: boolean;
  eventAccess: boolean;
  readyApplicationCount: number;
}

export function accountGreeting(answers?: PersonName | null, name?: string) {
  return personDisplayName(answers, name, "Account");
}
