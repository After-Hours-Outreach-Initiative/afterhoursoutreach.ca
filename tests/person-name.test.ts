import assert from "node:assert/strict";
import { test } from "vitest";
import {
  compactPersonDisplayName,
  personDisplayName,
} from "../src/data/person-name";

test("compact names shorten only the given portion, preserving the full source name", () => {
  const name = personDisplayName({
    preferredName:
      "Alexanderthegreatesteverlastingunbrokenvolunteernamefortablewrapping",
    lastName: "Smith",
  });
  assert.equal(compactPersonDisplayName(name), "Alexanderthegreatest… S.");
  assert.equal(
    name,
    "Alexanderthegreatesteverlastingunbrokenvolunteernamefortablewrapping S.",
  );
  for (const unchanged of [
    "Alex S.",
    "a".repeat(20) + " S.",
    "S.",
    "Volunteer",
    "",
  ])
    assert.equal(compactPersonDisplayName(unchanged), unchanged);
  assert.equal(
    compactPersonDisplayName("Alexandria Jordan Marie Jacqueline 𠮷."),
    "Alexandria Jordan Ma… 𠮷.",
  );
  assert.equal(compactPersonDisplayName("a".repeat(21)), "a".repeat(20) + "…");
  assert.equal(
    compactPersonDisplayName("Legacy generic label without an initial"),
    "Legacy generic label…",
  );
});

test("compact names preserve Unicode graphemes and don't ellipsize at the limit", () => {
  for (const grapheme of ["𠮷", "e\u0301", "👩🏽‍⚕️"]) {
    const given = grapheme.repeat(20);
    assert.equal(compactPersonDisplayName(`${given} 李.`), `${given} 李.`);
    assert.equal(
      compactPersonDisplayName(`${given}${grapheme} 李.`),
      `${given}… 李.`,
    );
  }
});
