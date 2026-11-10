import { expect, test } from "vitest";
import {
  auditAction,
  auditFilters,
  formatAuditTime,
} from "../src/data/audit-log";

// Vancouver stays on UTC−7 year-round from 2026.
const vancouver = (iso: string) => new Date(iso).getTime();

test("audit times read relative to the Vancouver day", () => {
  const now = vancouver("2026-11-09T21:00:00-07:00");
  expect(formatAuditTime(vancouver("2026-11-09T16:14:00-07:00"), now)).toBe(
    "Today at 4:14 p.m.",
  );
  expect(formatAuditTime(vancouver("2026-11-08T23:59:00-07:00"), now)).toBe(
    "Yesterday at 11:59 p.m.",
  );
  expect(formatAuditTime(vancouver("2026-11-04T16:32:00-07:00"), now)).toBe(
    "Last Wednesday at 4:32 p.m.",
  );
  expect(formatAuditTime(vancouver("2026-10-02T09:05:00-07:00"), now)).toBe(
    "Oct 2 at 9:05 a.m.",
  );
  expect(formatAuditTime(vancouver("2025-10-02T09:05:00-07:00"), now)).toBe(
    "Oct 2, 2025 at 9:05 a.m.",
  );
});

test("audit filters accept several users and only known actions", () => {
  expect(
    auditFilters(
      new URLSearchParams(
        "user=u1&user=u2&user=u1&action=series%3Astopped&action=event%3Acreated",
      ),
    ),
  ).toEqual({
    users: ["u1", "u2"],
    actions: ["series:stopped", "event:created"],
  });
  expect(
    auditFilters(new URLSearchParams("action=person%3Acreated")).actions,
  ).toEqual([]);
  expect(auditAction("event", "created").sentence).toEqual(["created", ""]);
  expect(auditAction("person", "something_new").label).toBe("Something new");
});
