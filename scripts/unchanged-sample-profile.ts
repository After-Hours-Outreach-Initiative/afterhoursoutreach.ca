import type { sampleProfileFixtures } from "./sample-profile-fixtures";

const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;

/** Exact seed fingerprint, including the immutable snapshot and every answer. */
export function unchangedSampleProfileSql(
  person: ReturnType<typeof sampleProfileFixtures>[number],
  certificationExpirySql?: string,
  legacyTrainingDetails = false,
) {
  const a = person.answers;
  const original = {
    first_name: a.firstName,
    middle_names: a.middleNames,
    last_name: a.lastName,
    preferred_name: a.preferredName,
    pronouns: a.pronouns,
    phone: a.phone,
    birth_date: a.birthDate,
    emergency_contact_name: a.emergencyName,
    emergency_contact_phone: a.emergencyPhone,
    emergency_contact_relationship: a.emergencyRelationship,
    heard_about_us: a.heardAboutUs,
    heard_about_us_sources: JSON.stringify(a.heardAboutUsSources),
    heard_about_us_other: a.heardAboutUsOther,
    motivation: a.motivation,
    teams: JSON.stringify(a.teams),
    medical_certification: a.certification,
    medical_certifications: JSON.stringify(a.certifications),
    training_experience: a.experience,
    relevant_training: JSON.stringify(a.training),
    other_training: a.otherTraining,
    expired_first_aid_details: a.expiredFirstAidDetails,
    crisis_intervention_details: a.crisisInterventionDetails,
    relevant_experience: JSON.stringify(a.relevantExperience),
    other_experience: a.otherExperience,
    medical_conditions: a.medicalConditions,
  };
  const expiry = certificationExpirySql ?? quote(a.certificationExpiry);
  const answers = certificationExpirySql
    ? `json_set(${quote(JSON.stringify(a))}, '$.certificationExpiry', ${expiry})`
    : quote(JSON.stringify(a));
  const savedAnswers = "json_extract(p.submitted_application, '$.answers')";
  // Older seeds predate these two optional fields. Only their absent/empty
  // forms are equivalent; a meaningful answer still prevents cleanup.
  const snapshotMatches = legacyTrainingDetails
    ? `json_remove(${savedAnswers}, '$.expiredFirstAidDetails', '$.crisisInterventionDetails')=json_remove(${answers}, '$.expiredFirstAidDetails', '$.crisisInterventionDetails')
      AND coalesce(json_extract(${savedAnswers}, '$.expiredFirstAidDetails'), '')=${quote(a.expiredFirstAidDetails)}
      AND coalesce(json_extract(${savedAnswers}, '$.crisisInterventionDetails'), '')=${quote(a.crisisInterventionDetails)}`
    : `${savedAnswers}=${answers}`;
  return `(p.updated_at=p.registered_at AND json_valid(p.submitted_application)
    AND json_array(${Object.keys(original)
      .map((column) => `coalesce(p.${column}, '')`)
      .join(",")})=${quote(JSON.stringify(Object.values(original)))}
    AND coalesce(p.medical_certification_expiry, '')=${expiry}
    AND p.code_of_conduct_version=json_extract(p.submitted_application, '$.codeOfConductVersion')
    AND p.code_of_conduct_accepted_at=p.registered_at
    AND json_extract(p.submitted_application, '$.submittedAt')=strftime('%Y-%m-%dT%H:%M:%fZ', p.registered_at/1000.0, 'unixepoch')
    AND json_extract(p.submitted_application, '$.email')=u.email
    AND (${snapshotMatches}))`;
}
