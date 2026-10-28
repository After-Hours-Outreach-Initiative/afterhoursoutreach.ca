// Related answers form one editing unit: never combine a Medic selection with
// another device's qualifications, or an Other choice with unrelated details.
export const answerGroups = [
  ["firstName", "middleNames", "lastName"],
  ["emergencyName", "emergencyPhone", "emergencyRelationship"],
  [
    "teams",
    "certification",
    "certifications",
    "certificationExpiry",
    "experience",
  ],
  [
    "training",
    "expiredFirstAidDetails",
    "crisisInterventionDetails",
    "otherTraining",
  ],
  ["relevantExperience", "otherExperience"],
  ["heardAboutUsSources", "heardAboutUsOther"],
] as const;

export const sameAnswer = (left: unknown, right: unknown): boolean =>
  Array.isArray(left) && Array.isArray(right)
    ? JSON.stringify([...left].sort()) === JSON.stringify([...right].sort())
    : JSON.stringify(left) === JSON.stringify(right);

export function mergeAnswers<T extends object>(
  baseline: T,
  local: T,
  latest: T,
) {
  const merged = { ...local };
  const keys = Object.keys(local) as (keyof T & string)[];
  const groups: string[][] = answerGroups.map((group) => [...group]);
  for (const key of keys)
    if (!groups.some((group) => group.includes(key))) groups.push([key]);
  const conflicts: (keyof T & string)[][] = [];
  for (const fields of groups) {
    const group = fields.filter((field) =>
      keys.includes(field as keyof T & string),
    ) as (keyof T & string)[];
    if (!group.length) continue;
    const equal = (left: T, right: T) =>
      group.every((key) => sameAnswer(left[key], right[key]));
    if (equal(local, baseline)) {
      for (const key of group) merged[key] = latest[key];
    } else if (!equal(latest, baseline) && !equal(local, latest)) {
      conflicts.push(group);
    }
  }
  return { answers: merged, conflicts };
}

export function answerLabel(fields: readonly string[]) {
  return fields
    .map((field) => field.replace(/([A-Z])/g, " $1").toLowerCase())
    .join(" / ");
}
