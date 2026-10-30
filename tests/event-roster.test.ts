import { expect, test } from "vitest";
import { publicAttendeeName } from "../src/data/event-roster";

test("public rosters use first names and last initials, with an abbreviated legacy fallback", () => {
  expect(
    publicAttendeeName(" Alice ", " PrivateSurname ", "PRIVATE PREFERRED NAME"),
  ).toBe("Alice P.");
  expect(publicAttendeeName(null, null, "Legacy Middle PrivateSurname")).toBe(
    "Legacy P.",
  );
  expect(publicAttendeeName(null, null, "OneName")).toBe("O.");
  expect(publicAttendeeName(null, null, " ")).toBe("Outreach Volunteer");
  expect(publicAttendeeName("Élodie", "李", "Ignored")).toBe("Élodie 李.");
});

test("rosters prefer a defined preferred name and keep the last name abbreviated", () => {
  expect(
    publicAttendeeName("Alice", "PrivateSurname", "Ignored", " Ally "),
  ).toBe("Ally P.");
  expect(publicAttendeeName("Mary", "Jones", "Ignored", "Mary Jane")).toBe(
    "Mary Jane J.",
  );
  for (const preferredName of [null, "", "  "])
    expect(
      publicAttendeeName(
        " Alice ",
        " PrivateSurname ",
        "Ignored",
        preferredName,
      ),
    ).toBe("Alice P.");
  expect(
    publicAttendeeName(
      null,
      null,
      "Legacy Middle PrivateSurname",
      "Legacy Middle PrivateSurname",
    ),
  ).toBe("Legacy P.");
});
