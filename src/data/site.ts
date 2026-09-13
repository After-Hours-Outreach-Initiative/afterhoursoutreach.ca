export const navLinks = [
  { label: "About", href: "/about" },
  { label: "Volunteer", href: "/volunteer" },
];

// The donation section lives on the home page, so it needs an absolute path to
// work from /about and /volunteer as well.
export const donateHref = "/#support";

// Flip to true once we can actually take donations; until then the Donate
// buttons stay hidden and the home page says donations are coming.
export const donationsOpen = false;

export const volunteerFormUrl =
  "https://docs.google.com/forms/d/e/1FAIpQLSemPid9VlWAo_PLKflV8goYkCiWQvbH5Glmt76RHbWRHBT15g/viewform";

export const contactEmail = "ivan.zheng@afterhoursoutreach.ca";

export const social = {
  instagram: "https://www.instagram.com/afterhoursoutreach",
  discord: "https://discord.gg/USGaTjNMM4",
};
