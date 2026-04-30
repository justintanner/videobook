import { describe, expect, it } from "vitest";
import {
  buildCharacterPrompt,
  defaultCharacterWardrobeClause,
  type CharacterPromptProfile,
} from "./generate-character.js";
import { normalizeCharacterSubjectKind } from "../jobs/extract-character.js";

const maleProfile: CharacterPromptProfile = {
  subject_kind: "male",
  age: "mid-40s",
  ethnicity: "White / Northern European",
  height: "tall, ~6'0\" / 183cm",
  build: "athletic",
  bust: "broad athletic chest",
  waist: "narrow tapered waist",
  hips: "narrow and straight",
  face: "oval face with square jawline",
  hair: "short wavy light brown hair, side parted",
  eyes: "light blue rounded eyes",
  skin: "fair skin with light texture",
  source_image_asset_id: "img-source",
};

const femaleProfile: CharacterPromptProfile = {
  ...maleProfile,
  subject_kind: "female",
  bust: "small b-cup, even distribution",
};

const animalProfile: CharacterPromptProfile = {
  subject_kind: "animal",
  other:
    "white domestic longhair cat, slender build, fluffy medium-long silky white fur, " +
    "heterochromatic blue and golden eyes, pointed ears, plumed tail",
  source_image_asset_id: "img-cat",
};

const otherProfile: CharacterPromptProfile = {
  subject_kind: "other",
  other:
    "origami paper man, folded white cardstock with sharp creases, blank flat face, " +
    "articulated arms and legs, ~30cm tall",
  source_image_asset_id: "img-paper-man",
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

  it("maps a missing subject_kind to male as a fallback", () => {
    expect(normalizeCharacterSubjectKind({})).toBe("male");
  });

  it("keeps the female-specific hair-up/hair-down layout", () => {
    const prompt = buildCharacterPrompt(femaleProfile, "nano_banana_pro", "kie", undefined).toLowerCase();

    expect(prompt).toContain("hair down");
    expect(prompt).toContain("hair up");
  });

  it("preserves reference hair for male sheets", () => {
    const prompt = buildCharacterPrompt(maleProfile, "nano_banana_pro", "kie", undefined).toLowerCase();

    expect(prompt).toContain("same hairstyle from reference image 1");
    expect(prompt).toContain("do not tie back");
    expect(prompt).not.toContain("hair up");
    expect(prompt).not.toContain("hair down");
  });

  it("uses animal layout without human wardrobe or hairstyle language", () => {
    const prompt = buildCharacterPrompt(animalProfile, "nano_banana_pro", "kie", undefined).toLowerCase();

    expect(prompt).toContain("animal character reference sheet");
    expect(prompt).toContain("natural species-appropriate posture");
    expect(prompt).not.toContain("bra");
    expect(prompt).not.toContain("underwear");
    expect(prompt).not.toContain("hair up");
    expect(prompt).not.toContain("hair down");
    expect(prompt).not.toContain("arms relaxed");
  });

  it("uses the generic 'other' subject sheet for non-living subjects", () => {
    const prompt = buildCharacterPrompt(otherProfile, "nano_banana_pro", "kie", undefined).toLowerCase();

    expect(prompt).toContain("subject reference sheet");
    expect(prompt).toContain("origami paper man");
    expect(prompt).toContain("no wardrobe: render the subject as-is");
    expect(prompt).not.toContain("bra");
    expect(prompt).not.toContain("boxer briefs");
    expect(prompt).not.toContain("hair up");
    expect(prompt).not.toContain("hair down");
  });

  it("rejects female/male profiles missing required body fields", () => {
    expect(() =>
      buildCharacterPrompt(
        { ...femaleProfile, bust: undefined },
        "nano_banana_pro",
        "kie",
        undefined,
      ),
    ).toThrow(/profile\.bust is required/);
  });

  it("rejects animal/other profiles missing the freeform 'other' field", () => {
    expect(() =>
      buildCharacterPrompt(
        { ...otherProfile, other: undefined },
        "nano_banana_pro",
        "kie",
        undefined,
      ),
    ).toThrow(/profile\.other is required/);
  });

  it("numbers outfit references after multiple identity references", () => {
    const prompt = buildCharacterPrompt(maleProfile, "nano_banana_pro", "kie", "dark suit", 3, 4);

    expect(prompt).toContain("Reference Images 1-3 are identity references");
    expect(prompt).toContain("Reference Image 4");
    expect(prompt).toContain("dark suit");
  });
});
