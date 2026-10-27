import {
  savedTeamOptions,
  certificationOptions,
  profileFormSections,
  trainingOptions,
  experienceOptions,
  type ApplicationAnswers,
} from "./application";

interface ProfileAnswer {
  name: keyof ApplicationAnswers;
  label: string;
  value: string | string[];
  hidden?: boolean;
  wide?: boolean;
}

/** The same saved-answer rows drive server output and in-place save updates. */
export function profileAnswerRows(
  section: ReturnType<typeof profileFormSections>[number],
  answers?: Partial<ApplicationAnswers> | null,
): ProfileAnswer[] {
  const medic = answers?.teams?.includes("medic") ?? false;
  const choices = (
    name: "teams" | "certifications" | "training" | "relevantExperience",
    label: string,
    options: readonly { value: string; label: string }[],
    hidden = false,
  ): ProfileAnswer => ({
    name,
    label,
    value: (answers?.[name] ?? []).map(
      (value) =>
        options.find((option) => option.value === value)?.label ?? value,
    ),
    hidden,
    wide: true,
  });
  if (section.key === "team-interests")
    return [choices("teams", "Teams", savedTeamOptions)];

  const rows: ProfileAnswer[] = section.fields
    .filter(
      (field) =>
        !["experience", "otherTraining", "otherExperience"].includes(
          field.name,
        ),
    )
    .map((field) => ({
      name: field.name,
      label: field.label,
      value: answers?.[field.name] ?? "",
      hidden: field.name === "certificationExpiry" && !medic,
      wide: "multiline" in field,
    }));
  if (section.key === "training-and-safety")
    return [
      choices(
        "certifications",
        "Highest medical certification or licence",
        certificationOptions,
        !medic,
      ),
      {
        name: "experience",
        label: "Other training and experience",
        value: answers?.experience ?? "",
        hidden: !medic || !answers?.certifications?.includes("other"),
        wide: true,
      },
      ...rows,
      choices("training", "Relevant training", trainingOptions),
      {
        name: "otherTraining",
        label: "Other relevant training",
        value: answers?.otherTraining ?? "",
        hidden: !answers?.training?.includes("other"),
        wide: true,
      },
      choices("relevantExperience", "Relevant experience", experienceOptions),
      {
        name: "otherExperience",
        label: "Other relevant experience",
        value: answers?.otherExperience ?? "",
        hidden: !answers?.relevantExperience?.includes("other"),
        wide: true,
      },
    ];
  return rows;
}
