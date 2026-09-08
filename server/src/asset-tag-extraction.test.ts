import { describe, expect, it } from "vitest";
import {
  isFallbackAnalysis,
  tagsFromImageAnalysis,
  tagsFromScriptText,
  tagsFromTranscript,
  tagsFromVideoAnalysis,
} from "./asset-tag-extraction.js";
import {
  MAX_AUTOMATIC_TAGS,
  canonicalizeTag,
  matchVocabularyTerms,
  selectEditorialTags,
  vocabularyFor,
} from "./tag-vocabulary.js";

function identities(tags: Array<{ facet: string; label: string }>): string[] {
  return tags.map((tag) => `${tag.facet}/${tag.label}`);
}

describe("editorial vocabulary", () => {
  it("converges the spellings editors actually type", () => {
    for (const spelling of ["close up", "closeup", "Close-Up", "tight shot", "CU"]) {
      expect(canonicalizeTag("editing", spelling)).toEqual({
        facet: "editing",
        label: "close-up",
      });
    }
    expect(canonicalizeTag("places", "Indoors")).toEqual({
      facet: "places",
      label: "interior",
    });
  });

  it("refuses terms outside a closed facet", () => {
    // People and editing are closed: an unlisted term is a model inventing a
    // grouping label, which defeats the point of a shared vocabulary.
    expect(canonicalizeTag("people", "a tall man")).toBeNull();
    expect(canonicalizeTag("editing", "dutch angle")).toBeNull();
    expect(canonicalizeTag("editing", "beautiful")).toBeNull();
  });

  it("only admits an unlisted place when the caller knows it is one", () => {
    expect(canonicalizeTag("places", "subway")).toBeNull();
    expect(canonicalizeTag("places", "subway", { allowUnlisted: true })).toEqual({
      facet: "places",
      label: "subway",
    });
    // Even then, praise and mood are never settings.
    expect(canonicalizeTag("places", "moody", { allowUnlisted: true })).toBeNull();
    expect(
      canonicalizeTag("places", "a long rambling description of a room", {
        allowUnlisted: true,
      }),
    ).toBeNull();
  });

  it("finds vocabulary inside prose without matching word fragments", () => {
    expect(identities(matchVocabularyTerms("places", "A domestic kitchen")))
      .toEqual(["places/kitchen"]);
    expect(identities(matchVocabularyTerms("editing", "shot handheld on a busy street")))
      .toEqual(["editing/handheld"]);
    // "day" must not be found inside "daydream".
    expect(matchVocabularyTerms("places", "a daydream")).toEqual([]);
  });

  it("caps selection without turning the ceiling into a quota", () => {
    const many = Array.from({ length: 40 }, () => ({
      facet: "editing" as const,
      label: "close up",
    }));
    expect(selectEditorialTags(many)).toHaveLength(1);

    const varied = vocabularyFor("editing").map((label) => ({
      facet: "editing" as const,
      label,
    }));
    expect(varied.length).toBeGreaterThan(MAX_AUTOMATIC_TAGS);
    expect(selectEditorialTags(varied)).toHaveLength(MAX_AUTOMATIC_TAGS);
    expect(selectEditorialTags([])).toEqual([]);
  });
});

describe("evidence extractors", () => {
  it("does not turn negation, incidental objects, or sparse frames into editing claims", () => {
    const extracted = tagsFromVideoAnalysis({
      summary: "A presenter gives a solo tutorial.", setting: "Kitchen with a frying pan",
      subjects: ["one person"], tags: ["not an interview", "panning", "handheld", "music"],
      actions: ["tilting a pan"], scenes: [{ tags: ["not a close-up", "tracking shot"] }],
    });
    expect(identities(extracted.tags).sort()).toEqual(["people/solo subject", "places/kitchen"]);
    expect(tagsFromVideoAnalysis({ summary: "A blank wall", setting: "not kitchen" }).tags).toEqual([]);
    expect(tagsFromVideoAnalysis({
      summary: "A close-up", setting: "Kitchen with a pan", tags: ["interview"],
      editorialTags: [{ facet: "editing", label: "closeup" }, { facet: "editing", label: "pan" }],
    }).tags).toEqual([{ facet: "editing", label: "close-up" }]);
    expect(tagsFromImageAnalysis({ tags: [{ facet: "editing", label: "tracking" }] }).tags).toEqual([]);
  });

  it("distinguishes missing and malformed image tag evidence from a valid empty result", () => {
    for (const tags of [undefined, null, "closeup", {}, ["closeup"], [{ facet: "vibes", label: "good" }]]) {
      expect(tagsFromImageAnalysis({ prompt: "legacy", tags }).outcome).toBe("no_evidence");
    }
    expect(tagsFromImageAnalysis({ prompt: "abstract", tags: [] }).outcome).toBe("no_useful_evidence");
  });

  it("reads only the vocabulary out of a video analysis", () => {
    const extraction = tagsFromVideoAnalysis({
      summary: "Someone talks to camera.",
      setting: "A busy street at night",
      subjects: ["one person"],
      tags: ["vlog", "beautiful", "handheld"],
      actions: [],
      scenes: [],
    });
    expect(extraction.outcome).toBe("tagged");
    const labels = identities(extraction.tags);
    expect(labels).toContain("places/street");
    expect(labels).toContain("places/night");
    expect(labels).toContain("people/solo subject");
    expect(labels).not.toContain("editing/handheld");
    expect(labels.join(" ")).not.toContain("vlog");
    expect(labels.join(" ")).not.toContain("beautiful");
  });

  it("separates a failed analysis from one that found nothing to group by", () => {
    const fallback = {
      summary: "", scenes: [], tags: [], mood: "",
      subjects: [], actions: [], setting: "", textOnScreen: [],
    };
    expect(isFallbackAnalysis(fallback)).toBe(true);
    expect(tagsFromVideoAnalysis(fallback).outcome).toBe("no_evidence");
    expect(tagsFromVideoAnalysis(null).outcome).toBe("no_evidence");

    const analyzed = tagsFromVideoAnalysis({
      summary: "An abstract pattern shifts.",
      setting: "",
      subjects: [],
      tags: ["abstract"],
      actions: [],
      scenes: [],
    });
    expect(analyzed.outcome).toBe("no_useful_evidence");
    expect(analyzed.tags).toEqual([]);
  });

  it("takes image tags from the structured response and drops the rest", () => {
    const extraction = tagsFromImageAnalysis({
      prompt: "a kitchen counter",
      tags: [
        { facet: "places", label: "kitchen" },
        { facet: "places", label: "subway platform" },
        { facet: "people", label: "an older woman" },
        { facet: "editing", label: "closeup" },
        { facet: "nonsense", label: "whatever" },
        "not a record",
      ],
    });
    expect(identities(extraction.tags)).toEqual([
      "places/kitchen",
      "places/subway platform",
      "editing/close-up",
    ]);
    // An analysis cached before tags existed yields nothing rather than
    // mining the reproduction prompt for words.
    expect(tagsFromImageAnalysis({ prompt: "a kitchen counter" }).outcome)
      .toBe("no_evidence");
  });

  it("claims only what a transcript can support", () => {
    expect(tagsFromTranscript(null).outcome).toBe("no_evidence");
    expect(identities(tagsFromTranscript({ wordCount: 120, speakerCount: 1 }).tags))
      .toEqual(["editing/dialogue"]);
    expect(identities(tagsFromTranscript({ wordCount: 400, speakerCount: 3 }).tags))
      .toEqual(["editing/dialogue"]);
    expect(identities(tagsFromTranscript({ wordCount: 0, speakerCount: 0 }).tags))
      .toEqual([]);
  });

  it("reads a script's sluglines and nothing else", () => {
    const extraction = tagsFromScriptText(
      "INT. KITCHEN - NIGHT\n\nShe stirs a beautiful pot.\n\nEXT. STREET - DAY\n\nHe walks.",
    );
    expect(identities(extraction.tags).sort()).toEqual([
      "places/day",
      "places/exterior",
      "places/interior",
      "places/night",
    ]);
    expect(tagsFromScriptText("Just some notes about the edit.").outcome)
      .toBe("no_useful_evidence");
    expect(tagsFromScriptText("").outcome).toBe("no_evidence");
    expect(tagsFromScriptText(null).outcome).toBe("no_evidence");
  });
});
