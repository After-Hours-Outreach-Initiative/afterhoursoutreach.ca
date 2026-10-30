export interface PersonName {
  firstName?: string | null;
  lastName?: string | null;
  preferredName?: string | null;
}

/** Display only; never change the underlying profile or submitted answers. */
export function personDisplayName(
  answers?: PersonName | null,
  legacyName = "",
  fallback = "",
): string {
  const given =
    answers?.preferredName?.trim() || answers?.firstName?.trim() || "";
  const surname = answers?.lastName?.trim() || "";
  if (given || surname)
    return [given, surname ? `${Array.from(surname)[0]}.` : ""]
      .filter(Boolean)
      .join(" ");

  const parts = legacyName.trim().split(/\s+/u).filter(Boolean);
  if (!parts.length) return fallback;
  return parts.length > 1
    ? `${parts[0]} ${Array.from(parts.at(-1)!)[0]}.`
    : parts[0];
}

const nameSegments = new Intl.Segmenter("en", { granularity: "grapheme" });

/** Compact presentation of an already standardized name, not a stored value. */
export function compactPersonDisplayName(name: string): string {
  // Recognize only the final surname initial; multiword given names stay intact.
  const suffix = name.match(/\s+(\S+\.)$/u);
  const initial = suffix?.[1];
  const hasInitial =
    initial && Array.from(nameSegments.segment(initial)).length === 2;
  const given = hasInitial ? name.slice(0, suffix!.index) : name;
  const segments = Array.from(
    nameSegments.segment(given),
    ({ segment }) => segment,
  );
  if (segments.length <= 20) return name;
  return `${segments.slice(0, 20).join("").trimEnd()}…${hasInitial ? suffix![0] : ""}`;
}
