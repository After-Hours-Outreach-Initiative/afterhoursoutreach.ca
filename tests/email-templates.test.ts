import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "vitest";
import {
  accessRegistrationCancelledEmail,
  accessRegistrationCancelledTemplate,
  applicationSubmittedEmail,
  applicationSubmittedTemplate,
  eventCancelledEmail,
  eventChangedEmail,
  eventNotificationEmail,
  medicCertificationEmail,
  patrolSeriesChangedEmail,
  patrolSeriesShortenedEmail,
  patrolSeriesStoppedEmail,
  registrationChangedEmail,
  renderEmailText,
  roleChangedEmail,
  signInEmailContent,
  volunteerAccessEmail,
  type EmailEvent,
} from "../src/data/email-templates";
import { emailTextSql } from "../src/server/db/email-text";
import { contactEmail } from "../src/data/site";

const origin = "https://example.invalid";
const event: EmailEvent = {
  type: "patrol",
  includesOrientation: 1,
  startsAt: Date.parse("2026-11-07T03:00:00Z"),
  meetingPoint: "Sample volunteer's meeting point",
};

test("subjects omit the organization name already shown by the sender", () => {
  const messages = [
    signInEmailContent({ code: "123456", url: "", purpose: "change-email" }),
    accessRegistrationCancelledEmail(event.meetingPoint, true),
    volunteerAccessEmail(
      { active: true, applicationApproved: true, patrolApproved: true },
      false,
    ),
    roleChangedEmail("organizer"),
    eventChangedEmail(event, true),
    eventCancelledEmail(event, ""),
    registrationChangedEmail(event, event, ""),
    registrationChangedEmail(event, null, ""),
    patrolSeriesShortenedEmail(),
    patrolSeriesChangedEmail(),
    patrolSeriesStoppedEmail(""),
  ];
  assert.deepEqual(
    messages.map(({ subject }) => subject),
    [
      "Confirm your email change",
      "Your event registration was cancelled",
      "Your volunteer access changed",
      "Your account role changed",
      "Your event changed",
      "Your event was cancelled",
      "Your event registration was moved",
      "Your event registration was removed",
      "Your event was cancelled",
      "Your patrol changed",
      "Your patrol was cancelled",
    ],
  );
});

test("sign-in formatting preserves the URL fragment and escapes HTML values", () => {
  const url = `${origin}/volunteer/verify?next=events&sample=1#sample-fragment`;
  const content = signInEmailContent({ code: "<123&\"'>", url });
  assert.equal(content.subject, "<123&\"'> is your sign-in code");
  assert.ok(content.text.includes(url));
  assert.ok(content.html?.includes(`href="${url.replaceAll("&", "&amp;")}"`));
  assert.ok(content.html?.includes("&lt;123&amp;&quot;&#39;&gt;"));
  assert.match(content.text, /expire in 10 minutes/);
  assert.match(content.html!, /expire in 10 minutes/);
  const change = signInEmailContent({
    code: "654321",
    url,
    purpose: "change-email",
  });
  assert.equal(change.html, undefined);
  assert.ok(!change.text.includes(url));
  assert.match(change.text, /654321/);
});

test("approval and access messages retain the existing next-step branches", () => {
  for (const active of [true, false]) {
    for (const applicationApproved of [true, false]) {
      for (const patrolApproved of [true, false]) {
        const status = { active, applicationApproved, patrolApproved };
        for (const approvalChanged of [true, false]) {
          const content = volunteerAccessEmail(status, approvalChanged);
          assert.equal(content.html, undefined);
          if (!active) {
            assert.match(content.text, /currently inactive/);
            assert.ok(
              content.text.includes(
                `contact an organizer at ${contactEmail} to restore access`,
              ),
            );
          } else if (!applicationApproved)
            assert.match(content.text, /review your application steps/);
          else if (patrolApproved)
            assert.match(content.text, /browse upcoming patrols/);
          else
            assert.match(content.text, /Naloxone 101.*Orientation \+ Patrol/);
          assert.equal(
            content.subject,
            !approvalChanged
              ? "Your volunteer access changed"
              : applicationApproved
                ? "Your volunteer application is approved"
                : "Your volunteer application approval was revoked",
          );
        }
      }
    }
  }
});

test("event messages retain date, orientation, optional reasons and delivery footer", () => {
  assert.match(
    eventChangedEmail(event, false).text,
    /Patrol \(includes orientation\): Friday, November 6, 2026/,
  );
  assert.match(
    eventChangedEmail(event, false).text,
    /existing spot is still reserved/,
  );
  assert.match(eventChangedEmail(event, true).text, /Registration is open/);
  const withoutOrientation = { ...event, includesOrientation: 0 };
  assert.ok(
    !eventChangedEmail(withoutOrientation, true).text.includes(
      "includes orientation",
    ),
  );
  for (const reason of ["", "Sample reason"]) {
    for (const content of [
      eventCancelledEmail(event, reason),
      registrationChangedEmail(event, withoutOrientation, reason),
      registrationChangedEmail(event, null, reason),
      patrolSeriesStoppedEmail(reason),
    ]) {
      const delivered = eventNotificationEmail(content, origin);
      assert.equal(
        delivered.text,
        `${content.text}\n\nEvents: ${origin}/events`,
      );
      assert.equal(delivered.text.includes("Reason:"), Boolean(reason));
      assert.equal(delivered.html, undefined);
    }
  }
  assert.match(
    registrationChangedEmail(event, withoutOrientation, "").text,
    /moved your registration to/,
  );
  assert.match(
    registrationChangedEmail(event, null, "").text,
    /removed your registration/,
  );
});

test("SQL-composed messages and pure formatting produce identical text", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const values = {
      applicant: "Sample O'Neil\r\n{{reviewUrl}}",
      submittedAt: "2026-10-23T18:30:00.000Z",
      reviewUrl: `${origin}/manage/volunteers/sample`,
    };
    const submissionSql = emailTextSql(applicationSubmittedTemplate.text, {
      applicant: "replace(replace(?,char(13),' '),char(10),' ')",
      submittedAt: "?",
      reviewUrl: "?",
    });
    const submission = db
      .prepare(`SELECT ${submissionSql} AS text`)
      .get(values.applicant, values.submittedAt, values.reviewUrl);
    assert.equal(submission?.text, applicationSubmittedEmail(values).text);

    const cancellationSql = emailTextSql(
      accessRegistrationCancelledTemplate.text,
      {
        orientation: "CASE WHEN ? THEN ' (includes orientation)' ELSE '' END",
        meetingPoint: "?",
      },
    );
    for (const includesOrientation of [true, false]) {
      const cancellation = db
        .prepare(`SELECT ${cancellationSql} AS text`)
        .get(Number(includesOrientation), event.meetingPoint);
      assert.equal(
        cancellation?.text,
        accessRegistrationCancelledEmail(
          event.meetingPoint,
          includesOrientation,
        ).text,
      );
    }
    const literal = "It's a literal\n{{value}}";
    const compiled = emailTextSql(literal, { value: "?" });
    assert.equal(
      db.prepare(`SELECT ${compiled} AS text`).get("' OR 1=1")?.text,
      renderEmailText(literal, { value: "' OR 1=1" }),
    );
    assert.throws(
      () => emailTextSql("{{missing}}", {}),
      /Missing email SQL expression/,
    );
    assert.throws(
      () => renderEmailText("{{missing}}", {}),
      /Missing email template value/,
    );
  } finally {
    db.close();
  }
});

test("role, series and medic notifications remain plain text", () => {
  const messages = [
    roleChangedEmail("organizer"),
    roleChangedEmail("volunteer"),
    patrolSeriesChangedEmail(),
    patrolSeriesShortenedEmail(),
    medicCertificationEmail("warning", "2026-11-15", origin),
    medicCertificationEmail("expired", "2026-10-20", origin),
  ];
  for (const content of messages) {
    assert.equal(content.html, undefined);
    assert.ok(content.subject);
    assert.ok(content.text);
  }
  assert.match(messages[0].text, /role is now organizer/);
  assert.match(messages[1].text, /role is now volunteer/);
  assert.match(messages[4].text, /remains valid through that date/);
  assert.match(messages[5].text, /It is now expired/);
  for (const content of messages.slice(4))
    assert.ok(content.text.endsWith(`${origin}/volunteer/account`));
});
