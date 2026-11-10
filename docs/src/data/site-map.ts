export interface SiteMapNode {
  label?: string;
  path?: string;
  role?: "organizer";
  children?: SiteMapNode[];
}

export const siteMap: SiteMapNode[] = [
  {
    label: "Public information",
    children: [
      { path: "/" },
      { path: "/about" },
      { path: "/donate" },
      { path: "/privacy" },
    ],
  },
  {
    label: "Sign-in and volunteer area",
    children: [
      {
        path: "/volunteer/sign-in",
        children: [{ path: "/volunteer/sign-in/complete" }],
      },
      { path: "/volunteer" },
      { path: "/apply" },
      { path: "/volunteer/account" },
      { path: "/events" },
    ],
  },
  {
    label: "Organizer area",
    children: [
      {
        path: "/applications",
        role: "organizer",
        children: [{ path: "/applications/[id]", role: "organizer" }],
      },
      {
        path: "/volunteers",
        role: "organizer",
        children: [{ path: "/volunteers/[id]", role: "organizer" }],
      },
    ],
  },
  { path: "/404" },
];
