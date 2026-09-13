// One button size for the whole site. Variants change colour and border only,
// so a bordered button lines up with a filled one at the same height.
const base =
  "inline-flex min-h-11 items-center justify-center gap-2.5 rounded-lg px-5 text-[15px] transition-colors";

/** Filled blue, for the main action on a page. */
export const buttonPrimary = `${base} border-2 border-blue bg-blue font-bold text-white hover:bg-blue-dark`;

/** Blue outline, for an action that sits beside the primary one. */
export const buttonOutline = `${base} border-2 border-blue font-bold text-white hover:bg-blue`;

/** Light outline, for a secondary action over a dark photo or panel. */
export const buttonSubtle = `${base} border-2 border-white/60 font-bold text-white hover:border-white hover:bg-white/10`;

/** Grey outline, for the several small controls that sit in a row together. */
export const buttonQuiet = `${base} border border-zinc-600 font-medium text-zinc-300 hover:border-white hover:text-white`;
