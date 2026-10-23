import { existsSync, mkdirSync } from "node:fs";
import { test } from "vitest";
import { chromium, expect } from "@playwright/test";
import { createTestHarness } from "wrangler";
import { createSignInOTP } from "../helpers/email-otp";
import { addCalendarDays, vancouverInput } from "../../src/data/event-time";

test("event avatars and abbreviated rosters render privately on desktop/mobile, including managed occurrences and maximum capacity", async () => {
  const origin = "https://afterhoursoutreach.ca";
  const secret = "event-attendance-test-secret-12345678901234567890";
  const server = createTestHarness({
    workers: [
      {
        configPath: "dist/server/wrangler.json",
        vars: { APP_ENV: "production", AUTH_BASE_URL: origin },
        secrets: { BETTER_AUTH_SECRET: secret, RESEND_API_KEY: "" },
      },
    ],
  });
  const browser = await chromium.launch({
    executablePath:
      process.env.CHROMIUM_PATH ??
      (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined),
  });
  try {
    await server.listen();
    const worker = server.getWorker<Env>();
    await worker.applyD1Migrations("DB");
    const { DB } = await worker.getEnv();
    const send = (path: string, cookie: string, body?: object) =>
      worker.fetch(`${origin}${path}`, {
        method: body ? "POST" : "GET",
        headers: { origin, "content-type": "application/json", cookie },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    const signIn = async (email: string) => {
      const response = await send(
        "/api/v1/auth/sign-in/email-otp",
        "",
        await createSignInOTP(DB, secret, email),
      );
      expect(response.status).toBe(200);
      const cookie = response.headers
        .getSetCookie()
        .filter((value) => !value.includes("Max-Age=0"))
        .map((value) => value.split(";")[0])
        .join("; ");
      const session = (await (
        await send("/api/v1/auth/get-session", cookie)
      ).json()) as { user: { id: string } };
      return { cookie, id: session.user.id };
    };
    const organizer = await signIn("avatar-organizer@example.org");
    const viewer = await signIn("avatar-viewer@example.org");
    await DB.prepare("UPDATE user SET role='organizer' WHERE id=?")
      .bind(organizer.id)
      .run();
    const personStatements = (id: string, first: string, medic: boolean) => [
      DB.prepare(
        `INSERT INTO profile (user_id,first_name,last_name,preferred_name,phone,birth_date,
        emergency_contact_name,emergency_contact_phone,emergency_contact_relationship,heard_about_us,
        motivation,teams,medical_certification,training_experience,medical_conditions,registered_at,updated_at)
        VALUES (?,?,'PrivateSurname','PRIVATE FULL NAME','PRIVATE PHONE','2000-01-01','PRIVATE CONTACT','555','Friend','Friend','Help',?,'PRIVATE CERT','None','PRIVATE HEALTH',0,0)`,
      ).bind(id, first, medic ? '["medic"]' : "[]"),
      DB.prepare(
        "INSERT INTO volunteer_status (user_id,registration_approved,patrol_approved,approved_by,approved_at,updated_at) VALUES (?,1,1,?,0,0)",
      ).bind(id, organizer.id),
    ];
    await DB.batch(
      [organizer.id, viewer.id].flatMap((id) =>
        personStatements(id, "Viewer", false),
      ),
    );
    await DB.prepare(
      "UPDATE profile SET preferred_name='Viewer' WHERE user_id IN (?,?)",
    )
      .bind(organizer.id, viewer.id)
      .run();
    await DB.prepare(
      `INSERT INTO event (id,type,starts_at,meeting_point,spots,created_by,created_at,updated_at)
      VALUES ('history','orientation',0,'Past point',8,?,0,0), ('crowded','orientation',?,'Maximum capacity',100,?,0,0)`,
    )
      .bind(organizer.id, Date.now() + 86_400_000, organizer.id)
      .run();
    const response = await send("/api/v1/events/action", organizer.cookie, {
      action: "save-series",
      series: {
        firstDate: addCalendarDays(vancouverInput(Date.now()).slice(0, 10), 2),
        localTime: "20:30",
        intervalWeeks: 1,
        endDate: null,
        meetingPoint: "Avatar series",
        meetingPointUrl: "",
        spots: 8,
        includesOrientation: true,
        open: true,
        hidden: false,
      },
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const { id: seriesId } = (await response.json()) as { id: string };
    const events = (
      await DB.prepare(
        "SELECT id FROM event WHERE series_id=? ORDER BY starts_at",
      )
        .bind(seriesId)
        .all<{ id: string }>()
    ).results;
    const booked = events[0].id;
    const empty = events[1].id;
    await DB.prepare("UPDATE event SET meeting_point=? WHERE id=?")
      .bind(
        "Community centre north entrance, beside AfterHoursOutreachCommunityPatrolMeetingPoint",
        empty,
      )
      .run();
    // Three completed medics, three orientees (including a first-time medic),
    // then only real green attendees. The crowded event exercises scrolling at 100.
    for (let index = 0; index < 100; index++) {
      const id = `avatar-attendee-${index}`;
      await DB.batch([
        DB.prepare(
          "INSERT INTO user (id,name,email,created_at,updated_at) VALUES (?,'PRIVATE ACCOUNT NAME',?,0,0)",
        ).bind(id, `${id}@example.org`),
        ...personStatements(
          id,
          index === 0 ? "Medic" : `Member${index}`,
          index < 3 || index === 3,
        ),
      ]);
      if (index < 3 || index >= 6)
        await DB.prepare(
          "INSERT INTO orientation_completion VALUES (?,?, 'history',?,0)",
        )
          .bind(`completion-${index}`, id, organizer.id)
          .run();
      await DB.prepare(
        "INSERT INTO signup (id,event_id,user_id,created_at,updated_at) VALUES (?, 'crowded',?,0,0)",
      )
        .bind(`crowded-${index}`, id)
        .run();
      if (index < 8)
        await DB.prepare(
          "INSERT INTO signup (id,event_id,user_id,created_at,updated_at) VALUES (?,?,?,0,0)",
        )
          .bind(`booked-${index}`, booked, id)
          .run();
    }
    const html = await (await send("/events", viewer.cookie)).text();
    expect(html).not.toMatch(
      /PRIVATE|PrivateSurname|avatar-attendee|data-manage-signup|data-volunteer-profile-link/,
    );
    expect(html).toContain("Medic P.");
    const version = async () =>
      (
        (await (
          await send("/api/v1/events/version", viewer.cookie)
        ).json()) as { version: string }
      ).version;
    expect(await version()).toBe(
      html.match(/data-event-version="([a-f0-9]{64})"/)?.[1],
    );
    const beforePrivateEdit = await version();
    await DB.prepare(
      "UPDATE profile SET medical_conditions='ANOTHER PRIVATE ANSWER' WHERE user_id='avatar-attendee-0'",
    ).run();
    expect(await version()).toBe(beforePrivateEdit);
    await DB.prepare(
      "UPDATE profile SET first_name='Renamed' WHERE user_id='avatar-attendee-0'",
    ).run();
    expect(await version()).not.toBe(beforePrivateEdit);
    await DB.prepare(
      `INSERT INTO event (id,type,starts_at,meeting_point,spots,created_by,created_at,updated_at)
      VALUES ('hidden','orientation',?,'PRIVATE MEETING POINT',8,?,0,0)`,
    )
      .bind(Date.now() + 86_400_000, organizer.id)
      .run();
    await DB.prepare(
      "INSERT INTO signup (id,event_id,user_id,created_at,updated_at) VALUES ('hidden-signup','hidden',?,0,0)",
    )
      .bind(organizer.id)
      .run();
    await DB.prepare("UPDATE event SET hidden=1 WHERE id='hidden'").run();
    const visibleVersion = await version();
    await DB.prepare(
      "UPDATE profile SET first_name='Hidden rename' WHERE user_id=?",
    )
      .bind(organizer.id)
      .run();
    expect(await version()).toBe(visibleVersion);
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.route("**/*", async (route) => {
      const request = route.request();
      if (!request.url().startsWith(origin)) return route.abort();
      const result = await worker.fetch(request.url(), {
        method: request.method(),
        headers: await request.allHeaders(),
        ...(request.postData() ? { body: request.postData()! } : {}),
      });
      await route.fulfill({
        status: result.status,
        headers: Object.fromEntries(result.headers),
        body: Buffer.from(await result.arrayBuffer()),
      });
    });
    const setCookie = async (cookie: string) => {
      await context.clearCookies();
      await context.addCookies(
        cookie.split("; ").map((entry) => {
          const split = entry.indexOf("=");
          return {
            name: entry.slice(0, split),
            value: entry.slice(split + 1),
            url: origin,
          };
        }),
      );
    };
    mkdirSync("/tmp/opencode/event-attendance", { recursive: true });
    let publicName = "Renamed P.";
    for (const manage of [false, true]) {
      await setCookie(manage ? organizer.cookie : viewer.cookie);
      for (const width of [1280, 1920, 800, 375, 320]) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(`${origin}${manage ? "/manage/events" : "/events"}`);
        const list = page.locator("[data-event-list]");
        await expect(
          page.getByRole("region", { name: "About these places" }),
        ).toHaveCount(0);
        const columns = (element: Element) =>
          getComputedStyle(element)
            .gridTemplateColumns.split(" ")
            .filter((track) => parseFloat(track) > 0).length;
        const expectedColumns = width >= 1280 ? 3 : width === 800 ? 2 : 1;
        await expect(list).toHaveCSS("display", "grid");
        await expect(list).toHaveCSS("align-items", "start");
        expect(await list.evaluate(columns)).toBe(expectedColumns);
        if (manage)
          await expect(list.locator(":scope > [data-series-card]")).toHaveCount(
            1,
          );
        await list.evaluate((element) =>
          window.scrollTo({
            top: element.getBoundingClientRect().top + scrollY - 110,
            behavior: "instant",
          }),
        );
        await page.screenshot({
          path: `/tmp/opencode/event-attendance/${manage ? "manage" : "events"}-grid-${width}.png`,
        });
        if (manage) {
          await page
            .locator(
              `[data-series-card="${seriesId}"] > details[data-series-occurrences] > summary`,
            )
            .click();
          expect(
            await page.locator("[data-series-event-list]").evaluate(columns),
          ).toBe(1);
        }
        const card = page.locator(`[data-live-event="${booked}"]`);
        const rosterSelector = manage
          ? ".volunteer-roster"
          : ".public-event-roster";
        await expect(card.locator(rosterSelector)).toHaveCount(1);
        await expect(card.locator(".event-row-label")).toHaveText([
          "Volunteers",
        ]);
        await expect(card.locator(".event-attendance-row")).toHaveCount(1);
        await expect(card.locator(".event-avatar-row")).toHaveAttribute(
          "aria-label",
          "3 approved medics, 2 other volunteers and 3 orientees registered",
        );
        await expect(
          card.locator(".event-avatar-row .attendee-avatar"),
        ).toHaveCount(8);
        await expect(
          card.locator(".event-avatar-row .attendee-medic"),
        ).toHaveCount(3);
        await expect(
          card.locator(".event-avatar-row .attendee-volunteer"),
        ).toHaveCount(2);
        await expect(
          card.locator(".event-avatar-row .attendee-orientee"),
        ).toHaveCount(3);
        for (const [category, color] of [
          ["medic", "rgb(248, 113, 113)"],
          ["volunteer", "rgb(74, 222, 128)"],
          ["orientee", "rgb(96, 165, 250)"],
        ]) {
          const avatar = card
            .locator(`.event-avatar-row .attendee-${category} svg`)
            .first();
          for (const tag of ["circle", "path"]) {
            const shape = avatar.locator(tag);
            await expect(shape).toHaveAttribute("fill", "currentColor");
            await expect(shape).toHaveAttribute("stroke", "none");
            await expect(shape).toHaveCSS("fill", color);
            await expect(shape).toHaveCSS("stroke", "none");
          }
        }
        await expect(card.locator(".event-orientee-box")).toHaveCount(0);
        const emptyCard = page.locator(`[data-live-event="${empty}"]`);
        const emptyRoster = emptyCard.locator(rosterSelector);
        await expect(emptyRoster).toHaveCount(0);
        await expect(emptyCard.locator(".event-row-label")).toHaveText([
          "Volunteers",
        ]);
        await expect(
          emptyCard.locator(".event-attendance .attendee-avatar"),
        ).toHaveCount(0);
        for (const [state, focus] of [
          ["filled", card],
          ["empty", emptyCard],
        ] as const) {
          await expect(focus.locator("details[open]")).toHaveCount(0);
          await focus.evaluate((element) =>
            window.scrollTo({
              top: element.getBoundingClientRect().top + scrollY - 110,
              behavior: "instant",
            }),
          );
          await page.screenshot({
            path: `/tmp/opencode/event-attendance/${manage ? "manage" : "events"}-${state}-collapsed-${width}.png`,
          });
          console.log(
            `${manage ? "manage" : "events"} ${state} ${width}: ${Math.round((await focus.boundingBox())!.height)}px`,
          );
        }
        const expectActionPosition = async () => {
          const position = await emptyCard.evaluate((element) => {
            const bounds = (selector: string) =>
              element.querySelector(selector)!.getBoundingClientRect();
            const action = bounds(".volunteer-actions");
            const attendance = bounds(".event-attendance");
            const details = bounds(".volunteer-event-info");
            const layout = bounds(".volunteer-event-layout");
            return {
              afterAttendance: action.top >= attendance.bottom,
              attendanceAfterInfo: attendance.top >= details.bottom,
              leftOffset: action.left - layout.left,
              rightOffset: action.right - layout.right,
              controlHeight: bounds(".volunteer-actions .btn").height,
              controlWidth: bounds(".volunteer-actions .btn").width,
              layoutWidth: layout.width,
            };
          });
          expect(position.afterAttendance).toBe(true);
          expect(position.attendanceAfterInfo).toBe(true);
          expect(position.controlHeight).toBeGreaterThanOrEqual(44);
          expect(Math.abs(position.leftOffset)).toBeLessThan(1);
          expect(Math.abs(position.rightOffset)).toBeLessThan(1);
          expect(
            Math.abs(position.controlWidth - position.layoutWidth),
          ).toBeLessThan(1);
        };
        await expectActionPosition();
        if (manage) {
          await expect(emptyCard.locator("[data-live-signup]")).toHaveCount(0);
          await expect(
            emptyCard.getByRole("button", { name: "Edit", exact: true }),
          ).toBeVisible();
        } else {
          await expect(emptyCard.locator("[data-live-signup]")).toHaveCount(1);
        }
        if (width === 375) {
          const setRegistration = async (join: boolean) => {
            if (manage) {
              const response = await send(
                "/api/v1/events/action",
                viewer.cookie,
                { action: join ? "join" : "cancel", id: empty },
              );
              expect(response.status, await response.clone().text()).toBe(200);
            } else {
              await emptyCard
                .getByRole("button", {
                  name: join ? "Register" : "Unregister",
                  exact: true,
                })
                .click();
              await expect(
                emptyCard.getByRole("button", {
                  name: join ? "Unregister" : "Register",
                  exact: true,
                }),
              ).toBeEnabled();
            }
          };
          await setRegistration(true);
          await expect(emptyRoster.locator("summary")).toHaveText(
            "Volunteers (1)",
            { timeout: 15_000 },
          );
          await expect(
            emptyCard.locator(".event-avatar-row .attendee-avatar"),
          ).toHaveCount(1);
          await expect(emptyRoster).not.toHaveAttribute("open");
          await emptyRoster.locator("summary").click();
          await expectActionPosition();
          await setRegistration(false);
          await expect(emptyRoster).toHaveCount(0, { timeout: 15_000 });
          await expect(
            emptyCard.locator(".event-attendance .attendee-avatar"),
          ).toHaveCount(0);
        }
        const crowded = page.locator('[data-live-event="crowded"]');
        await expect(
          crowded.locator(".event-avatar-row .attendee-avatar"),
        ).toHaveCount(100);
        expect(
          await crowded.locator(".event-avatar-row").evaluate((element) => ({
            rows: new Set(
              [...element.children].map(
                (avatar) => avatar.getBoundingClientRect().top,
              ),
            ).size,
            scrollable: element.scrollWidth > element.clientWidth,
          })),
        ).toEqual({ rows: 1, scrollable: true });
        if (manage) {
          await card.locator(".volunteer-roster > summary").click();
          await expect(card.locator(".volunteer-roster li")).toHaveCount(8);
        } else {
          await card.locator(".public-event-roster > summary").click();
          const roster = card.locator(".public-event-roster");
          await expect(roster.locator("li")).toHaveCount(8);
          await expect(roster.locator("a, input, button")).toHaveCount(0);
          await expect(roster.locator("li").first()).toHaveText(publicName);
          await expect(
            roster.locator("li").first().locator(".attendee-medic"),
          ).toHaveCSS("color", "rgb(248, 113, 113)");
          await expect(roster.locator(".attendee-volunteer").first()).toHaveCSS(
            "color",
            "rgb(74, 222, 128)",
          );
          await expect(roster.locator(".attendee-orientee").first()).toHaveCSS(
            "color",
            "rgb(96, 165, 250)",
          );
          if (width === 1280) {
            await roster.locator("summary").focus();
            await DB.prepare(
              "UPDATE profile SET first_name='Live' WHERE user_id='avatar-attendee-0'",
            ).run();
            publicName = "Live P.";
            await expect(roster.locator("li").first()).toHaveText(publicName, {
              timeout: 15_000,
            });
            await expect(roster).toHaveAttribute("open", "");
            await expect(roster.locator("summary")).toBeFocused();
          }
        }
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth > innerWidth,
          ),
        ).toBe(false);
        expect(
          await page
            .locator(".volunteer-event-list, .volunteer-event-card")
            .evaluateAll((elements) =>
              elements.some(
                (element) => element.scrollWidth > element.clientWidth + 1,
              ),
            ),
        ).toBe(false);
        for (const [state, focus] of [
          ["legend", legend],
          ["roster", card],
          ["crowded", crowded],
        ] as const)
          await focus.screenshot({
            path: `/tmp/opencode/event-attendance/${manage ? "manage" : "events"}-${state}-${width}.png`,
            style: "header, [data-skip-to-main] { visibility: hidden; }",
          });
        if (manage) {
          await page.locator('[data-event-filter="recurring"]').click();
          expect(await list.evaluate(columns)).toBe(1);
          const series = list.locator(":scope > [data-series-card]");
          expect(
            Math.abs(
              (await series.boundingBox())!.width -
                (await list.boundingBox())!.width,
            ),
          ).toBeLessThan(1);
          // A lone series fills the row; occurrences still use that container,
          // not the viewport (at 800px there is only room for one nested track).
          expect(
            await series.locator("[data-series-event-list]").evaluate(columns),
          ).toBe(width >= 1280 ? 3 : 1);
        }
      }
    }
  } finally {
    await browser.close();
    await server.close();
  }
}, 60_000);
