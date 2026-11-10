export const defaultUnregisterMinutes = 30;
export const maxUnregisterMinutes = 10_080;

export function eventUnregisterDeadline(event: {
  startsAt: number;
  unregisterMinutes: number;
}) {
  return event.startsAt + event.unregisterMinutes * 60_000;
}
