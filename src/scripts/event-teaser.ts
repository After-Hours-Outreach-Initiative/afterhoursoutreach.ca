interface EventSummary {
  id: string;
  type: "patrol" | "orientation";
  startsAt: number;
  meetingPoint: string;
}
const root = document.querySelector<HTMLElement>("[data-live-event-teaser]");
async function renderEvents(root: HTMLElement) {
  const loading = root.querySelector<HTMLElement>("[data-events-loading]")!;
  try {
    const response = await fetch("/api/v1/events", {
      credentials: "same-origin",
    });
    if (response.status === 401 || response.status === 403) {
      loading.textContent =
        response.status === 401
          ? "Sign in with an approved volunteer account to view upcoming events."
          : "Event access requires an active, approved application. Visit the events page to check your account.";
      return;
    }
    if (!response.ok) throw new Error("Unavailable events");
    const { events } = (await response.json()) as { events: EventSummary[] };
    if (!events.length) {
      loading.textContent =
        "No upcoming events are scheduled. Check back soon.";
      return;
    }
    const format = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Vancouver",
      dateStyle: "full",
      timeStyle: "short",
    });
    const list = document.createElement("ul");
    list.className = "flex flex-col gap-4";
    for (const event of events.slice(0, 3)) {
      const item = document.createElement("li");
      item.className =
        "flex flex-wrap items-center justify-between gap-6 rounded-lg border border-zinc-700 px-6 py-5";
      const info = document.createElement("div");
      const heading = document.createElement("h3");
      heading.className = "text-xl";
      heading.textContent = `${event.type === "patrol" ? "Patrol" : "Orientation"} · ${format.format(new Date(event.startsAt))}`;
      const location = document.createElement("p");
      location.className = "mt-2 text-base text-zinc-400";
      location.textContent = event.meetingPoint;
      const link = document.createElement("a");
      link.href = "/events";
      link.className = "btn btn-outline";
      link.textContent = "View event";
      info.appendChild(heading);
      info.appendChild(location);
      item.appendChild(info);
      item.appendChild(link);
      list.appendChild(item);
    }
    loading.hidden = true;
    root.appendChild(list);
  } catch {
    loading.textContent =
      "Events are temporarily unavailable. Try the events page again shortly.";
  }
}
if (root) void renderEvents(root);
