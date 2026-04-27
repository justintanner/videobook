import { describe, expect, it } from "vitest";
import { defaultCharacterWardrobeClause } from "./generate-character.js";
import { normalizeCharacterSex } from "../jobs/extract-character.js";

describe("character sheet prompt defaults", () => {
  it("does not put a bra on male characters", () => {
    const clause = defaultCharacterWardrobeClause("male").toLowerCase();

    expect(clause).toContain("no bra");
    expect(clause).toContain("boxer briefs");
    expect(clause).not.toContain("bra top");
  });

  it("keeps female baseline garments explicit", () => {
    const clause = defaultCharacterWardrobeClause("female").toLowerCase();

    expect(clause).toContain("bra top");
    expect(clause).toContain("high-waist briefs");
  });

  it("maps legacy presentation values to sex values", () => {
    expect(normalizeCharacterSex("masculine")).toBe("male");
    expect(normalizeCharacterSex("feminine")).toBe("female");
  });
});
