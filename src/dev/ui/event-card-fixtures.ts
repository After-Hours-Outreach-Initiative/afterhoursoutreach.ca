import type { Actor } from "../../server/db/access";
import type { EventRow, PublicRosterRow } from "../../server/db/events";
import {
  availableSignupSpots,
  eventSignupBlockReason,
} from "../../server/db/policy";

export const eventCardPreviewPath = "/dev/ui/event-card/preview";
export const eventCardChannel = "ahoi-local-ui-event-card";

interface EventCardScenario {
  id: string;
  label: string;
  description: string;
  medics: number;
  outreach: number;
  newcomers: number;
  orientation?: boolean;
  registered?: boolean;
  newViewer?: boolean;
}

export const eventCardScenarios: EventCardScenario[] = [
  {
    id: "full",
    label: "Full · 8 of 8 spots taken",
    description:
      "Two approved medics, two outreach volunteers and four new volunteers.",
    medics: 2,
    outreach: 2,
    newcomers: 4,
    orientation: true,
  },
  {
    id: "mixed",
    label: "Mixed volunteer team",
    description: "Two of each volunteer type, with room for more.",
    medics: 2,
    outreach: 2,
    newcomers: 2,
    orientation: true,
  },
  {
    id: "medics",
    label: "Approved medics",
    description: "Two approved medics registered for a patrol.",
    medics: 2,
    outreach: 0,
    newcomers: 0,
  },
  {
    id: "outreach",
    label: "Outreach volunteers",
    description: "Three returning outreach volunteers registered for a patrol.",
    medics: 0,
    outreach: 3,
    newcomers: 0,
  },
  {
    id: "new-volunteers",
    label: "New volunteers",
    description:
      "Two new volunteers booked for orientation, viewed by another new volunteer.",
    medics: 0,
    outreach: 0,
    newcomers: 2,
    orientation: true,
    newViewer: true,
  },
  {
    id: "one-left",
    label: "One spot left",
    description:
      "Two medics, three outreach volunteers and two new volunteers.",
    medics: 2,
    outreach: 3,
    newcomers: 2,
    orientation: true,
  },
  {
    id: "registered",
    label: "Already registered",
    description: "The viewer is registered and can try unregistering locally.",
    medics: 2,
    outreach: 1,
    newcomers: 2,
    orientation: true,
    registered: true,
  },
  {
    id: "empty",
    label: "No registrations yet",
    description: "An empty patrol with eight total volunteer spots.",
    medics: 0,
    outreach: 0,
    newcomers: 0,
  },
];

export function createEventCardFixture(
  scenarioId: string | null,
  registeredOverride?: boolean,
  now = Date.now(),
) {
  const scenario =
    eventCardScenarios.find(({ id }) => id === scenarioId) ??
    eventCardScenarios[0];
  const actor: Actor = {
    id: "ui-event-viewer",
    name: "Morgan Park",
    sessionId: "ui-fictional-session",
    role: "volunteer",
    twoFactorEnabled: false,
    twoFactorVerified: false,
    applicationSubmitted: true,
    applicationComplete: true,
    naloxoneCompleted: true,
    active: true,
    applicationApproved: true,
    patrolApproved: !scenario.newViewer,
  };
  const eventId = `ui-event-${scenario.id}`;
  const publicRoster: PublicRosterRow[] = [];
  const addPeople = (
    category: PublicRosterRow["category"],
    names: string[],
    count: number,
  ) => {
    publicRoster.push(
      ...names.slice(0, count).map((name, index) => ({
        eventId,
        name,
        category,
        medicMark: Number(
          category === "medic" || (category === "new-volunteer" && index === 0),
        ),
      })),
    );
  };
  addPeople("medic", ["Alex C.", "Priya S."], scenario.medics);
  addPeople(
    "outreach-volunteer",
    ["Jordan L.", "Sam R.", "Taylor M."],
    scenario.outreach,
  );
  addPeople(
    "new-volunteer",
    ["Avery K.", "Noor H.", "Casey W.", "Robin D."],
    scenario.newcomers,
  );

  // Relative dates keep these examples upcoming even after a long-lived checkout.
  const event: EventRow = {
    id: eventId,
    type: scenario.orientation ? "orientation" : "patrol",
    includesOrientation: Number(Boolean(scenario.orientation)),
    seriesId: null,
    occurrenceDate: null,
    inSignupWindow: 1,
    startsAt: now + 7 * 24 * 60 * 60 * 1000,
    meetingPoint: "Community outreach hub",
    meetingPointUrl: null,
    spots: 8,
    open: 1,
    hidden: 0,
    cancelledAt: null,
    updatedAt: now,
    confirmed: publicRoster.length,
    newVolunteerConfirmed: scenario.newcomers,
    medicConfirmed: scenario.medics,
    medicEligible: 0,
    orientationCompleted: Number(!scenario.newViewer),
    availableSpots: 0,
    futureConfirmed: publicRoster.length,
    futureEditableConfirmed: publicRoster.length,
    signedUp: 0,
    orientationSignupBlocked: 0,
  };
  const requested = registeredOverride ?? Boolean(scenario.registered);
  const blocked = eventSignupBlockReason(
    actor,
    {
      ...event,
      startsAt: new Date(event.startsAt),
      open: true,
      orientationSignupBlocked: false,
    },
    event.confirmed,
    new Date(now),
  );
  if (requested && !blocked) {
    publicRoster.push({
      eventId,
      name: "Morgan P.",
      category: scenario.newViewer ? "new-volunteer" : "outreach-volunteer",
      medicMark: 0,
    });
    event.signedUp = 1;
    event.confirmed++;
    event.newVolunteerConfirmed += Number(Boolean(scenario.newViewer));
  }
  event.availableSpots = availableSignupSpots(event, event.confirmed, actor);
  event.futureConfirmed = event.confirmed;
  event.futureEditableConfirmed = event.confirmed;
  return { scenario, actor, event, publicRoster };
}
