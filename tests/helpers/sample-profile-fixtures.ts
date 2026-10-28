import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import type { SubmittedApplication } from "../../src/data/application";
import { codeOfConductVersion } from "../../src/data/code-of-conduct";
import { profileSchema } from "../../src/server/db/profiles";

export function assertCompleteSampleProfiles(db: DatabaseSync, now: number) {
  const rows = db
    .prepare(
      "SELECT p.*, u.email FROM profile p JOIN user u ON u.id = p.user_id",
    )
    .all();
  assert.equal(rows.length, 6);
  const phones = new Set();
  for (const row of rows) {
    const snapshot = JSON.parse(
      String(row.submitted_application),
    ) as SubmittedApplication;
    assert.deepEqual(profileSchema.parse(snapshot.answers), snapshot.answers);
    assert.deepEqual(
      [
        snapshot.version,
        snapshot.email,
        snapshot.submittedAt,
        snapshot.codeOfConductVersion,
        snapshot.codeOfConductAcceptedAt,
        row.code_of_conduct_version,
        row.code_of_conduct_accepted_at,
        row.registered_at,
      ],
      [
        1,
        row.email,
        new Date(now).toISOString(),
        codeOfConductVersion,
        new Date(now).toISOString(),
        codeOfConductVersion,
        now,
        now,
      ],
    );
    assert.deepEqual(
      [
        row.first_name,
        row.middle_names,
        row.last_name,
        row.heard_about_us_sources,
        row.expired_first_aid_details,
        row.crisis_intervention_details,
      ],
      [
        snapshot.answers.firstName,
        snapshot.answers.middleNames,
        snapshot.answers.lastName,
        JSON.stringify(snapshot.answers.heardAboutUsSources),
        snapshot.answers.expiredFirstAidDetails,
        snapshot.answers.crisisInterventionDetails,
      ],
    );
    phones.add(row.phone);
    phones.add(row.emergency_contact_phone);
    if (snapshot.answers.teams.includes("medic"))
      assert.ok(
        snapshot.answers.certificationExpiry >
          new Date(now).toISOString().slice(0, 10),
      );
  }
  assert.equal(phones.size, 12);
  assert.equal(
    rows.filter((row) => JSON.parse(String(row.teams)).includes("medic"))
      .length,
    2,
  );
}
