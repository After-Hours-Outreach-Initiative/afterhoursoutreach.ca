import { z } from "zod";
import type { EventLimits } from "../../data/event-limits";
import {
  defaultUnregisterMinutes,
  maxUnregisterMinutes,
} from "../../data/event-unregistration";
import { eventLimitFields, eventLimitInputFields } from "./event-limits";

export const eventSettingFields = {
  ...eventLimitFields,
  unregisterMinutes: z
    .number()
    .int()
    .min(0)
    .max(maxUnregisterMinutes)
    .default(defaultUnregisterMinutes),
};

// Preserve omitted settings until the domain operation merges the saved values.
export const eventSettingInputFields = {
  ...eventLimitInputFields,
  unregisterMinutes: eventSettingFields.unregisterMinutes.unwrap().optional(),
};

export function withEventSettings(
  input: unknown,
  saved?: EventLimits & { unregisterMinutes: number },
) {
  if (!saved || !input || typeof input !== "object" || Array.isArray(input))
    return input;
  const {
    minMedicSpots,
    minNewVolunteerSpots,
    maxNewVolunteers,
    unregisterMinutes,
  } = saved;
  return {
    minMedicSpots,
    minNewVolunteerSpots,
    maxNewVolunteers,
    unregisterMinutes,
    ...input,
  };
}
