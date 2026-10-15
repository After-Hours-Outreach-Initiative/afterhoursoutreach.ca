import assert from "node:assert/strict";
import { test } from "vitest";
import { formatPhoneNumber } from "../src/scripts/phone-input";

test("phone numbers gain dashes as digits are entered", () => {
  for (const [value, expected] of [
    ["", ""],
    ["6", "6"],
    ["604", "604"],
    ["6045", "604-5"],
    ["604555", "604-555"],
    ["6045550", "604-555-0"],
    ["6045550100", "604-555-0100"],
    ["(604) 555.0100", "604-555-0100"],
    ["604-555-0100", "604-555-0100"],
  ]) {
    assert.equal(formatPhoneNumber(value), expected);
    assert.equal(formatPhoneNumber(expected), expected);
  }
});

test("phone formatting retains country prefixes and extensions", () => {
  for (const [value, expected] of [
    ["+", "+"],
    ["+1", "+1"],
    ["+1604", "+1-604"],
    ["+1 (604) 555-0100", "+1-604-555-0100"],
    ["  +1 (604) 555 0100  ", "+1-604-555-0100"],
    ["16045550100", "1-604-555-0100"],
    ["1 (604) 555 0100 x123", "1-604-555-0100 x123"],
    ["6045550100x", "604-555-0100x"],
    ["6045550100 X 123", "604-555-0100 X 123"],
  ]) {
    assert.equal(formatPhoneNumber(value), expected);
    assert.equal(formatPhoneNumber(expected), expected);
  }
});

test("other phone formats and invalid answers are not truncated or silently repaired", () => {
  for (const value of [
    "+44 20 7946 0958",
    "+33 1 42 68 53 00",
    "6045550100999",
    "+16045550100999",
    "604+5550100",
    "invalid",
    "6045550100 ext. 123",
  ])
    assert.equal(formatPhoneNumber(value), value);
});
