import assert from "node:assert/strict";
import { profileWriteBody } from "../helpers/profile-write";
import { existsSync } from "node:fs";
import { afterAll, beforeAll, describe, test } from "vitest";
import { createTestHarness } from "wrangler";
import { chromium, expect } from "@playwright/test";
import { createAuth } from "../../src/server/auth";
import { inPlaceAction } from "../helpers/in-place-action";
import { createSignInOTP } from "../helpers/email-otp";
import { totpFromSetupKey } from "../helpers/totp";
import {
  fillApplicationField,
  reviewLocalApplication,
} from "../helpers/local-account";
import {
  latestApplicationBirthDate,
  applicationBirthDateError,
  outreachRequiredError,
  type SubmittedApplication,
} from "../../src/data/application";
import {
  codeOfConductConfirmation,
  codeOfConductError,
  codeOfConductRules,
  codeOfConductVersion,
} from "../../src/data/code-of-conduct";

const origin = "https://afterhoursoutreach.ca";
const secret = "test-only-worker-auth-secret-12345678901234567890";
const answers = {
  firstName: "Worker",
  middleNames: "Test",
  lastName: "Volunteer",
  preferredName: "Worker Test Volunteer",
  pronouns: "they/them",
  phone: "604-555-0100",
  birthDate: "1995-04-12",
  emergencyName: "Sample Contact",
  emergencyPhone: "604-555-0101",
  emergencyRelationship: "Friend",
  heardAboutUs: "A friend",
  heardAboutUsSources: ["friend-word-of-mouth"],
  heardAboutUsOther: "",
  motivation: "Sample answer",
  teams: ["outreach"],
  certification: "None",
  certifications: [] as string[],
  certificationExpiry: "",
  experience: "None",
  training: ["none"],
  otherTraining: "",
  relevantExperience: ["none"],
  otherExperience: "",
  medicalConditions: "Sample private answer",
};

// These cases intentionally share one ordered account/session workflow.
describe(
  "production-built Worker enforces authentication, ownership, CSRF and private-page protections",
  { concurrent: false, shuffle: false },
  () => {
    const server = createTestHarness({
      workers: [
        {
          configPath: "dist/server/wrangler.json",
          vars: {
            APP_ENV: "production",
            AUTH_BASE_URL: origin,
          },
          secrets: {
            BETTER_AUTH_SECRET: secret,
            RESEND_API_KEY: "",
          },
        },
      ],
    });
    let worker: ReturnType<typeof server.getWorker<Env>>;
    let DB: Env["DB"];
    let cookie: string;
    let current: { user: { id: string }; session: { id: string } };
    beforeAll(async () => {
      await server.listen();
      worker = server.getWorker<Env>();
      await worker.applyD1Migrations("DB");
      const environment = await worker.getEnv();
      DB = environment.DB;
      assert.equal(environment.AUTH_BASE_URL, origin);
      cookie = await signIn("worker-volunteer@example.org");
      current = (await (
        await send("/api/v1/auth/get-session", undefined, cookie)
      ).json()) as typeof current;
    });
    const send = async (
      path: string,
      body?: object,
      cookie?: string,
      requestOrigin = origin,
    ): ReturnType<typeof worker.fetch> => {
      if (path === "/api/v1/account/profile" && body)
        body = await profileWriteBody(
          (path) => send(path, undefined, cookie),
          body,
        );
      return worker.fetch(`${origin}${path}`, {
        method: body ? "POST" : "GET",
        headers: {
          origin: requestOrigin,
          "content-type": "application/json",
          ...(cookie ? { cookie } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        redirect: "manual",
      });
    };
    test("site origins reject unrelated, preview and forwarded-host CSRF", async () => {
      for (const host of [
        "https://evil.example.org",
        "https://other-afterhoursoutreach-ca.ivanzheng9905.workers.dev",
      ]) {
        const response = await send(
          "/api/v1/auth/email-otp/send-verification-otp",
          { email: "no-mail@example.org", type: "sign-in" },
          undefined,
          host,
        );
        assert.equal(response.status, 403);
      }
      const response = await worker.fetch(
        "https://evil.example.org/api/v1/auth/get-session",
        { headers: { "x-forwarded-host": new URL(origin).hostname } },
      );
      assert.equal(response.status, 403);
    });
    const signIn = async (email: string) => {
      const proof = await createSignInOTP(DB, secret, email);
      const response = await send("/api/v1/auth/sign-in/email-otp", proof);
      assert.equal(response.status, 200, await response.clone().text());
      return response.headers
        .getSetCookie()
        .filter((cookie) => !cookie.includes("Max-Age=0"))
        .map((cookie) => cookie.split(";")[0])
        .join("; ");
    };

    test("unauthenticated profile access is rejected and application redirects to sign-in", async () => {
      const profile = await send("/api/v1/account/profile", answers);
      assert.equal(profile.status, 401, await profile.clone().text());
      const application = await send("/apply");
      assert.equal(application.status, 302);
      assert.match(application.headers.get("location")!, /sign-in/);
      assert.equal((await send("/api/v1/auth/sign-in/email-otp")).status, 405);
      assert.equal(
        (await send("/api/v1/auth/email-otp/get-verification-otp")).status,
        404,
      );
      assert.equal(
        (await send("/api/v1/auth/email-otp/check-verification-otp", {}))
          .status,
        404,
      );
      assert.equal(
        (await send("/api/v1/auth/update-user", { name: "Attacker" })).status,
        404,
      );
      assert.equal(
        (await send("/api/v1/auth/two-factor/disable", {})).status,
        401,
      );
    });

    test("signed-out pages omit the signed-in account menu", async () => {
      for (const path of [
        "/volunteer/sign-in",
        "/volunteer/sign-in/complete",
      ]) {
        const page = await send(path);
        assert.equal(page.status, 200);
        assert.doesNotMatch(await page.text(), /data-account-menu/);
      }
    });

    test("the API validates name edits and age, preserves birth dates and original submissions", async () => {
      const ageCookie = await signIn("worker-age-boundary@example.org");
      const account = (await (
        await send("/api/v1/auth/get-session", undefined, ageCookie)
      ).json()) as typeof current;
      const cutoff = latestApplicationBirthDate();
      const younger = new Date(`${cutoff}T00:00:00Z`);
      younger.setUTCDate(younger.getUTCDate() + 1);
      const underage = younger.toISOString().slice(0, 10);
      const snapshots = async () => ({
        profile: await DB.prepare("SELECT * FROM profile WHERE user_id=?")
          .bind(account.user.id)
          .first(),
        status: await DB.prepare(
          "SELECT * FROM volunteer_status WHERE user_id=?",
        )
          .bind(account.user.id)
          .first(),
        audit: (
          await DB.prepare("SELECT * FROM audit_log WHERE subject_id=?")
            .bind(account.user.id)
            .all()
        ).results,
        user: await DB.prepare("SELECT * FROM user WHERE id=?")
          .bind(account.user.id)
          .first(),
      });
      const beforeApplication = await snapshots();
      for (const birthDate of [underage, "2999-01-01", "2005-02-29"]) {
        const response = await send(
          "/api/v1/account/profile",
          { ...answers, birthDate, codeOfConductAccepted: true },
          ageCookie,
        );
        assert.equal(response.status, 400, await response.clone().text());
        assert.equal(
          ((await response.json()) as { message: string }).message,
          applicationBirthDateError,
        );
        assert.deepEqual(await snapshots(), beforeApplication);
      }
      const application = await send(
        "/api/v1/account/profile",
        { ...answers, birthDate: cutoff, codeOfConductAccepted: true },
        ageCookie,
      );
      assert.equal(application.status, 200, await application.clone().text());
      const saved = await snapshots();
      assert.equal(saved.profile?.birth_date, cutoff);
      const { firstName, middleNames, lastName, birthDate, ...editedAnswers } =
        answers;
      for (const change of [
        { firstName: "" },
        { firstName: "a".repeat(201) },
        { middleNames: "a".repeat(201) },
        { lastName: null },
        { birthDate: underage },
        { birthDate: "1990-01-01" },
        { birthDate: "" },
      ]) {
        const rejectedEdit = await send(
          "/api/v1/account/profile",
          { ...editedAnswers, preferredName: "Rejected edit", ...change },
          ageCookie,
        );
        assert.equal(rejectedEdit.status, 400);
        if ("birthDate" in change)
          assert.deepEqual(await rejectedEdit.json(), {
            message: "Your date of birth cannot be changed from your account.",
          });
        assert.equal(rejectedEdit.headers.get("cache-control"), "no-store");
        assert.deepEqual(await snapshots(), saved);
      }
      const acceptedEdit = await send(
        "/api/v1/account/profile",
        {
          ...editedAnswers,
          firstName: " Changed ",
          middleNames: " Middle ",
          lastName: " Name ",
          preferredName: "",
        },
        ageCookie,
      );
      assert.equal(acceptedEdit.status, 200, await acceptedEdit.clone().text());
      const updated = await snapshots();
      assert.equal(updated.profile?.birth_date, cutoff);
      assert.equal(updated.profile?.first_name, "Changed");
      assert.equal(updated.profile?.middle_names, "Middle");
      assert.equal(updated.profile?.last_name, "Name");
      assert.equal(updated.user?.name, "Changed Middle Name");
      assert.equal(
        updated.profile?.submitted_application,
        saved.profile?.submitted_application,
      );
      const session = (await (
        await send("/api/v1/auth/get-session", undefined, ageCookie)
      ).json()) as { user: { name: string } };
      assert.equal(session.user.name, "Changed Middle Name");
    });

    test("applications require explicit Outreach and leave optional teams optional without rewriting legacy edits", async () => {
      const outreachCookie = await signIn(
        "worker-default-outreach@example.org",
      );
      const account = (await (
        await send("/api/v1/auth/get-session", undefined, outreachCookie)
      ).json()) as typeof current;
      const savedTeams = async () => {
        const row = await DB.prepare(
          "SELECT teams FROM profile WHERE user_id=?",
        )
          .bind(account.user.id)
          .first<{ teams: string }>();
        return row ? JSON.parse(row.teams) : null;
      };
      for (const teams of [
        undefined,
        [],
        ["medic"],
        ["non-patrol"],
        ["medic", "non-patrol"],
      ]) {
        const rejected = await send(
          "/api/v1/account/profile",
          {
            ...answers,
            teams,
            certifications: ["advanced-first-aid"],
            certificationExpiry: "2030-10-14",
            codeOfConductAccepted: true,
          },
          outreachCookie,
        );
        assert.equal(rejected.status, 400);
        assert.deepEqual(await rejected.json(), {
          message: outreachRequiredError,
        });
        assert.equal(await savedTeams(), null);
      }
      const application = await send(
        "/api/v1/account/profile",
        { ...answers, codeOfConductAccepted: true },
        outreachCookie,
      );
      assert.equal(application.status, 200, await application.clone().text());
      assert.deepEqual(await savedTeams(), ["outreach"]);
      for (const teams of [
        ["outreach"],
        ["outreach", "medic"],
        ["outreach", "non-patrol"],
        ["outreach", "medic", "non-patrol"],
      ]) {
        const edited = await send(
          "/api/v1/account/profile",
          {
            ...answers,
            teams,
            certifications: teams.includes("medic")
              ? ["advanced-first-aid"]
              : [],
            certificationExpiry: teams.includes("medic") ? "2030-10-14" : "",
          },
          outreachCookie,
        );
        assert.equal(edited.status, 200, await edited.clone().text());
        assert.deepEqual(await savedTeams(), teams);
      }
      const removed = await send(
        "/api/v1/account/profile",
        { ...answers, teams: [] },
        outreachCookie,
      );
      assert.equal(removed.status, 400);
      assert.deepEqual(await savedTeams(), ["outreach", "medic", "non-patrol"]);
      await DB.prepare("UPDATE profile SET teams='[]' WHERE user_id=?")
        .bind(account.user.id)
        .run();
      const legacy = await send(
        "/api/v1/account/profile",
        { ...answers, teams: [], preferredName: "Legacy edit" },
        outreachCookie,
      );
      assert.equal(legacy.status, 200, await legacy.clone().text());
      assert.deepEqual(await savedTeams(), []);
    });

    test("Medic application and edits require a certification expiry date", async () => {
      const expiryCookie = await signIn("worker-medic-expiry@example.org");
      const account = (await (
        await send("/api/v1/auth/get-session", undefined, expiryCookie)
      ).json()) as typeof current;
      const savedProfile = () =>
        DB.prepare("SELECT * FROM profile WHERE user_id=?")
          .bind(account.user.id)
          .first();
      const medicAnswers = {
        ...answers,
        teams: ["outreach", "medic"],
        certifications: ["advanced-first-aid"],
        codeOfConductAccepted: true,
      };
      for (const certificationExpiry of [undefined, "", " \t\n\u00a0 "]) {
        const rejected = await send(
          "/api/v1/account/profile",
          { ...medicAnswers, certificationExpiry },
          expiryCookie,
        );
        assert.equal(rejected.status, 400);
        assert.equal(await savedProfile(), null);
      }
      const application = await send(
        "/api/v1/account/profile",
        { ...medicAnswers, certificationExpiry: "2030-10-14" },
        expiryCookie,
      );
      assert.equal(application.status, 200, await application.clone().text());
      const original = await savedProfile();
      for (const certificationExpiry of ["", " \t\n\u00a0 "]) {
        const rejected = await send(
          "/api/v1/account/profile",
          { ...medicAnswers, certificationExpiry },
          expiryCookie,
        );
        assert.equal(rejected.status, 400);
        assert.deepEqual(await savedProfile(), original);
      }
    });

    test("relevant training supports multiple answers and conditional Other details without Medic", async () => {
      const trainingCookie = await signIn(
        "worker-relevant-training@example.org",
      );
      const account = (await (
        await send("/api/v1/auth/get-session", undefined, trainingCookie)
      ).json()) as typeof current;
      const savedProfile = () =>
        DB.prepare("SELECT * FROM profile WHERE user_id=?")
          .bind(account.user.id)
          .first();
      const trainingAnswers = {
        ...answers,
        training: ["naloxone-administration", "crisis-intervention", "other"],
        crisisInterventionDetails: "Crisis prevention certification",
        otherTraining: "Crisis intervention course",
        codeOfConductAccepted: true,
      };
      for (const invalid of [
        { training: undefined },
        { training: [] },
        { training: ["none", "naloxone-trainer"] },
        { training: ["unknown"] },
        { training: ["naloxone-trainer", "naloxone-trainer"] },
        { otherTraining: undefined },
        { otherTraining: "" },
        { otherTraining: " \t\n\u00a0 " },
      ]) {
        const rejected = await send(
          "/api/v1/account/profile",
          { ...trainingAnswers, ...invalid },
          trainingCookie,
        );
        assert.equal(rejected.status, 400);
        assert.equal(await savedProfile(), null);
      }
      const application = await send(
        "/api/v1/account/profile",
        {
          ...trainingAnswers,
          training: [...trainingAnswers.training].reverse(),
        },
        trainingCookie,
      );
      assert.equal(application.status, 200, await application.clone().text());
      const original = await savedProfile();
      assert.equal(
        original?.relevant_training,
        JSON.stringify(trainingAnswers.training),
      );
      assert.equal(original?.other_training, trainingAnswers.otherTraining);
      assert.equal(original?.medical_certifications, "[]");
      const rejectedEdit = await send(
        "/api/v1/account/profile",
        { ...trainingAnswers, otherTraining: " " },
        trainingCookie,
      );
      assert.equal(rejectedEdit.status, 400);
      assert.deepEqual(await savedProfile(), original);
      const edited = await send(
        "/api/v1/account/profile",
        {
          ...trainingAnswers,
          teams: ["outreach", "non-patrol"],
          training: ["none"],
          relevantExperience: ["overdose-response", "lived-experience"],
          otherTraining: "",
        },
        trainingCookie,
      );
      assert.equal(edited.status, 200, await edited.clone().text());
      assert.equal(
        (await savedProfile())?.relevant_experience,
        JSON.stringify(["overdose-response", "lived-experience"]),
      );
      assert.equal((await savedProfile())?.other_training, "");
    });

    test("one highest certification is required for Medic with expiry and Other details saved", async () => {
      const trainingCookie = await signIn("worker-medic-training@example.org");
      const account = (await (
        await send("/api/v1/auth/get-session", undefined, trainingCookie)
      ).json()) as typeof current;
      const {
        certification: _,
        certifications: __,
        experience: _experience,
        ...withoutCertifications
      } = answers;
      const rejected = await send(
        "/api/v1/account/profile",
        {
          ...withoutCertifications,
          teams: ["outreach", "medic"],
          codeOfConductAccepted: true,
        },
        trainingCookie,
      );
      assert.equal(rejected.status, 400);
      const savedProfile = () =>
        DB.prepare("SELECT * FROM profile WHERE user_id=?")
          .bind(account.user.id)
          .first();
      assert.equal(await savedProfile(), null);
      const missingOtherDetails = await send(
        "/api/v1/account/profile",
        {
          ...withoutCertifications,
          teams: ["outreach", "medic"],
          certifications: ["other"],
          certificationExpiry: "2030-10-14",
          codeOfConductAccepted: true,
        },
        trainingCookie,
      );
      assert.equal(missingOtherDetails.status, 400);
      assert.equal(await savedProfile(), null);

      const application = await send(
        "/api/v1/account/profile",
        { ...withoutCertifications, codeOfConductAccepted: true },
        trainingCookie,
      );
      assert.equal(application.status, 200, await application.clone().text());
      const original = await savedProfile();
      assert.equal(original?.medical_certification, "");
      assert.equal(original?.medical_certifications, "[]");
      assert.equal(original?.training_experience, "");
      const {
        heardAboutUs: ___,
        motivation: ____,
        ...edits
      } = withoutCertifications;
      const medicAnswers = {
        ...edits,
        teams: ["outreach", "medic"],
        certifications: ["other"],
        certificationExpiry: "2030-10-14",
        experience: "Naloxone training",
      };
      for (const invalid of [
        { certifications: [] },
        { certifications: ["unknown"] },
        { certifications: ["nurse", "nurse"] },
        { certifications: ["advanced-first-aid", "nurse"] },
        { certificationExpiry: "2030-02-30" },
        { certificationExpiry: "invalid" },
        { experience: " " },
        { experience: "" },
        { experience: undefined },
      ]) {
        const invalidEdit = await send(
          "/api/v1/account/profile",
          { ...medicAnswers, ...invalid },
          trainingCookie,
        );
        assert.equal(invalidEdit.status, 400);
        assert.deepEqual(await savedProfile(), original);
      }
      const validEdit = await send(
        "/api/v1/account/profile",
        medicAnswers,
        trainingCookie,
      );
      assert.equal(validEdit.status, 200, await validEdit.clone().text());
      assert.equal(
        (await savedProfile())?.medical_certifications,
        JSON.stringify(medicAnswers.certifications),
      );
      assert.equal(
        (await savedProfile())?.training_experience,
        "Naloxone training",
      );
      assert.equal(
        (await savedProfile())?.medical_certification_expiry,
        "2030-10-14",
      );
      const nonMedicEdit = await send(
        "/api/v1/account/profile",
        { ...edits, teams: ["outreach", "non-patrol"], certifications: [] },
        trainingCookie,
      );
      assert.equal(nonMedicEdit.status, 200, await nonMedicEdit.clone().text());
      assert.equal((await savedProfile())?.medical_certifications, "[]");
      assert.equal(
        (await savedProfile())?.training_experience,
        "Naloxone training",
      );
      const missingExperience = await send(
        "/api/v1/account/profile",
        { ...edits, experience: " " },
        trainingCookie,
      );
      assert.equal(
        missingExperience.status,
        200,
        await missingExperience.clone().text(),
      );
      assert.equal((await savedProfile())?.training_experience, "");
      const medicWithoutOther = await send(
        "/api/v1/account/profile",
        {
          ...edits,
          teams: ["outreach", "medic"],
          certifications: ["advanced-first-aid"],
          certificationExpiry: "2030-10-14",
        },
        trainingCookie,
      );
      assert.equal(
        medicWithoutOther.status,
        200,
        await medicWithoutOther.clone().text(),
      );
    });

    test("application and edits round-trip through the real API", async () => {
      const beforeApplication = await send("/events", undefined, cookie);
      assert.equal(beforeApplication.status, 302);
      assert.equal(beforeApplication.headers.get("location"), "/volunteer");
      const applicationPortal = await send("/volunteer", undefined, cookie);
      assert.equal(applicationPortal.status, 200);
      const prompt = await applicationPortal.text();
      assert.match(prompt, /data-application-tracker/);
      assert.match(prompt, /href="\/apply"/);
      assert.match(prompt, /Complete application form/);
      assert.doesNotMatch(prompt, /data-event-list/);
      for (const input of [
        answers,
        { ...answers, codeOfConductAccepted: false },
        { ...answers, codeOfConductAccepted: "true" },
        {
          ...answers,
          heardAboutUsSources: undefined,
          motivation: undefined,
          codeOfConductAccepted: true,
        },
      ]) {
        const rejected = await send("/api/v1/account/profile", input, cookie);
        assert.equal(rejected.status, 400);
      }
      assert.equal(
        await DB.prepare("SELECT user_id FROM profile WHERE user_id=?")
          .bind(current.user.id)
          .first(),
        null,
      );
      const response = await send(
        "/api/v1/account/profile",
        { ...answers, codeOfConductAccepted: true },
        cookie,
      );
      assert.equal(response.status, 200, await response.clone().text());
      const submittedPortal = await send("/events", undefined, cookie);
      assert.equal(submittedPortal.status, 302);
      assert.equal(submittedPortal.headers.get("location"), "/volunteer");
      const submittedProgress = await send("/volunteer", undefined, cookie);
      assert.equal(submittedProgress.status, 200);
      assert.match(
        await submittedProgress.text(),
        /Application Form Submitted/,
      );
      const acknowledgement = await DB.prepare(
        "SELECT code_of_conduct_version, code_of_conduct_accepted_at FROM profile WHERE user_id=?",
      )
        .bind(current.user.id)
        .first();
      assert.equal(
        acknowledgement?.code_of_conduct_version,
        codeOfConductVersion,
      );
      assert.equal(
        typeof acknowledgement?.code_of_conduct_accepted_at,
        "number",
      );
      const page = await send("/volunteer/account", undefined, cookie);
      assert.equal(page.status, 200);
      const html = await page.text();
      assert.match(html, /Worker Test Volunteer/);
      assert.match(html, /aria-label="Volunteer account"/);
      assert.match(html, /Sample private answer/);
      assert.doesNotMatch(
        html,
        /submitted-application-heading|data-submitted-application|data-application-tracker|data-naloxone-confirm|account-naloxone-heading/,
      );
      assert.doesNotMatch(
        html,
        /Please tell us what motivates you volunteer with us\?/,
      );
      assert.doesNotMatch(
        html.match(/<form\b[^>]*data-account-profile[\s\S]*?<\/form>/)![0],
        /How did you find out about us\?|Please tell us what motivates you volunteer with us\?|code-of-conduct-heading/,
      );
      assert.doesNotMatch(
        html,
        /data-account-switcher|fonts.googleapis.com|cdn.shopify.com/,
      );
      assert.match(page.headers.get("cache-control")!, /no-store/);
      assert.equal(page.headers.get("referrer-policy"), "no-referrer");
      assert.match(
        page.headers.get("content-security-policy")!,
        /frame-ancestors 'none'/,
      );
      assert.equal(
        (
          await send(
            "/api/v1/account/profile",
            { ...answers, userId: "another-user" },
            cookie,
          )
        ).status,
        400,
      );
      assert.equal(
        (
          await send(
            "/api/v1/account/profile",
            answers,
            cookie,
            "https://evil.example",
          )
        ).status,
        403,
      );
      assert.equal(
        (
          await send(
            "/api/v1/auth/sign-out",
            {},
            cookie,
            "https://evil.example",
          )
        ).status,
        403,
      );
    });

    test("account application information appears after three milestones without Discord or orientation signup and stays read-only", async () => {
      await DB.prepare(
        "UPDATE profile SET naloxone_completed_at=1000 WHERE user_id=?",
      )
        .bind(current.user.id)
        .run();
      const pending = await send("/volunteer/account", undefined, cookie);
      assert.equal(pending.status, 200);
      assert.doesNotMatch(
        await pending.text(),
        /submitted-application-heading|data-submitted-application|data-application-tracker|data-naloxone-confirm|account-naloxone-heading/,
      );
      await DB.prepare(
        "UPDATE volunteer_status SET registration_approved=1 WHERE user_id=?",
      )
        .bind(current.user.id)
        .run();
      const withoutDiscord = await send(
        "/volunteer/account",
        undefined,
        cookie,
      );
      // Discord linking is paused: approved applicants need no connection.
      assert.match(
        await withoutDiscord.text(),
        /id="submitted-application-heading"/,
      );
      await DB.prepare(
        `INSERT INTO discord_link (user_id,discord_id,username,guild_id,consented_at,completed_at,member_verified_at,next_attempt_at)
        VALUES (?,'200000000000000001','Verified test identity','100000000000000002',1500,1500,1500,0)`,
      )
        .bind(current.user.id)
        .run();
      const page = await send("/volunteer/account", undefined, cookie);
      assert.equal(page.status, 200);
      const html = await page.text();
      assert.match(
        html,
        /<h2\b[^>]*id="submitted-application-heading"[^>]*>\s*Volunteer Application\s*<\/h2>/,
      );
      assert.match(
        html,
        /<a\b[^>]*href="#submitted-application-heading"[^>]*>\s*Volunteer Application\s*<\/a>/,
      );
      assert.match(html, /Naloxone 101 completion/);
      assert.match(html, /Application approved/);
      assert.doesNotMatch(
        html,
        /account-discord-heading|data-discord-connection|Discord connection verified/,
      );
      assert.match(html, /Date not recorded/);
      assert.doesNotMatch(html, /Orientation registered/);
      assert.doesNotMatch(
        html,
        /data-application-tracker|data-naloxone-confirm|account-naloxone-heading|Current step|Not started|Take Naloxone 101|View orientations/,
      );
      const snapshot = await DB.prepare(
        "SELECT submitted_application FROM profile WHERE user_id=?",
      )
        .bind(current.user.id)
        .first<string>("submitted_application");
      assert.ok(snapshot);
      const submission = JSON.parse(snapshot) as SubmittedApplication;
      const timestamp = html.match(
        /<p>\s*Submitted:\s*<time datetime="([^"]+)">\s*([^<]+?)\s*<\/time>\s*<\/p>/,
      );
      assert.ok(timestamp);
      assert.equal(timestamp[1], submission.submittedAt);
      assert.equal(
        timestamp[2].replace(/\s+/g, " "),
        new Date(submission.submittedAt)
          .toLocaleString("en-CA", {
            timeZone: "America/Vancouver",
            timeZoneName: "short",
          })
          .replace(/\s+/g, " "),
      );
      assert.match(
        html,
        /Please tell us what motivates you volunteer with us\?/,
      );
    });

    test("submitted applications stay private and legacy profile edits do not invent an original snapshot", async () => {
      const legacyCookie = await signIn(
        "worker-legacy-application@example.org",
      );
      const legacy = (await (
        await send("/api/v1/auth/get-session", undefined, legacyCookie)
      ).json()) as typeof current;
      await DB.prepare(
        `INSERT INTO profile (
        user_id, preferred_name, phone, birth_date, emergency_contact_name,
        emergency_contact_phone, emergency_contact_relationship, heard_about_us,
        motivation, teams, medical_certification, training_experience, registered_at, updated_at
      ) VALUES (?, 'Legacy current name', '604-555-0100', '1995-04-12',
        'Contact', '604-555-0101', 'Friend', 'Friend', 'Legacy motivation', '[]', '', '', 1, 1)`,
      )
        .bind(legacy.user.id)
        .run();
      await DB.prepare("DELETE FROM discord_requirement WHERE user_id=?")
        .bind(legacy.user.id)
        .run();
      const edited = await send(
        "/api/v1/account/profile",
        {
          ...answers,
          firstName: "",
          middleNames: "",
          lastName: "",
          preferredName: "Changed legacy name",
          medicalConditions: "Legacy private answer",
        },
        legacyCookie,
      );
      assert.equal(edited.status, 200, await edited.clone().text());
      assert.equal(
        await DB.prepare(
          "SELECT submitted_application FROM profile WHERE user_id=?",
        )
          .bind(legacy.user.id)
          .first("submitted_application"),
        null,
      );

      const page = await send(
        `/volunteer/account?userId=${current.user.id}`,
        undefined,
        legacyCookie,
      );
      assert.equal(page.status, 200);
      const html = await page.text();
      assert.doesNotMatch(
        html,
        /data-submitted-application|submitted-application-heading/,
      );
      assert.doesNotMatch(
        html,
        /View submitted application|Worker Test Volunteer|Sample private answer/,
      );
      const ownPage = await send(
        `/volunteer/account?userId=${legacy.user.id}`,
        undefined,
        cookie,
      );
      assert.equal(ownPage.status, 200);
      const ownHTML = await ownPage.text();
      assert.match(ownHTML, /View submitted application/);
      assert.doesNotMatch(
        ownHTML,
        /Legacy motivation|Changed legacy name|Legacy private answer/,
      );
      await DB.batch([
        DB.prepare(
          "UPDATE profile SET naloxone_completed_at=0 WHERE user_id=?",
        ).bind(legacy.user.id),
        DB.prepare(
          `INSERT INTO volunteer_status (user_id, active, registration_approved, updated_at)
          VALUES (?, 1, 1, 0) ON CONFLICT(user_id) DO UPDATE SET registration_approved=1`,
        ).bind(legacy.user.id),
      ]);
      const completedLegacy = await send(
        "/volunteer/account",
        undefined,
        legacyCookie,
      );
      assert.equal(completedLegacy.status, 200);
      const completedLegacyHTML = await completedLegacy.text();
      assert.match(completedLegacyHTML, /submitted-application-heading/);
      assert.match(
        completedLegacyHTML,
        /The original submitted answers were not captured for this account/,
      );
      assert.doesNotMatch(
        completedLegacyHTML,
        /data-submitted-application|View submitted application|data-application-tracker|data-naloxone-confirm/,
      );
    });

    test("public pages render session-specific headers without caching or exposing profile answers", async () => {
      for (const path of ["/", "/about", "/donate", "/privacy"]) {
        const [signedIn, signedOut] = await Promise.all([
          send(path, undefined, cookie),
          send(path, undefined, ""),
        ]);
        for (const response of [signedIn, signedOut]) {
          assert.equal(response.status, 200, path);
          assert.equal(response.headers.get("cache-control"), "no-store", path);
          if (path !== "/privacy")
            assert.equal(response.headers.get("x-robots-tag"), null, path);
        }
        const signedInHTML = await signedIn.text();
        const header = signedInHTML.match(/<header\b[\s\S]*?<\/header>/)![0];
        assert.match(header, /aria-label="Account for Worker Test Volunteer"/);
        assert.match(header, /data-account-menu(?:=""|[\s>])/);
        assert.match(header, /data-header-discord[^>]*hidden/);
        assert.doesNotMatch(signedInHTML, /Sample private answer/);
        assert.doesNotMatch(signedInHTML, new RegExp(current.session.id));
        const signedOutHTML = await signedOut.text();
        assert.doesNotMatch(
          signedOutHTML,
          /Worker Test Volunteer|data-account-menu(?:=""|[\s>])/,
        );
      }
    });

    test("session management lists only active owned sessions and revokes by ID without exposing tokens", async () => {
      const siblingCookie = await signIn("worker-volunteer@example.org");
      const expiredCookie = await signIn("worker-volunteer@example.org");
      const sibling = (await (
        await send("/api/v1/auth/get-session", undefined, siblingCookie)
      ).json()) as { session: { id: string; token: string } };
      const expired = (await (
        await send("/api/v1/auth/get-session", undefined, expiredCookie)
      ).json()) as { session: { id: string; token: string } };
      await DB.prepare("UPDATE session SET expires_at=? WHERE id=?")
        .bind(Date.now() - 1000, expired.session.id)
        .run();
      const page = await send("/volunteer/account", undefined, cookie);
      assert.equal(page.status, 200);
      const html = await page.text();
      assert.ok(html.includes(sibling.session.id));
      assert.ok(!html.includes(expired.session.id));
      assert.ok(!html.includes(sibling.session.token));
      assert.ok(!html.includes(expired.session.token));

      const revoked = await send(
        "/api/v1/account/session",
        { id: sibling.session.id },
        cookie,
      );
      assert.equal(revoked.status, 200, await revoked.clone().text());
      assert.equal(
        await (
          await send("/api/v1/auth/get-session", undefined, siblingCookie)
        ).json(),
        null,
      );
      assert.ok(
        await (
          await send("/api/v1/auth/get-session", undefined, cookie)
        ).json(),
      );
      assert.equal(
        (
          await send(
            "/api/v1/account/session",
            { id: "unknown-session" },
            cookie,
          )
        ).status,
        200,
      );
      assert.equal(
        (await send("/api/v1/account/session", { id: current.session.id }))
          .status,
        401,
      );
      assert.equal(
        (
          await send(
            "/api/v1/account/session",
            { id: current.session.id },
            cookie,
            "https://evil.example",
          )
        ).status,
        403,
      );
    });

    test("older sessions can edit their profile but must sign in again to list sessions", async () => {
      const original = await DB.prepare(
        "SELECT created_at AS createdAt FROM session WHERE id=?",
      )
        .bind(current.session.id)
        .first<{ createdAt: number }>();
      await DB.prepare("UPDATE session SET created_at=? WHERE id=?")
        .bind(Date.now() - 2 * 86_400_000, current.session.id)
        .run();
      try {
        const page = await send("/volunteer/account", undefined, cookie);
        assert.equal(page.status, 200, await page.clone().text());
        const html = await page.text();
        assert.match(html, /Sign in again to view and manage/);
        assert.match(html, /data-account-profile/);
        assert.doesNotMatch(html, /data-end-session|This browser/);
      } finally {
        await DB.prepare("UPDATE session SET created_at=? WHERE id=?")
          .bind(original!.createdAt, current.session.id)
          .run();
      }
    });

    test("ending another person's session cannot revoke it", async () => {
      const otherCookie = await signIn("other-worker-volunteer@example.org");
      const other = (await (
        await send("/api/v1/auth/get-session", undefined, otherCookie)
      ).json()) as { session: { id: string } };
      assert.equal(
        (
          await send(
            "/api/v1/account/session",
            { id: other.session.id },
            cookie,
          )
        ).status,
        200,
      );
      assert.equal(
        (await send("/api/v1/auth/get-session", undefined, otherCookie)).status,
        200,
      );
      assert.ok(
        await (
          await send("/api/v1/auth/get-session", undefined, otherCookie)
        ).json(),
      );
    });

    test("GET link pages do not consume codes or set session cookies", async () => {
      const proof = await createSignInOTP(DB, secret, "scanner@example.org");
      const response = await send(
        `/volunteer/sign-in/complete#${new URLSearchParams(proof)}`,
      );
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("set-cookie"), null);
      const row = await DB.prepare(
        "SELECT id FROM verification WHERE identifier = ?",
      )
        .bind(`sign-in-otp-${proof.email}`)
        .first();
      assert.ok(row?.id);
    });

    test("unconfigured email delivery fails closed and removes its code", async () => {
      const page = await send("/volunteer/sign-in");
      assert.match(await page.text(), /Sign-in is not configured yet/);
      const response = await send(
        "/api/v1/auth/email-otp/send-verification-otp",
        {
          email: "no-mail@example.org",
          type: "sign-in",
        },
      );
      assert.equal(response.status, 503);
      assert.match(
        ((await response.json()) as { message: string }).message,
        /Sign-in email is not configured yet/,
      );
      const count = await DB.prepare(
        "SELECT count(*) AS count FROM verification WHERE identifier = ?",
      )
        .bind("sign-in-otp-no-mail@example.org")
        .first();
      assert.equal(count?.count, 0);
    });

    test("production builds reject development account endpoints without changing sessions", async () => {
      const before = (await (
        await send("/api/v1/auth/get-session", undefined, cookie)
      ).json()) as typeof current;
      for (const sessionCookie of [undefined, cookie]) {
        assert.equal(
          (await send("/api/v1/auth/dev/users", undefined, sessionCookie))
            .status,
          404,
        );
        for (const userId of [before.user.id, null]) {
          assert.equal(
            (
              await send(
                "/api/v1/auth/dev/switch-user",
                { userId },
                sessionCookie,
              )
            ).status,
            404,
          );
        }
        assert.equal(
          (
            await send(
              "/api/v1/auth/dev/delete-user",
              { userId: before.user.id, confirm: true },
              sessionCookie,
            )
          ).status,
          404,
        );
        assert.equal(
          (
            await send(
              "/api/v1/auth/dev/application-step",
              { userId: before.user.id, step: "review" },
              sessionCookie,
            )
          ).status,
          404,
        );
      }
      const after = (await (
        await send("/api/v1/auth/get-session", undefined, cookie)
      ).json()) as typeof current;
      assert.equal(after.user.id, before.user.id);
      assert.equal(after.session.id, before.session.id);
      // Discord linking is paused: neither linked nor unlinked accounts get UI.
      const unlinkedCookie = await signIn(
        "worker-unlinked-discord@example.org",
      );
      const discordPage = await (
        await send("/volunteer/account", undefined, unlinkedCookie)
      ).text();
      // assert.match(discordPage, /Discord connection is coming soon\./);
      assert.doesNotMatch(
        discordPage,
        /account-discord-heading|data-discord-connection|data-discord-connect|Discord connection is coming soon|Authorize AHOI Bot/,
      );
      const previousDiscord = await DB.prepare(
        "SELECT * FROM discord_link WHERE user_id=?",
      )
        .bind(before.user.id)
        .first();
      const simulated = await send(
        "/api/v1/account/discord",
        {
          userId: before.user.id,
          consent: true,
          outcome: "authorize",
        },
        cookie,
      );
      assert.equal(simulated.status, 503);
      assert.equal(
        ((await simulated.json()) as { message: string }).message,
        "Discord connection is coming soon.",
      );
      assert.deepEqual(
        await DB.prepare("SELECT * FROM discord_link WHERE user_id=?")
          .bind(before.user.id)
          .first(),
        previousDiscord,
      );
      assert.equal(
        (await send("/api/v1/auth/dev/seed-accounts", {}, cookie)).status,
        404,
      );
    });

    test("email-change endpoints enforce authentication, same-origin POSTs and fail closed without delivery", async () => {
      for (const path of [
        "/email-otp/request-email-change",
        "/email-otp/change-email",
      ]) {
        const input = {
          newEmail: "worker-new@example.org",
          ...(path.endsWith("/change-email") && { otp: "123456" }),
        };
        assert.equal((await send(`/api/v1/auth${path}`)).status, 405);
        assert.equal((await send(`/api/v1/auth${path}`, input)).status, 401);
        assert.equal(
          (
            await send(
              `/api/v1/auth${path}`,
              input,
              cookie,
              "https://evil.example.org",
            )
          ).status,
          403,
        );
      }
      const sent = await send(
        "/api/v1/auth/email-otp/request-email-change",
        { newEmail: "worker-new@example.org" },
        cookie,
      );
      assert.equal(sent.status, 503, await sent.clone().text());
      assert.doesNotMatch(await sent.text(), /localEmail|"code"/);
      assert.equal(
        (
          await DB.prepare(
            "SELECT count(*) AS n FROM verification WHERE identifier LIKE 'change-email-otp-%'",
          ).first()
        )?.n,
        0,
      );
      assert.equal(
        (
          await DB.prepare("SELECT email FROM user WHERE id=?")
            .bind(current.user.id)
            .first()
        )?.email,
        "worker-volunteer@example.org",
      );
    });

    test("sign-in pages stay first-party and completed links land on /volunteer", async () => {
      const browser = await chromium.launch({
        executablePath:
          process.env.CHROMIUM_PATH ??
          (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined),
      });
      try {
        const page = await browser.newPage();
        const external: string[] = [];
        const errors: string[] = [];
        page.on("request", (request) => {
          if (new URL(request.url()).origin !== origin)
            external.push(request.url());
        });
        page.on("pageerror", (error) => errors.push(error.message));
        await page.route("**/*", async (route) => {
          const request = route.request();
          if (!request.url().startsWith(origin)) return route.abort();
          const response = await worker.fetch(request.url(), {
            method: request.method(),
            headers: await request.allHeaders(),
            body: request.postData() ?? undefined,
          });
          await route.fulfill({
            status: response.status,
            headers: Object.fromEntries(response.headers),
            body: Buffer.from(await response.arrayBuffer()),
          });
        });
        const response = await page.goto(`${origin}/volunteer/sign-in`);
        await expect(
          page.getByRole("button", {
            name: "DEV panel",
            exact: true,
          }),
        ).toHaveCount(0);
        assert.match(
          response!.headers()["content-security-policy"],
          /frame-src 'none'/,
        );
        assert.equal(await page.locator("iframe").count(), 0);
        assert.deepEqual(
          await page
            .locator("[data-email-request] input")
            .evaluateAll((inputs) =>
              inputs.map((input) => input.getAttribute("name")),
            ),
          ["email"],
        );
        const proof = await createSignInOTP(
          DB,
          secret,
          "link-landing-volunteer@example.org",
        );
        const fragment = new URLSearchParams({
          ...proof,
          returnTo: "/manage/events",
        });
        await page.goto(`${origin}/volunteer/sign-in/complete#${fragment}`);
        await expect(page.getByLabel("Six-digit code")).toBeVisible();
        await page.getByLabel("Six-digit code").fill(proof.otp);
        await page.getByRole("button", { name: "Sign in with code" }).click();
        await expect(page).toHaveURL(`${origin}/volunteer`);
        await expect(page.locator("[data-application-tracker]")).toBeVisible();
        assert.deepEqual(external, []);
        assert.deepEqual(errors, []);
        await page.close();
      } finally {
        await browser.close();
      }
    });

    test("browser edits persisted profile answers without browser storage or third-party requests", async () => {
      const browser = await chromium.launch({
        executablePath:
          process.env.CHROMIUM_PATH ??
          (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined),
      });
      try {
        const context = await browser.newContext();
        const browserCookie = cookie.split(";")[0];
        const split = browserCookie.indexOf("=");
        await context.addCookies([
          {
            name: browserCookie.slice(0, split),
            value: browserCookie.slice(split + 1),
            url: origin,
            httpOnly: true,
            secure: true,
          },
        ]);
        const page = await context.newPage();
        const external: string[] = [];
        const errors: string[] = [];
        page.on("console", (entry) => {
          if (entry.type() === "error") errors.push(entry.text());
        });
        page.on("request", (request) => {
          if (!request.url().startsWith(origin)) external.push(request.url());
        });
        page.on("pageerror", (error) => errors.push(error.message));
        // Every browser request goes to the local test Worker, never the live
        // production host. Keeping its real origin also exercises secure cookies.
        await page.route("**/*", async (route) => {
          const request = route.request();
          if (!request.url().startsWith(origin)) return route.abort();
          const response = await worker.fetch(request.url(), {
            method: request.method(),
            headers: await request.allHeaders(),
            body: request.postData() ?? undefined,
          });
          await route.fulfill({
            status: response.status,
            headers: Object.fromEntries(response.headers),
            body: Buffer.from(await response.arrayBuffer()),
          });
        });
        const siblings: string[] = [];
        for (let i = 0; i < 2; i++) {
          const siblingCookie = await signIn("worker-volunteer@example.org");
          const sibling = (await (
            await send("/api/v1/auth/get-session", undefined, siblingCookie)
          ).json()) as { session: { id: string } };
          siblings.push(sibling.session.id);
        }
        await page.goto(`${origin}/volunteer/account`);
        await page
          .getByRole("heading", { name: "Account", exact: true })
          .waitFor();
        await expect(
          page.locator(
            '[data-account-profile] input[type="email"], [name="heardAboutUsSources"], [name="heardAboutUsOther"], [name="motivation"], .volunteer-code-of-conduct',
          ),
        ).toHaveCount(0);
        const saveProfile = page
          .getByRole("button", {
            name: "Save",
            exact: true,
            includeHidden: true,
          })
          .first();
        await page.getByRole("button", { name: "Edit personal info" }).click();
        await expect(saveProfile).toBeDisabled();
        await expect(
          page
            .getByRole("group", { name: "Emergency contact", exact: true })
            .locator("input"),
        ).toHaveCount(3);
        const nav = page.getByRole("navigation", {
          name: "Volunteer account",
        });
        const menu = nav.locator("[data-account-menu]");
        assert.equal(
          (
            await menu.locator("[data-account-menu-name]").textContent()
          )?.trim(),
          answers.preferredName,
        );
        await menu.locator("summary").click();
        assert.equal(
          await menu
            .getByRole("link", { name: "Account", exact: true })
            .getAttribute("href"),
          "/volunteer/account",
        );
        await menu.locator("summary").click();
        const changedName = "Worker Updated Volunteer";
        await page.getByLabel("Preferred name").fill(changedName);
        await page
          .getByLabel(
            "Medical conditions/allergies/anything else we should know",
            { exact: false },
          )
          .fill("Changed browser sample");
        await expect(saveProfile).toBeEnabled();
        for (const id of siblings) {
          const sessionForm = page
            .locator("[data-end-session]")
            .filter({ has: page.locator(`input[value="${id}"]`) });
          await inPlaceAction(page, {
            endpoint: "/api/v1/account/session",
            form: sessionForm,
            trigger: () =>
              sessionForm
                .getByRole("button", {
                  name: "Sign out of session",
                  exact: true,
                })
                .click(),
            updated: () => expect(sessionForm).toHaveCount(0),
            loadingLabel: "Signing out…",
          });
          await expect(page.getByLabel("Preferred name")).toHaveValue(
            changedName,
          );
          await expect(
            page.getByLabel(
              "Medical conditions/allergies/anything else we should know",
              { exact: false },
            ),
          ).toHaveValue("Changed browser sample");
          assert.equal(
            await DB.prepare("SELECT id FROM session WHERE id=?")
              .bind(id)
              .first(),
            null,
          );
        }
        await saveProfile.click();
        try {
          const saved = page.locator(
            '[data-account-profile] [data-profile-answer="preferredName"] dd',
          );
          await expect(saved).toBeVisible();
          await expect(saved).toHaveText(changedName);
          await expect(
            page.locator("[data-account-profile] [data-form-message]"),
          ).toBeHidden();
        } catch (error) {
          console.error(
            JSON.stringify({
              errors,
              messages: await page
                .locator("[data-form-message]")
                .allTextContents(),
              url: page.url(),
            }),
          );
          throw error;
        }
        await expect(saveProfile).toBeDisabled();
        assert.equal(
          (
            await menu.locator("[data-account-menu-name]").textContent()
          )?.trim(),
          changedName,
        );
        await page.reload();
        const submittedApplication = page.locator(
          "[data-submitted-application]",
        );
        await submittedApplication.locator("summary").click();
        await expect(
          submittedApplication.getByRole("heading", {
            name: "Submission details",
          }),
        ).toBeVisible();
        await expect(
          submittedApplication.locator("input, textarea, select, button"),
        ).toHaveCount(0);
        await expect(submittedApplication).toContainText(answers.preferredName);
        await expect(submittedApplication).toContainText(
          answers.medicalConditions,
        );
        await expect(submittedApplication).not.toContainText(changedName);
        await expect(submittedApplication).not.toContainText(
          "Changed browser sample",
        );
        assert.deepEqual(
          await DB.prepare(
            "SELECT heard_about_us, motivation FROM profile WHERE user_id=?",
          )
            .bind(current.user.id)
            .first(),
          {
            heard_about_us: answers.heardAboutUs,
            motivation: answers.motivation,
          },
        );
        assert.equal(
          (
            await menu.locator("[data-account-menu-name]").textContent()
          )?.trim(),
          changedName,
        );
        assert.equal(
          await page
            .getByLabel(
              "Medical conditions/allergies/anything else we should know",
              { exact: false },
            )
            .inputValue(),
          "Changed browser sample",
        );
        assert.deepEqual(
          await page.evaluate(() => ({
            local: Object.keys(localStorage),
            session: Object.keys(sessionStorage),
          })),
          { local: [], session: [] },
        );
        assert.deepEqual(external, []);
        assert.deepEqual(errors, []);
        await context.close();

        const newContext = await browser.newContext();
        const newPage = await newContext.newPage();
        await newPage.route("**/*", async (route) => {
          const request = route.request();
          if (!request.url().startsWith(origin)) return route.abort();
          const response = await worker.fetch(request.url(), {
            method: request.method(),
            headers: await request.allHeaders(),
            body: request.postData() ?? undefined,
          });
          await route.fulfill({
            status: response.status,
            headers: Object.fromEntries(response.headers),
            body: Buffer.from(await response.arrayBuffer()),
          });
        });
        const proof = await createSignInOTP(
          DB,
          secret,
          "browser-new-volunteer@example.org",
        );
        await newPage.goto(
          `${origin}/volunteer/sign-in/complete#${new URLSearchParams(proof)}`,
        );
        await expect(newPage.getByLabel("Six-digit code")).toBeVisible();
        assert.equal(new URL(newPage.url()).hash, "");
        assert.ok(
          await DB.prepare("SELECT id FROM verification WHERE identifier=?")
            .bind(`sign-in-otp-${proof.email}`)
            .first(),
        );
        // Legacy links have no browser binding and require manual code entry.
        await newPage.getByLabel("Six-digit code").fill(proof.otp);
        await newPage
          .getByRole("button", { name: "Sign in with code" })
          .click();
        await expect(newPage).toHaveURL(`${origin}/volunteer`);
        await newPage
          .getByRole("link", { name: "Complete application form", exact: true })
          .click();
        await newPage
          .getByRole("heading", {
            name: "Volunteer application",
            exact: true,
          })
          .waitFor();
        await expect(newPage.locator("[data-account-menu]")).toBeVisible();
        await expect(
          newPage.getByRole("group", {
            name: "Training and safety",
            exact: true,
          }),
        ).toBeVisible();
        await expect(
          newPage.locator("[data-medic-certifications]"),
        ).toBeHidden();
        for (const [name, value] of Object.entries(answers)) {
          if (
            name === "heardAboutUsSources" ||
            name === "training" ||
            name === "relevantExperience" ||
            name === "teams"
          ) {
            for (const source of value as string[])
              await newPage
                .locator(`[name="${name}"][value="${source}"]`)
                .check();
            continue;
          }
          if (
            [
              "heardAboutUs",
              "heardAboutUsOther",
              "teams",
              "certification",
              "certifications",
              "certificationExpiry",
              "experience",
              "training",
              "otherTraining",
              "otherExperience",
            ].includes(name)
          )
            continue;
          await fillApplicationField(newPage, name, String(value));
        }
        await expect(
          newPage.getByRole("checkbox", { name: "Outreach", exact: true }),
        ).toBeChecked();
        await expect(
          newPage.getByRole("checkbox", { name: "Outreach", exact: true }),
        ).toBeEnabled();
        await reviewLocalApplication(newPage);
        const conduct = newPage.getByRole("region", {
          name: "Code of Conduct",
          exact: true,
        });
        await expect(conduct.getByRole("listitem")).toHaveText(
          codeOfConductRules.slice(0, 2),
        );
        const toggle = conduct.locator("summary");
        await expect(toggle).toHaveAccessibleName("Read all rules");
        await toggle.click();
        await expect(conduct.getByRole("listitem")).toHaveText([
          ...codeOfConductRules,
        ]);
        await expect(toggle).toHaveAccessibleName("Show fewer rules");
        assert.ok(
          await conduct.evaluate((element) => {
            const rules = element.querySelector("#code-of-conduct-more-rules")!;
            const summary = element.querySelector("summary")!;
            return (
              summary.getBoundingClientRect().top >=
              rules.getBoundingClientRect().bottom
            );
          }),
          "Show fewer rules appears below the final rule.",
        );
        await toggle.click();
        await expect(conduct.getByRole("listitem")).toHaveCount(2);
        const confirmation = newPage.getByRole("checkbox", {
          name: codeOfConductConfirmation,
          exact: true,
        });
        await expect(confirmation).not.toBeChecked();
        await expect(confirmation).toBeVisible();
        await newPage
          .getByRole("button", { name: "Submit application" })
          .click();
        await expect(
          newPage.locator("[data-error=codeOfConductAccepted]"),
        ).toHaveText(codeOfConductError);
        await expect(
          newPage.locator("[data-error=codeOfConductAccepted]"),
        ).toBeVisible();
        await expect(confirmation).toBeFocused();
        await confirmation.check();
        await newPage
          .getByRole("button", { name: "Submit application" })
          .click();
        // The local Worker fetch follows the pending-applicant redirect before
        // fulfilling this intercepted navigation. API tests assert its Location.
        await expect(newPage).toHaveURL(`${origin}/events`);
        await expect(
          newPage.locator("[data-application-tracker]"),
        ).toBeVisible();
        const newAccountMenu = newPage.locator("[data-account-menu]");
        await newAccountMenu.locator("summary").click();
        await newAccountMenu
          .getByRole("link", { name: "Account", exact: true })
          .click();
        await newPage
          .getByRole("heading", { name: "Account", exact: true })
          .waitFor();
        assert.equal(
          await newPage.locator('[name="preferredName"]').inputValue(),
          answers.preferredName,
        );
        await expect(newPage.locator("[data-account-menu-name]")).toHaveText([
          answers.preferredName,
          answers.preferredName,
        ]);
        assert.equal(newPage.url(), `${origin}/volunteer/account`);
        await expect(
          newPage.getByRole("checkbox", {
            name: codeOfConductConfirmation,
            exact: true,
          }),
        ).toHaveCount(0);
        const consumed = await DB.prepare(
          "SELECT id FROM verification WHERE identifier = ?",
        )
          .bind(`sign-in-otp-${proof.email}`)
          .first();
        assert.equal(consumed, null);
        await newPage.locator("[data-account-menu] > summary").click();
        await newPage
          .getByRole("button", { name: "Sign out", exact: true })
          .click();
        await newPage
          .getByRole("heading", { name: "Sign in", exact: true })
          .waitFor();
        await newPage.goto(`${origin}/volunteer/account`);
        await newPage
          .getByRole("heading", { name: "Sign in", exact: true })
          .waitFor();
        await newContext.close();
      } finally {
        await browser.close();
      }
    });

    test("sign-out removes the server-side session", async () => {
      current = (await (
        await send("/api/v1/auth/get-session", undefined, cookie)
      ).json()) as typeof current;
      assert.equal(
        (await send("/api/v1/auth/sign-out", {}, cookie)).status,
        200,
      );
      const result = await DB.prepare("SELECT id FROM session WHERE id = ?")
        .bind(current.session.id)
        .first();
      assert.equal(result, null);
      assert.equal(
        await (
          await send("/api/v1/auth/get-session", undefined, cookie)
        ).json(),
        null,
      );
      const signedOut = await send("/volunteer/sign-in", undefined, cookie);
      assert.doesNotMatch(await signedOut.text(), /data-account-menu/);
    });
    test("the Worker pauses authenticator setup and preserves existing two-factor sign-ins", async () => {
      const email = "worker-factor@example.org";
      const initialCookie = await signIn(email);
      const application = await send(
        "/api/v1/account/profile",
        { ...answers, codeOfConductAccepted: true },
        initialCookie,
      );
      assert.equal(application.status, 200, await application.clone().text());
      assert.equal(
        (
          await send(
            "/api/v1/auth/two-factor/enable",
            { method: "totp" },
            initialCookie,
          )
        ).status,
        404,
      );
      const account = await send(
        "/volunteer/account",
        undefined,
        initialCookie,
      );
      const html = await account.text();
      assert.match(html, /Coming soon\./);
      assert.match(html, /data-factor-settings[^>]*aria-disabled="true"/);
      assert.doesNotMatch(
        html,
        /data-enable-factor|data-confirm-factor|data-disable-factor/,
      );

      // Seed a pre-existing enrollment through the auth service, never by
      // reopening the public setup endpoint or bypassing sign-in verification.
      const auth = createAuth({
        DB,
        APP_ENV: "production",
        AUTH_BASE_URL: origin,
        BETTER_AUTH_SECRET: secret,
        RESEND_API_KEY: "",
      });
      const seed = (path: string, body: object) =>
        auth.handler(
          new Request(`${origin}/api/v1/auth${path}`, {
            method: "POST",
            headers: {
              origin,
              cookie: initialCookie,
              "content-type": "application/json",
            },
            body: JSON.stringify(body),
          }),
        );
      const enabled = await seed("/two-factor/enable", { method: "totp" });
      assert.equal(enabled.status, 200, await enabled.clone().text());
      const setup = (await enabled.json()) as {
        totpURI: string;
        backupCodes: string[];
      };
      const key = new URL(setup.totpURI).searchParams.get("secret")!;
      const paused = await send(
        "/api/v1/auth/two-factor/verify-totp",
        { code: totpFromSetupKey(key) },
        initialCookie,
      );
      assert.equal(paused.status, 403);
      const confirmed = await seed("/two-factor/verify-totp", {
        code: totpFromSetupKey(key),
      });
      assert.equal(confirmed.status, 200, await confirmed.clone().text());
      const confirmedCookie = confirmed.headers
        .getSetCookie()
        .filter((value) => !value.includes("Max-Age=0"))
        .map((value) => value.split(";")[0])
        .join("; ");
      const factorSession = (await (
        await send("/api/v1/auth/get-session", undefined, confirmedCookie)
      ).json()) as { session: { twoFactorVerified: boolean } };
      assert.equal(factorSession.session.twoFactorVerified, true);
      const enrolledPage = await send(
        "/volunteer/account",
        undefined,
        confirmedCookie,
      );
      const enrolledHTML = await enrolledPage.text();
      assert.match(enrolledHTML, /Your authenticator is enabled\./);
      assert.match(enrolledHTML, /Coming soon\./);
      assert.doesNotMatch(
        enrolledHTML,
        /data-enable-factor|data-confirm-factor|data-disable-factor/,
      );
      const encrypted = await DB.prepare(
        "SELECT secret, backup_codes FROM two_factor",
      ).all();
      assert.doesNotMatch(JSON.stringify(encrypted), new RegExp(key));
      assert.doesNotMatch(
        JSON.stringify(encrypted),
        new RegExp(setup.backupCodes[0]),
      );
      await send("/api/v1/auth/sign-out", {}, confirmedCookie);

      const proof = await createSignInOTP(DB, secret, email);
      const pending = await send(
        "/api/v1/auth/sign-in/email-otp?returnTo=%2Fvolunteer%2Faccount%3Ftab%3Dfactor",
        proof,
      );
      assert.equal(pending.status, 200);
      assert.equal(
        ((await pending.clone().json()) as { twoFactorRedirect: boolean })
          .twoFactorRedirect,
        true,
      );
      const pendingCookie = pending.headers
        .getSetCookie()
        .filter((value) => !value.includes("Max-Age=0"))
        .map((value) => value.split(";")[0])
        .join("; ");
      assert.equal(
        await (
          await send("/api/v1/auth/get-session", undefined, pendingCookie)
        ).json(),
        null,
      );
      assert.equal(
        (await send("/api/v1/account/profile", answers, pendingCookie)).status,
        401,
      );
      const verified = await send(
        "/api/v1/auth/two-factor/verify-backup-code",
        { code: setup.backupCodes[0] },
        pendingCookie,
      );
      assert.equal(verified.status, 200, await verified.clone().text());
      assert.equal(
        ((await verified.clone().json()) as { next: string }).next,
        "/volunteer",
      );
      const verifiedCookie = verified.headers
        .getSetCookie()
        .filter((value) => !value.includes("Max-Age=0"))
        .map((value) => value.split(";")[0])
        .join("; ");
      const result = (await (
        await send("/api/v1/auth/get-session", undefined, verifiedCookie)
      ).json()) as { session: { twoFactorVerified: boolean } };
      assert.equal(result.session.twoFactorVerified, true);
      await send("/api/v1/auth/sign-out", {}, verifiedCookie);
      const totpProof = await createSignInOTP(DB, secret, email);
      const totpPending = await send(
        "/api/v1/auth/sign-in/email-otp",
        totpProof,
      );
      const totpCookie = totpPending.headers
        .getSetCookie()
        .filter((value) => !value.includes("Max-Age=0"))
        .map((value) => value.split(";")[0])
        .join("; ");
      const totpVerified = await send(
        "/api/v1/auth/two-factor/verify-totp",
        { code: totpFromSetupKey(key) },
        totpCookie,
      );
      assert.equal(totpVerified.status, 200, await totpVerified.clone().text());
    });
    afterAll(async () => {
      try {
        assert.doesNotMatch(
          JSON.stringify(server.getLogs()),
          /Sample private answer|Changed browser sample|worker-volunteer@example.org/,
        );
      } finally {
        await server.close();
      }
    });
  },
);

test("a built Worker cannot enable account switching with local runtime vars", async () => {
  const server = createTestHarness({
    workers: [
      {
        configPath: "dist/server/wrangler.json",
        vars: {
          APP_ENV: "local",
          AUTH_BASE_URL: "http://localhost:4321",
        },
        secrets: { BETTER_AUTH_SECRET: secret, RESEND_API_KEY: "" },
      },
    ],
  });
  try {
    await server.listen();
    const worker = server.getWorker<Env>();
    const listing = await worker.fetch(
      "http://localhost:4321/api/v1/auth/dev/users",
    );
    assert.equal(listing.status, 404);
    const switching = await worker.fetch(
      "http://localhost:4321/api/v1/auth/dev/switch-user",
      {
        method: "POST",
        headers: {
          origin: "http://localhost:4321",
          "content-type": "application/json",
        },
        body: JSON.stringify({ userId: null }),
      },
    );
    assert.equal(switching.status, 404);
    const deletion = await worker.fetch(
      "http://localhost:4321/api/v1/auth/dev/delete-user",
      {
        method: "POST",
        headers: {
          origin: "http://localhost:4321",
          "content-type": "application/json",
        },
        body: JSON.stringify({ userId: "new-application", confirm: true }),
      },
    );
    assert.equal(deletion.status, 404);
    const shortcut = await worker.fetch(
      "http://localhost:4321/api/v1/auth/dev/application-step",
      {
        method: "POST",
        headers: {
          origin: "http://localhost:4321",
          "content-type": "application/json",
        },
        body: JSON.stringify({ userId: "new-application", step: "review" }),
      },
    );
    assert.equal(shortcut.status, 404);
    const seed = await worker.fetch(
      "http://localhost:4321/api/v1/auth/dev/seed-accounts",
      {
        method: "POST",
        headers: {
          origin: "http://localhost:4321",
          "content-type": "application/json",
        },
        body: "{}",
      },
    );
    assert.equal(seed.status, 404);
  } finally {
    await server.close();
  }
});
