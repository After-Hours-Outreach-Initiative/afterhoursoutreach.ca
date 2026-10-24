import assert from "node:assert/strict";
import { test } from "vitest";
import { mergeAnswers } from "../src/data/answer-merge";
import { applicationDraftAnswersSchema } from "../src/data/application-draft";

const blank = () => applicationDraftAnswersSchema.parse({});

test("three-way merging combines different fields and identical/offline retries", () => {
  const baseline = blank();
  const local = { ...baseline, phone: "local" };
  const latest = { ...baseline, pronouns: "remote" };
  assert.deepEqual(mergeAnswers(baseline, local, latest), {
    answers: { ...local, pronouns: "remote" },
    conflicts: [],
  });
  assert.deepEqual(mergeAnswers(baseline, local, local), {
    answers: local,
    conflicts: [],
  });
});

test("same-field and dependent-field edits conflict rather than silently combine", () => {
  const baseline = blank();
  const local = {
    ...baseline,
    phone: "local",
    teams: ["medic"],
    training: ["other"],
  };
  const latest = {
    ...baseline,
    phone: "remote",
    certificationExpiry: "2030-01-01",
    otherTraining: "Remote details",
  };
  const merged = mergeAnswers(baseline, local, latest);
  assert.equal(merged.conflicts.length, 3);
  assert.ok(
    merged.conflicts.some(
      (group) =>
        group.includes("teams") && group.includes("certificationExpiry"),
    ),
  );
  assert.ok(
    merged.conflicts.some(
      (group) => group.includes("training") && group.includes("otherTraining"),
    ),
  );
  assert.equal(merged.answers.phone, "local");
});

test("a save acknowledgement rebases newer typing without marking it saved", () => {
  const attempted = { ...blank(), phone: "sent" };
  const current = { ...attempted, phone: "new typing", birthDate: "draft:1//" };
  const acknowledged = { ...attempted, pronouns: "remote" };
  const merged = mergeAnswers(attempted, current, acknowledged);
  assert.equal(merged.answers.phone, "new typing");
  assert.equal(merged.answers.birthDate, "draft:1//");
  assert.equal(merged.answers.pronouns, "remote");
  assert.deepEqual(merged.conflicts, []);
});
