import assert from "node:assert/strict";
import { test } from "vitest";
import {
  applicationDraftAnswersSchema,
  applicationDraftWriteSchema,
  draftProfileValues,
  localApplicationDraftSchema,
  sameDraftAnswers,
} from "../src/data/application-draft";

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
  assert.equal("codeOfConductAccepted" in answers, false);
  assert.equal(draftProfileValues(answers).certification, "");
  assert.equal(sameDraftAnswers(answers, { ...answers }), true);
  assert.equal(sameDraftAnswers(answers, { ...answers, phone: "" }), false);
});

test("drafts reject consent, unexpected fields, invalid types and oversized answers", () => {
  for (const input of [
    { codeOfConductAccepted: true },
    { userId: "someone-else" },
    { phone: 123 },
    { teams: ["organizer"] },
    { teams: ["medic", "medic"] },
    { certifications: ["unknown"] },
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
