import { describe, expect, it } from "vitest";
import {
  bareAssetId,
  characterNameStem,
  resolveCharacterCreateName,
} from "./character-name.js";

describe("characterNameStem", () => {
  it("strips img- / char- prefixes", () => {
    expect(characterNameStem("img-french-head")).toBe("french-head");
    expect(characterNameStem("@img-french-head")).toBe("french-head");
    expect(characterNameStem("char-img-french-head")).toBe("french-head");
    expect(characterNameStem("char-french-head")).toBe("french-head");
    expect(characterNameStem("char-the-guy")).toBe("the-guy");
  });

  it("rejects degenerate stems under 3 chars", () => {
    expect(characterNameStem("img-n")).toBe("");
    expect(characterNameStem("img-ab")).toBe("");
    expect(characterNameStem("char-x")).toBe("");
  });
});

describe("resolveCharacterCreateName", () => {
  it("prefers explicit name parts", () => {
    expect(resolveCharacterCreateName(["alice"], ["img-face"])).toBe("alice");
    expect(resolveCharacterCreateName(["the", "guy"], [])).toBe("the-guy");
  });

  it("stems from first image when no explicit name", () => {
    expect(resolveCharacterCreateName([], ["img-french-head"])).toBe("french-head");
    expect(resolveCharacterCreateName([], ["@img-face", "img-body"])).toBe("face");
  });

  it("falls back to character for degenerate image stems", () => {
    expect(resolveCharacterCreateName([], ["img-n"])).toBe("character");
  });
});

describe("bareAssetId", () => {
  it("strips leading @", () => {
    expect(bareAssetId("@img-x")).toBe("img-x");
    expect(bareAssetId("img-x")).toBe("img-x");
  });
});
