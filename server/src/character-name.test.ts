import { describe, expect, it } from "vitest";
import {
  bareAssetId,
  characterNameStem,
  resolveCharacterCreateName,
} from "./character-name.js";

describe("characterNameStem", () => {
  it("takes the source artifact's label verbatim", () => {
    expect(characterNameStem("french-head")).toBe("french-head");
    expect(characterNameStem("  french-head  ")).toBe("french-head");
    expect(characterNameStem("French Head")).toBe("French Head");
    expect(characterNameStem("the-guy")).toBe("the-guy");
  });

  it("rejects degenerate stems under 3 chars", () => {
    expect(characterNameStem("n")).toBe("");
    expect(characterNameStem("ab")).toBe("");
    expect(characterNameStem("")).toBe("");
  });
});

describe("resolveCharacterCreateName", () => {
  it("prefers explicit name parts", () => {
    expect(resolveCharacterCreateName(["alice"], ["face"])).toBe("alice");
    expect(resolveCharacterCreateName(["the", "guy"], [])).toBe("the-guy");
  });

  it("stems from the first image label when no explicit name", () => {
    expect(resolveCharacterCreateName([], ["french-head"])).toBe("french-head");
    expect(resolveCharacterCreateName([], ["face", "body"])).toBe("face");
  });

  it("falls back to character for degenerate or missing labels", () => {
    expect(resolveCharacterCreateName([], ["n"])).toBe("character");
    expect(resolveCharacterCreateName([], [""])).toBe("character");
    expect(resolveCharacterCreateName([], [])).toBe("character");
  });
});

describe("bareAssetId", () => {
  it("strips leading @", () => {
    expect(bareAssetId("@019fcc00-0000-7000-8000-0000000000aa"))
      .toBe("019fcc00-0000-7000-8000-0000000000aa");
    expect(bareAssetId("019fcc00-0000-7000-8000-0000000000aa"))
      .toBe("019fcc00-0000-7000-8000-0000000000aa");
  });
});
