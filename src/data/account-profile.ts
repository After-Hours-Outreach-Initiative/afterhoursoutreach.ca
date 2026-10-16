import {
  applicationTeamOptions,
  certificationOptions,
  profileFields,
  profileIdentityFields,
  trainingOptions,
  type ApplicationAnswers,
} from "./application";

export function profileSummaryRows(values: Partial<ApplicationAnswers>) {
  const medic = values.teams?.includes("medic") ?? false;
  const choices = (
    options: readonly { value: string; label: string }[],
    selected: string[] = [],
  ) =>
    options
      .filter((option) => selected.includes(option.value))
      .map((option) => option.label);
  const editableFields = profileFields.filter(
    (field) => !profileIdentityFields.includes(field.name),
  );
  const fields = editableFields.map((field) => {
    const value = String(values[field.name] ?? "").trim();
    return {
      name: field.name,
      section: field.section,
      label: field.label,
      value:
        value && "type" in field && field.type === "date"
          ? new Intl.DateTimeFormat("en-CA", {
              dateStyle: "long",
              timeZone: "UTC",
            }).format(new Date(`${value}T00:00:00Z`))
          : value || "Not provided",
      hidden:
        field.name === "certificationExpiry"
          ? !medic
          : field.name === "experience"
            ? !medic || !values.certifications?.includes("other")
            : field.name === "otherTraining"
              ? !values.training?.includes("other")
              : false,
    };
  });
  return [
    ...fields.filter((field) => field.section !== "training-and-safety"),
    {
      name: "teams",
      section: "team-interests",
      label: "Teams",
      value: choices(applicationTeamOptions, values.teams),
      hidden: false,
    },
    {
      name: "certifications",
      section: "training-and-safety",
      label: "Highest medical certification or licence",
      value: choices(certificationOptions, values.certifications),
      hidden: !medic,
    },
    ...fields.filter((field) =>
      ["certificationExpiry", "experience"].includes(field.name),
    ),
    {
      name: "training",
      section: "training-and-safety",
      label: "Relevant training and experience",
      value: choices(trainingOptions, values.training),
      hidden: false,
    },
    ...fields.filter((field) => field.name === "otherTraining"),
  ];
}
