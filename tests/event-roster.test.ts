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
  expect(publicAttendeeName(null, null, " ")).toBe("Volunteer");
  expect(publicAttendeeName("Élodie", "李", "Ignored")).toBe("Élodie 李.");
});
