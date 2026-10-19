// A virtual choice, never the ID of a fixture or a saved application.
export const newApplicationPersona = "new-application";

// Only these exact manual preset IDs are protected, regardless of name or role.
export const manualAccountPresetIds: readonly string[] = [
  "local-account-user-applied",
  "local-account-user-accepted",
  "local-account-user-inactive",
  "local-account-user-organizer",
];

export function isManualAccountPreset(userId: string) {
  return manualAccountPresetIds.includes(userId);
}
