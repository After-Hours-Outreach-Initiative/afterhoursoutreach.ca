import { z } from "zod";
import { defaultEventLimits } from "../../data/event-limits";

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
