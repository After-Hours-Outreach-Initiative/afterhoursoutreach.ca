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

/** Why an Orientation + Patrol with new volunteers cannot become a patrol. */
export const orientationNeededMessage =
  "New volunteers are registered and need the orientation. Move or remove them before making this a patrol.";
