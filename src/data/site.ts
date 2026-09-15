// Flip to false if we ever stop taking donations; the Donate link in the nav
// and footer follows this.
export const donationsOpen = true;

export const donateHref = "/donate";

export const navLinks = [
  { label: "About", href: "/about" },
  { label: "Volunteer", href: "/volunteer" },
  ...(donationsOpen ? [{ label: "Donate", href: donateHref }] : []),
];

export const gofundmeUrl = "https://gofund.me/4547012cb";

export const volunteerFormUrl =
  "https://docs.google.com/forms/d/e/1FAIpQLSemPid9VlWAo_PLKflV8goYkCiWQvbH5Glmt76RHbWRHBT15g/viewform";

export const contactEmail = "info@afterhoursoutreach.ca";

export const social = {
  instagram: "https://www.instagram.com/afterhoursoutreach",
  discord: "https://discord.gg/USGaTjNMM4",
};
