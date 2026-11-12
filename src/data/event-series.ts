/** "Every 2 weeks", or null for one-off events. The card heading names the day. */
export function seriesCadence(event: { intervalWeeks: number | null }) {
  if (!event.intervalWeeks) return null;
  return event.intervalWeeks === 1
    ? "Every week"
    : `Every ${event.intervalWeeks} weeks`;
}

/** Eight weeks fits inside the two-month window, so every series always has a date to edit. */
export const maxIntervalWeeks = 8;
