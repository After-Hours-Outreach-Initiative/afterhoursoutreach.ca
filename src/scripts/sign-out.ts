import { authClient } from "./auth-client";
import { clearSyncedApplicationDrafts } from "./application-draft";

export async function signOut() {
  await authClient.signOut();
  clearSyncedApplicationDrafts();
}
