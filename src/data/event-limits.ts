export interface EventLimits {
  minMedicSpots: number;
  minNewVolunteerSpots: number;
  maxNewVolunteers: number;
}

export const defaultEventLimits: EventLimits = {
  minMedicSpots: 2,
  minNewVolunteerSpots: 2,
  maxNewVolunteers: 4,
};

export function minimumEventSpots(
  event: Partial<EventLimits> & { includesOrientation?: boolean | number },
) {
  return Math.max(
    1,
    (event.minMedicSpots ?? defaultEventLimits.minMedicSpots) +
      (event.includesOrientation
        ? (event.minNewVolunteerSpots ??
          defaultEventLimits.minNewVolunteerSpots)
        : 0),
  );
}

export function rosterCapacitySummary(
  event: Partial<EventLimits> & {
    includesOrientation: boolean | number;
    medicConfirmed: number;
    newVolunteerConfirmed: number;
  },
) {
  const limits = { ...defaultEventLimits, ...event };
  const medics = Math.max(0, limits.minMedicSpots - event.medicConfirmed);
  const newcomers = Math.max(
    0,
    limits.minNewVolunteerSpots - event.newVolunteerConfirmed,
  );
  return `Medics: ${event.medicConfirmed} registered, ${medics} ${medics === 1 ? "place" : "places"} reserved.${
    event.includesOrientation
      ? ` New volunteers: ${event.newVolunteerConfirmed}/${limits.maxNewVolunteers} registered, ${newcomers} ${newcomers === 1 ? "place" : "places"} reserved.`
      : ""
  }`;
}
