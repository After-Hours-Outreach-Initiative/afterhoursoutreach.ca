import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "vitest";
import {
  accessRegistrationCancelledEmail,
  accessRegistrationCancelledTemplate,
  applicationRejectedEmail,
  applicationApprovedNoticeEmail,
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
import { emailHtmlSql, emailTextSql } from "../src/server/db/email-text";
import { contactEmail } from "../src/data/site";
import { formatEventDate } from "../src/data/event-time";

const origin = "https://example.invalid";
const event: EmailEvent = {
  type: "patrol",
  includesOrientation: 1,
  startsAt: Date.parse("2026-11-07T03:00:00Z"),
  meetingPoint: "Sample volunteer's meeting point",
};

const seriesEvent = { startsAt: event.startsAt, includesOrientation: false };

test("subjects omit the organization name already shown by the sender", () => {
  const messages = [
    signInEmailContent({ code: "123456", url: "", purpose: "change-email" }),
    accessRegistrationCancelledEmail(event.startsAt, true),
    volunteerAccessEmail(
      { active: true, applicationApproved: true, patrolApproved: true },
      ["patrolApproved"],
    ),
    roleChangedEmail("organizer"),
    eventChangedEmail(event),
    eventCancelledEmail(event, ""),
    registrationChangedEmail(event, event, ""),
    registrationChangedEmail(event, null, ""),
    patrolSeriesShortenedEmail(seriesEvent),
    patrolSeriesChangedEmail({ ...seriesEvent, meetingPoint: "Sample" }),
    patrolSeriesStoppedEmail("", seriesEvent),
  ];
  assert.deepEqual(
    messages.map(({ subject }) => subject),
    [
      "123456 is your email change code",
      "Your registration for Fri, Nov 6 was cancelled",
      "You're approved for patrols",
      "You're now an organizer",
      "Your event on Fri, Nov 6 changed",
      "Your event on Fri, Nov 6 was cancelled",
      "Your registration moved to Fri, Nov 6",
      "Your registration for Fri, Nov 6 was removed",
      "Your event on Fri, Nov 6 was cancelled",
      "Your event on Fri, Nov 6 changed",
      "Your event on Fri, Nov 6 was cancelled",
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
  assert.match(change.html!, /654321/);
  assert.ok(!change.html!.includes(url));
  assert.ok(!change.text.includes(url));
  assert.match(change.text, /654321/);
});

test("application approval messages follow account and patrol status", () => {
  for (const active of [true, false]) {
    for (const applicationApproved of [true, false]) {
      for (const patrolApproved of [true, false]) {
        const status = { active, applicationApproved, patrolApproved };
        const content = volunteerAccessEmail(status, ["applicationApproved"]);
        assert.ok(content.html?.includes("<h1"));
        assert.equal(
          content.text.includes(
            `Contact an organizer at ${contactEmail} to restore access.`,
          ),
          !active,
        );
        if (applicationApproved) {
          assert.equal(
            content.subject,
            "Your volunteer application is approved",
          );
          assert.match(
            content.text,
            /^An organizer approved your volunteer application\./,
          );
          assert.equal(content.action, active ? undefined : "none");
          if (active)
            assert.ok(
              content.text.endsWith(
                patrolApproved
                  ? "You can register for any upcoming patrol with open spots."
                  : "You can register for any upcoming orientation patrol with open spots.",
              ),
            );
          const delivered = eventNotificationEmail(content, origin);
          assert.equal(
            delivered.html?.includes(`href="${origin}/events"`),
            active,
          );
        } else {
          assert.equal(
            content.subject,
            "Your volunteer application approval was revoked",
          );
          assert.match(content.text, /^Your application is awaiting/);
          assert.match(content.text, /separate email for each\.$/);
          assert.deepEqual(content.action, {
            label: "View application",
            path: "/volunteer",
          });
        }
      }
    }
  }
});

test("access messages describe the change that was made", () => {
  const approved = { active: true, applicationApproved: true };
  const cases = [
    [
      { ...approved, patrolApproved: true },
      ["patrolApproved"],
      "You're approved for patrols",
      /^You can now register for any upcoming patrol/,
      undefined,
    ],
    [
      { ...approved, patrolApproved: false },
      ["patrolApproved"],
      "Your patrol approval was revoked",
      /^Reason: Sample reason\n\nYou can still register for any upcoming orientation patrol.*separate email for each\.$/,
      undefined,
    ],
    [
      { ...approved, active: false, patrolApproved: true },
      ["active"],
      "Your volunteer account is inactive",
      /^You can't register for events.*restore access\.\n\nAny upcoming registrations were cancelled/,
      "none",
    ],
    [
      { ...approved, active: false, patrolApproved: true },
      ["patrolApproved"],
      "You're approved for patrols",
      /^Your volunteer account is inactive, so you can't register/,
      "none",
    ],
    [
      { ...approved, patrolApproved: false },
      ["active"],
      "Your volunteer account is active again",
      /^You can register for any upcoming orientation patrol with open spots\.$/,
      undefined,
    ],
    [
      { ...approved, patrolApproved: true },
      ["active", "patrolApproved"],
      "Your volunteer account is active again",
      /^You can register for any upcoming patrol with open spots\.$/,
      undefined,
    ],
    [
      { active: true, applicationApproved: false, patrolApproved: false },
      ["active"],
      "Your volunteer account is active again",
      /^Your application is awaiting organizer approval\.$/,
      { label: "View application", path: "/volunteer" },
    ],
  ] as const;
  for (const [status, changed, subject, text, action] of cases) {
    const content = volunteerAccessEmail(
      status,
      changed,
      undefined,
      subject === "Your patrol approval was revoked"
        ? "Sample reason"
        : undefined,
    );
    assert.equal(content.subject, subject);
    assert.match(content.text, text);
    assert.deepEqual(content.action, action);
    assert.doesNotMatch(content.text, /Naloxone|Account: /);
  }
});

test("event messages list date and type, optional reasons and delivery footer", () => {
  const withoutOrientation = { ...event, includesOrientation: 0 };
  const first = formatEventDate(event.startsAt);
  const second = formatEventDate(event.startsAt + 7 * 86_400_000);
  const changed = eventChangedEmail(event);
  assert.equal(changed.subject, "Your event on Fri, Nov 6 changed");
  assert.equal(
    changed.text,
    `Date: ${first}\nEvent type: Orientation + Patrol\nMeeting point: ${event.meetingPoint}\n\nYour spot is still reserved.`,
  );
  assert.match(
    eventChangedEmail(withoutOrientation).text,
    /^Date: .*\nEvent type: Patrol\n/,
  );
  const cancelled = eventCancelledEmail(event, "Sample reason");
  assert.equal(cancelled.subject, "Your event on Fri, Nov 6 was cancelled");
  assert.equal(
    cancelled.text,
    `Date: ${first}\nEvent type: Orientation + Patrol\nReason: Sample reason\n\nAn organizer cancelled this event.`,
  );
  const removed = registrationChangedEmail(event, null, "");
  assert.equal(removed.subject, "Your registration for Fri, Nov 6 was removed");
  assert.equal(
    removed.text,
    `Date: ${first}\nEvent type: Orientation + Patrol\n\nAn organizer removed your registration.`,
  );
  const next = {
    ...withoutOrientation,
    startsAt: event.startsAt + 7 * 86_400_000,
    meetingPoint: "Next meeting point",
  };
  const moved = registrationChangedEmail(event, next, "Sample reason");
  assert.equal(
    patrolSeriesShortenedEmail(seriesEvent).text,
    `Date: ${first}\nEvent type: Patrol\n\nThis recurring patrol now ends earlier, so this event and your registration were cancelled.`,
  );
  assert.equal(
    patrolSeriesStoppedEmail("Sample reason", seriesEvent).text,
    `Date: ${first}\nEvent type: Patrol\nReason: Sample reason\n\nThis recurring patrol was stopped, so this event and your registration were cancelled.`,
  );
  assert.equal(
    patrolSeriesStoppedEmail("Sample reason").text,
    "Reason: Sample reason\n\nThis recurring patrol was stopped, so this event and your registration were cancelled.",
  );
  assert.equal(moved.subject, "Your registration moved to Fri, Nov 13");
  assert.equal(
    moved.text,
    `New event\nDate: ${second}\nEvent type: Patrol\nMeeting point: Next meeting point\n\nPrevious event\nDate: ${first}\nEvent type: Orientation + Patrol\n\nReason: Sample reason\n\nAn organizer moved your registration.`,
  );
  for (const reason of ["", "Sample reason"]) {
    for (const content of [
      eventCancelledEmail(event, reason),
      registrationChangedEmail(event, withoutOrientation, reason),
      registrationChangedEmail(event, null, reason),
      patrolSeriesStoppedEmail(reason),
      patrolSeriesStoppedEmail(reason, seriesEvent),
    ]) {
      const delivered = eventNotificationEmail(content, origin);
      assert.equal(
        delivered.text,
        `${content.text}\n\nEvents: ${origin}/events`,
      );
      assert.equal(delivered.text.includes("Reason:"), Boolean(reason));
      assert.ok(delivered.html?.includes(`href="${origin}/events"`));
    }
  }
});

test("SQL-composed messages match pure formatting, including escaped HTML", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const values = {
      applicant: "Sample O'Neil & <tag>\r\n{{reviewUrl}}",
      reviewUrl: `${origin}/applications/sample#test&value="'`,
    };
    const submissionSql = emailTextSql(applicationSubmittedTemplate.text, {
      applicant: "replace(replace(?,char(13),' '),char(10),' ')",
      reviewUrl: "?",
    });
    const submission = db
      .prepare(`SELECT ${submissionSql} AS text`)
      .get(values.applicant, values.reviewUrl);
    assert.equal(submission?.text, applicationSubmittedEmail(values).text);
    const submissionHtmlSql = emailHtmlSql(applicationSubmittedTemplate.html, {
      applicant: "replace(replace(?,char(13),' '),char(10),' ')",
      reviewUrl: "?",
    });
    const submissionHtml = db
      .prepare(`SELECT ${submissionHtmlSql} AS html`)
      .get(values.applicant, values.reviewUrl);
    assert.equal(submissionHtml?.html, applicationSubmittedEmail(values).html);
    assert.match(String(submissionHtml?.html), /O&#39;Neil &amp; &lt;tag&gt;/);
    assert.match(String(submissionHtml?.html), /#test&amp;value=&quot;&#39;/);

    const cancellationSql = emailTextSql(
      accessRegistrationCancelledTemplate.text,
      {
        eventType: "CASE WHEN ? THEN 'Orientation + Patrol' ELSE 'Patrol' END",
      },
    );
    for (const includesOrientation of [true, false]) {
      const cancellation = db
        .prepare(`SELECT ${cancellationSql} AS text`)
        .get(Number(includesOrientation));
      // The undated fallback ends exactly like the dated message.
      assert.ok(
        accessRegistrationCancelledEmail(
          event.startsAt,
          includesOrientation,
        ).text.endsWith(String(cancellation?.text)),
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

test("role, series and medic notifications include HTML and plain text", () => {
  const messages = [
    roleChangedEmail("organizer"),
    roleChangedEmail("volunteer"),
    patrolSeriesChangedEmail(),
    patrolSeriesShortenedEmail(),
    medicCertificationEmail("warning", "2026-11-15", origin),
    medicCertificationEmail("expired", "2026-10-20", origin),
  ];
  for (const content of messages) {
    assert.ok(content.html?.includes("<h1"));
    assert.ok(content.subject);
    assert.ok(content.text);
  }
  assert.match(messages[0].text, /review applications.*sign in again/);
  assert.equal(messages[1].subject, "You're no longer an organizer");
  assert.match(messages[1].text, /now a volunteer account.*sign in again/);
  for (const content of messages.slice(0, 2))
    assert.ok(
      eventNotificationEmail(content, origin).text.endsWith(
        `Sign in: ${origin}/volunteer/sign-in`,
      ),
    );
  assert.match(messages[4].text, /stays valid through that date/);
  assert.match(messages[5].text, /expired on 2026-10-20/);
  for (const content of messages.slice(4))
    assert.ok(content.text.endsWith(`${origin}/volunteer/account`));
});

test("notification HTML escapes names, locations and organizer-provided reasons", () => {
  const untrusted = `<img src=x onerror="alert('test')"> &`;
  const messages = [
    eventCancelledEmail({ ...event, meetingPoint: untrusted }, untrusted),
    applicationRejectedEmail(untrusted),
    volunteerAccessEmail(
      { active: true, applicationApproved: true, patrolApproved: false },
      ["applicationApproved"],
      untrusted,
    ),
    volunteerAccessEmail(
      { active: true, applicationApproved: true, patrolApproved: false },
      ["patrolApproved"],
      undefined,
      untrusted,
    ),
  ];
  for (const content of messages) {
    const delivered = eventNotificationEmail(content, origin);
    assert.ok(delivered.text.includes(untrusted));
    assert.ok(!delivered.html!.includes(untrusted));
    assert.match(delivered.html!, /&lt;img src=x onerror=&quot;/);
  }
});

test("the approval notice names the applicant and links to their profile", () => {
  const content = eventNotificationEmail(
    applicationApprovedNoticeEmail({
      applicant: "Sam\nV.",
      approvedBy: "Robin O.",
      profilePath: "/volunteers/sample",
    }),
    origin,
  );
  assert.equal(content.subject, "Volunteer application from Sam V. approved");
  assert.equal(
    content.text,
    `Applicant: Sam V.\nApproved by: Robin O.\n\nView profile: ${origin}/volunteers/sample`,
  );
  assert.ok(content.html?.includes(`href="${origin}/volunteers/sample"`));
  assert.ok(!content.html?.includes("/events"));
});

test("the rejection shows the reason and links to the application", () => {
  const content = eventNotificationEmail(
    applicationRejectedEmail("Sample reason"),
    origin,
  );
  assert.equal(
    content.text,
    `Reason: Sample reason\n\nIf you have questions, contact ${contactEmail}.\n\nView application: ${origin}/volunteer`,
  );
  assert.ok(content.html?.includes(`href="${origin}/volunteer"`));
});

test("medic certification emails carry the expiry date in the subject and bold in the body", () => {
  const expiring = medicCertificationEmail("warning", "2026-11-15", origin);
  assert.equal(
    expiring.subject,
    "Your medic certification expires on 2026-11-15",
  );
  assert.ok(expiring.html?.includes("<strong>2026-11-15</strong>"));
  assert.equal(
    expiring.text,
    `Your medic certification expires on 2026-11-15. It stays valid through that date.\n\nIf you've already renewed it or the date is wrong, update it in your account.\n\nYour account: ${origin}/volunteer/account`,
  );
  const expired = medicCertificationEmail("expired", "2026-10-20", origin);
  assert.equal(
    expired.subject,
    "Your medic certification expired on 2026-10-20",
  );
  assert.ok(expired.html?.includes("<strong>2026-10-20</strong>"));
  assert.ok(
    expired.html?.includes("Your medic certification has expired</h1>"),
  );
});
