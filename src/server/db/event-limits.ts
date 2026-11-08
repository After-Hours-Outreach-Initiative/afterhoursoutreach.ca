import { z } from "zod";
import { defaultEventLimits, type EventLimits } from "../../data/event-limits";

export const eventLimitFields = {
  minMedicSpots: z
    .number()
    .int()
    .min(0)
    .max(100)
    .default(defaultEventLimits.minMedicSpots),
  minNewVolunteerSpots: z
    .number()
    .int()
    .min(0)
    .max(100)
    .default(defaultEventLimits.minNewVolunteerSpots),
  maxNewVolunteers: z
    .number()
    .int()
    .min(0)
    .max(100)
    .default(defaultEventLimits.maxNewVolunteers),
};

// Request validation must not fill omitted settings before the domain operation
// can merge them with a saved event, series or effective template.
export const eventLimitInputFields = {
  minMedicSpots: eventLimitFields.minMedicSpots.unwrap().optional(),
  minNewVolunteerSpots: eventLimitFields.minNewVolunteerSpots
    .unwrap()
    .optional(),
  maxNewVolunteers: eventLimitFields.maxNewVolunteers.unwrap().optional(),
};

/** Older clients may omit the new fields; edits must retain saved limits. */
export function withEventLimits(input: unknown, saved?: EventLimits) {
  if (!saved || !input || typeof input !== "object" || Array.isArray(input))
    return input;
  const { minMedicSpots, minNewVolunteerSpots, maxNewVolunteers } = saved;
  return { minMedicSpots, minNewVolunteerSpots, maxNewVolunteers, ...input };
}
