// Flip to false if we ever stop taking donations; the Donate link in the nav
// and footer follows this.
export const donationsOpen = true;

export const donateHref = "/donate";

export const navLinks = [
  { label: "Volunteer", href: "/volunteer" },
  ...(donationsOpen ? [{ label: "Donate", href: donateHref }] : []),
  { label: "About", href: "/about" },
];

interface NavigationLink {
  label: string;
  href: string;
  children?: { label: string; href: string }[];
}

export function siteNavigation(
  signedIn: boolean,
  organizer = false,
  eventAccess = false,
): NavigationLink[] {
  return navLinks.flatMap((link) =>
    signedIn && link.href === "/volunteer"
      ? [
          eventAccess ? { label: "Events", href: "/events" } : link,
          ...(organizer
            ? [
                {
                  label: "Manage",
                  href: "/manage/events",
                  children: [
                    { label: "Events", href: "/manage/events" },
                    { label: "Applications", href: "/manage/applications" },
                    { label: "Volunteers", href: "/manage/volunteers" },
                  ],
                },
              ]
            : []),
        ]
      : [link],
  );
}

export const gofundmeUrl = "https://gofund.me/4547012cb";

export const volunteerFormUrl =
  "https://docs.google.com/forms/d/e/1FAIpQLSemPid9VlWAo_PLKflV8goYkCiWQvbH5Glmt76RHbWRHBT15g/viewform";

export const contactEmail = "info@afterhoursoutreach.ca";

export const contactPhone = "604-690-4687";

export const social = {
  instagram: "https://www.instagram.com/afterhoursoutreach",
  discord: "https://discord.gg/USGaTjNMM4",
  linkedin: "https://www.linkedin.com/company/after-hours-outreach-initiative",
  facebook:
    "https://www.facebook.com/people/After-Hours-Outreach-Initiative/61594451129497/",
};
