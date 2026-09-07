import { describe, expect, it } from "vitest";
import {
  tagsFromImageAnalysis,
  tagsFromVideoAnalysis,
} from "./asset-tag-extraction.js";
import { MAX_AUTOMATIC_TAGS } from "./tag-vocabulary.js";

/**
 * A frozen set of analysis documents, and what an editor should be able to do
 * with the tags they produce.
 *
 * These assert grouping usefulness, not phrasing. A model is free to describe
 * a studio interview however it likes; what must hold is that two angles of
 * the same interview end up in one group, that a beach establishing shot does
 * not join them, and that a fruit bowl on a counter never becomes a way to
 * find footage. Asserting sentences would test the model's prose and break on
 * every rewording; asserting groups tests the thing the feature promises.
 */

type Fixture = {
  name: string;
  kind: "video" | "image";
  analysis: Record<string, unknown>;
  /** Tags that must be present for this asset to be findable. */
  expected: string[];
  /** Terms that must never become tags, with the reason they are noise. */
  rejected: string[];
};

function identities(fixture: Fixture): string[] {
  const extraction = fixture.kind === "image"
    ? tagsFromImageAnalysis(fixture.analysis)
    : tagsFromVideoAnalysis(fixture.analysis);
  return extraction.tags.map((tag) => `${tag.facet}/${tag.label}`);
}

const FIXTURES: readonly Fixture[] = [
  {
    // Interview coverage, angle one. The pair below must group together.
    name: "studio interview wide",
    kind: "video",
    analysis: {
      summary: "A host and a guest talk across a table under studio lights.",
      setting: "A television studio, interior",
      subjects: ["two people", "interviewer"],
      tags: ["wide shot", "interview", "professional", "high quality"],
      actions: ["talking"],
      scenes: [{ timestamp: 0, description: "Both seats in frame", tags: ["wide shot"] }],
    },
    expected: [
      "places/studio",
      "places/interior",
      "people/two people",
      "editing/wide shot",
      "editing/interview",
    ],
    rejected: ["professional", "high quality"],
  },
  {
    // Same interview, tighter. Shot scale differs; the group does not.
    name: "studio interview close",
    kind: "video",
    analysis: {
      summary: "The guest answers a question, framed tightly.",
      setting: "A television studio, interior",
      subjects: ["interviewee"],
      tags: ["closeup", "interview", "emotional", "dramatic"],
      actions: ["talking"],
      scenes: [{ timestamp: 2, description: "Guest in a tight frame", tags: ["close up"] }],
    },
    expected: [
      "places/studio",
      "places/interior",
      "people/interviewee",
      "editing/close-up",
      "editing/interview",
    ],
    rejected: ["emotional", "dramatic"],
  },
  {
    // A different person in a similar room: shares the setting, not the people.
    name: "studio solo presenter",
    kind: "video",
    analysis: {
      summary: "One presenter addresses the camera.",
      setting: "A studio, interior",
      subjects: ["one person"],
      tags: ["medium shot", "presenter"],
      actions: [],
      scenes: [],
    },
    expected: [
      "places/studio",
      "places/interior",
      "people/solo subject",
      "editing/medium shot",
    ],
    rejected: [],
  },
  {
    // Establishing coverage somewhere else entirely.
    name: "beach establishing",
    kind: "video",
    analysis: {
      summary: "Waves roll in under a bright sky.",
      setting: "A beach, exterior, daytime",
      subjects: [],
      tags: ["establishing shot", "wide shot", "beautiful", "cinematic", "4k"],
      actions: [],
      scenes: [{ timestamp: 0, description: "Open water", tags: ["wide"] }],
    },
    expected: [
      "places/beach",
      "places/exterior",
      "places/day",
      "editing/establishing shot",
      "editing/wide shot",
    ],
    rejected: ["beautiful", "cinematic", "4k"],
  },
  {
    // Incidental objects: a counter full of things nobody will ever search by.
    name: "kitchen insert with clutter",
    kind: "video",
    analysis: {
      summary: "Hands chop vegetables beside a fruit bowl, a kettle and a radio.",
      setting: "A domestic kitchen, interior",
      subjects: ["one person"],
      tags: ["fruit bowl", "kettle", "radio", "chopping", "insert shot", "cooking"],
      actions: ["chopping vegetables"],
      scenes: [{ timestamp: 1, description: "Detail of the board", tags: ["insert"] }],
    },
    expected: [
      "places/kitchen",
      "places/interior",
      "people/solo subject",
      "editing/insert",
    ],
    rejected: ["fruit bowl", "kettle", "radio", "cooking", "chopping"],
  },
  {
    // Sparse frames cannot establish movement, and a name in a transcript
    // identifies nobody on screen.
    name: "weak evidence",
    kind: "video",
    analysis: {
      summary: "Someone called Dana is mentioned while a street is shown.",
      setting: "A street, exterior",
      subjects: ["Dana"],
      tags: ["Dana", "Lisbon", "tracking", "dolly"],
      actions: [],
      scenes: [],
    },
    expected: ["places/street", "places/exterior"],
    // A person named in speech, a city guessed from scenery, and camera
    // movement no frame sample can support.
    rejected: ["Dana", "Lisbon"],
  },
  {
    name: "product still",
    kind: "image",
    analysis: {
      prompt: "a bottle on a seamless backdrop",
      tags: [
        { facet: "editing", label: "product shot" },
        { facet: "places", label: "studio" },
        { facet: "people", label: "no people" },
        { facet: "editing", label: "gorgeous" },
      ],
    },
    expected: ["editing/product shot", "places/studio", "people/no people"],
    rejected: ["gorgeous"],
  },
];

describe("editorial tag fixtures", () => {
  it.each(FIXTURES)("$name keeps what groups footage", (fixture) => {
    const tags = identities(fixture);
    for (const wanted of fixture.expected) expect(tags).toContain(wanted);
    const joined = tags.join(" ").toLowerCase();
    for (const noise of fixture.rejected) {
      expect(joined).not.toContain(noise.toLowerCase());
    }
    // Sparse evidence emits few tags; the ceiling is never a target.
    expect(tags.length).toBeLessThanOrEqual(MAX_AUTOMATIC_TAGS);
  });

  function tagsFor(name: string): string[] {
    const fixture = FIXTURES.find((entry) => entry.name === name);
    if (!fixture) throw new Error(`Unknown fixture ${name}`);
    return identities(fixture);
  }

  function shared(left: string[], right: string[]): string[] {
    const target = new Set(right);
    return left.filter((tag) => target.has(tag));
  }

  it("groups two angles of one interview and keeps the beach out of it", () => {
    const wide = tagsFor("studio interview wide");
    const close = tagsFor("studio interview close");
    const beach = tagsFor("beach establishing");

    // Filtering on either shared term retrieves both angles.
    expect(shared(wide, close)).toEqual(
      expect.arrayContaining(["places/studio", "editing/interview"]),
    );
    // Shot scale is what distinguishes them, which is what makes the pair
    // useful for cutting rather than merely similar.
    expect(wide).toContain("editing/wide shot");
    expect(close).toContain("editing/close-up");
    expect(close).not.toContain("editing/wide shot");

    expect(beach).not.toContain("editing/interview");
    expect(shared(wide, beach)).not.toContain("places/studio");
  });

  it("separates different people who share a setting", () => {
    const interview = tagsFor("studio interview wide");
    const solo = tagsFor("studio solo presenter");
    expect(shared(interview, solo)).toContain("places/studio");
    // Same room, different coverage: a people filter still tells them apart.
    expect(interview).toContain("people/two people");
    expect(solo).toContain("people/solo subject");
    expect(solo).not.toContain("people/two people");
  });

  it("never groups by an object that happened to be in shot", () => {
    const kitchen = tagsFor("kitchen insert with clutter");
    for (const object of ["fruit bowl", "kettle", "radio"]) {
      expect(kitchen.join(" ")).not.toContain(object);
    }
    // What survives is what an editor would actually reach for.
    expect(kitchen).toContain("editing/insert");
    expect(kitchen).toContain("places/kitchen");
  });

  it("converges near-synonyms instead of fragmenting a group", () => {
    // "closeup" in the top-level tags and "close up" in a scene are one tag.
    const close = tagsFor("studio interview close");
    expect(close.filter((tag) => tag.startsWith("editing/close"))).toEqual([
      "editing/close-up",
    ]);
  });
});
