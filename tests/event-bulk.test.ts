import { expect, test } from "vitest";
import { bulkEventAction } from "../src/scripts/event-bulk";

const form = (fields: Record<string, string>) => {
  const values = new FormData();
  values.set("selection", "[]");
  for (const [name, value] of Object.entries(fields)) values.set(name, value);
  return values;
};

test("bulk visibility sets registration and visibility together", () => {
  expect(
    bulkEventAction(
      form({
        initial: JSON.stringify({ publicVisibility: "true" }),
        publicVisibility: "false",
      }),
    ).changes,
  ).toEqual({ open: false, hidden: true });
  expect(
    bulkEventAction(
      form({ initial: JSON.stringify({ publicVisibility: null }) }),
    ).changes,
  ).toEqual({});
  expect(
    bulkEventAction(
      form({
        initial: JSON.stringify({ publicVisibility: null }),
        publicVisibility: "true",
      }),
    ).changes,
  ).toEqual({ open: true, hidden: false });
});
