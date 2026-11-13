/** Event fields booked volunteers are emailed about. Other edits, such as
 * spots, the unregister deadline, visibility or the map link, save at once
 * without email. Schedule fields can cancel dates, which is emailed. */
const emailedEventFields = new Set([
  "startsAt",
  "startTime",
  "localTime",
  "dayOffset",
  "includesOrientation",
  "type",
  "meetingPoint",
  "intervalWeeks",
  "endDate",
]);

export const emailsEventChange = (fields: Iterable<string>) =>
  [...fields].some((field) => emailedEventFields.has(field));
