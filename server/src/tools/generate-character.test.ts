import { describe, expect, it } from "vitest";
import {
  buildCharacterPrompt,
  defaultCharacterWardrobeClause,
  type CharacterPromptProfile,
} from "./generate-character.js";
import { normalizeCharacterSex, normalizeCharacterSubjectKind } from "../jobs/extract-character.js";

const humanProfile: CharacterPromptProfile = {
  subject_kind: "human",
  age: "mid-40s",
  sex: "male",
  ethnicity: "White / Northern European",
  height: "tall, ~6'0\" / 183cm",
  build: "athletic",
  bust: "broad athletic chest",
  waist: "narrow tapered waist",
  hips: "narrow and straight",
  glutes: "firm athletic",
  face: "oval face with square jawline",
  hair: "short wavy light brown hair, side parted",
  eyes: "light blue rounded eyes",
  skin: "fair skin with light texture",
  distinguishing_features: "none visible",
  source_image_asset_id: "img-source",
};

const animalProfile: CharacterPromptProfile = {
  subject_kind: "animal",
  age: "young adult",
  ethnicity: "white domestic longhair cat",
  height: "small, ~1'0\" / 30cm",
  build: "slender",
  bust: "narrow chest with fluffy fur coverage",
  waist: "slim tapered midsection",
  hips: "rounded hindquarters",
  glutes: "soft tail base",
  face: "wedge-shaped muzzle with pointed ears",
  hair: "pure white medium-long dense silky fur",
  eyes: "heterochromatic blue and golden eyes",
  skin: "soft dense coat texture",
  distinguishing_features: "one blue eye and one golden eye",
  source_image_asset_id: "img-cat",
};

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

  it("maps alternate presentation spellings to canonical sex values", () => {
    expect(normalizeCharacterSex("masculine")).toBe("male");
    expect(normalizeCharacterSex("feminine")).toBe("female");
  });

  it("maps missing subject kind to human", () => {
    expect(normalizeCharacterSubjectKind(undefined)).toBe("human");
    expect(normalizeCharacterSubjectKind("animal")).toBe("animal");
  });

  it("defaults profiles missing subject_kind to human sheets", () => {
    const { subject_kind, ...profileWithoutKind } = humanProfile;
    const prompt = buildCharacterPrompt(profileWithoutKind, "nano_banana_pro", "kie", undefined).toLowerCase();

    expect(subject_kind).toBe("human");
    expect(prompt).toContain("character reference sheet");
    expect(prompt).not.toContain("animal character reference sheet");
  });

  it("preserves reference hair for male human sheets", () => {
    const prompt = buildCharacterPrompt(humanProfile, "nano_banana_pro", "kie", undefined).toLowerCase();

    expect(prompt).toContain("same hairstyle from reference image 1");
    expect(prompt).toContain("do not tie back");
    expect(prompt).not.toContain("hair up");
    expect(prompt).not.toContain("hair down");
  });

  it("keeps varied hair shots for female human sheets", () => {
    const prompt = buildCharacterPrompt(
      { ...humanProfile, sex: "female", bust: "small b-cup, even distribution" },
      "nano_banana_pro",
      "kie",
      undefined,
    ).toLowerCase();

    expect(prompt).toContain("hair down");
    expect(prompt).toContain("hair up");
  });

  it("uses animal layout without human wardrobe or hairstyle language", () => {
    const prompt = buildCharacterPrompt(animalProfile, "nano_banana_pro", "kie", undefined).toLowerCase();

    expect(prompt).toContain("animal character reference sheet");
    expect(prompt).toContain("coat/fur");
    expect(prompt).toContain("natural species-appropriate posture");
    expect(prompt).not.toContain("bra");
    expect(prompt).not.toContain("underwear");
    expect(prompt).not.toContain("hair up");
    expect(prompt).not.toContain("hair down");
    expect(prompt).not.toContain("arms relaxed");
  });

  it("numbers outfit references after multiple identity references", () => {
    const prompt = buildCharacterPrompt(humanProfile, "nano_banana_pro", "kie", "dark suit", 3, 4);

    expect(prompt).toContain("Reference Images 1-3 are identity references");
    expect(prompt).toContain("Reference Image 4");
    expect(prompt).toContain("dark suit");
  });
});
