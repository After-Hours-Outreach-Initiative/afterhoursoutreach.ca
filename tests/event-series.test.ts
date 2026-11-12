import { expect, test } from "vitest";
import { seriesCadence } from "../src/data/event-series";

test("series cadence names the interval and skips one-off events", () => {
  expect(seriesCadence({ intervalWeeks: 2 })).toBe("Every 2 weeks");
  expect(seriesCadence({ intervalWeeks: 1 })).toBe("Every week");
  expect(seriesCadence({ intervalWeeks: null })).toBeNull();
});
