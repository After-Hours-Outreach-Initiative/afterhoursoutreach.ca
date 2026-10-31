import { expect, test } from "vitest";
import { applicationListState } from "../src/data/volunteer-list";
import {
  createTableFixture,
  readTableOptions,
} from "../src/dev/ui/table-fixtures";

test.each([
  { direction: "asc", expected: [7, 5, 3, 1, 0, 4, 6, 2] },
  { direction: "desc", expected: [6, 2, 0, 4, 7, 5, 3, 1] },
])(
  "application playground status $direction keeps newest completions first within each group",
  ({ direction, expected }) => {
    const params = new URLSearchParams({ direction });
    const { people } = createTableFixture(
      "applications",
      readTableOptions("applications", params),
      applicationListState(params),
    );
    expect(people.rows.map(({ id }) => id)).toEqual(
      expected.map((index) => `ui-applications-${index}`),
    );
  },
);

test.each(["asc", "desc"])(
  "application playground ready-for-review filter keeps newest first with status %s",
  (direction) => {
    const params = new URLSearchParams({ approval: "awaiting", direction });
    const { people } = createTableFixture(
      "applications",
      readTableOptions("applications", params),
      applicationListState(params),
    );
    expect(people.rows.map(({ id }) => id)).toEqual(
      [7, 5, 3, 1].map((index) => `ui-applications-${index}`),
    );
    expect(people.awaitingApprovalCount).toBe(4);
  },
);
