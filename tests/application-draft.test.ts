import assert from "node:assert/strict";
import { test } from "vitest";
import {
  applicationDraftAnswersSchema,
  applicationDraftWriteSchema,
  draftProfileValues,
  localApplicationDraftSchema,
  sameDraftAnswers,
} from "../src/data/application-draft";
import {
  birthDateDraftValue,
  birthDateParts,
  canonicalBirthDate,
} from "../src/data/application-birth-date";

test("drafts accept unfinished answers without trimming, date checks, or consent", () => {
  const answers = applicationDraftAnswersSchema.parse({
    firstName: "  Still typing ",
    phone: "bad phone",
    birthDate: "2020-01-01",
    motivation: "word ".repeat(200),
    teams: ["outreach", "medic"],
  });
  assert.equal(answers.firstName, "  Still typing ");
  assert.equal(answers.emergencyName, "");
  assert.deepEqual(answers.certifications, []);
  assert.deepEqual(answers.training, []);
  assert.deepEqual(
    applicationDraftAnswersSchema.parse({ training: ["none"] }).training,
    ["none"],
  );
  assert.equal("codeOfConductAccepted" in answers, false);
  assert.equal(draftProfileValues(answers).certification, "");
  assert.equal(sameDraftAnswers(answers, { ...answers }), true);
  assert.equal(sameDraftAnswers(answers, { ...answers, phone: "" }), false);
  for (const value of [
    "",
    "1995-04-12",
    '["23","","19"]',
    '["010","4","1990"]',
  ]) {
    const parts = birthDateParts(value);
    const restored = applicationDraftAnswersSchema.parse({
      birthDate: birthDateDraftValue(parts),
    });
    assert.deepEqual(birthDateParts(restored.birthDate), parts);
  }
  assert.equal(
    canonicalBirthDate({ day: "3", month: "4", year: "1990" }),
    "1990-04-03",
  );
});

test("drafts reject consent, unexpected fields, invalid types and oversized answers", () => {
  for (const input of [
    { codeOfConductAccepted: true },
    { userId: "someone-else" },
    { phone: 123 },
    { teams: ["organizer"] },
    { teams: ["medic", "medic"] },
    { certifications: ["unknown"] },
    { training: ["none", "other"] },
    { firstName: "a".repeat(201) },
    { medicalConditions: "a".repeat(2001) },
    { motivation: "a".repeat(16_385) },
  ])
    assert.equal(applicationDraftAnswersSchema.safeParse(input).success, false);
  assert.equal(
    applicationDraftWriteSchema.safeParse({ userId: "alice", answers: {} })
      .success,
    false,
  );
  assert.equal(
    localApplicationDraftSchema.safeParse({ version: 999, answers: {} })
      .success,
    false,
  );
});
