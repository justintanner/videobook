import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { NotebookDocument } from "videobook-engine";
import {
  shortAuthoredCopy, shortPlannerBrief, shortPlannerInstructions, shortPlannerIssues, shortPlannerNeeded, shortPlannerResponseSchema, shortTitle,
} from "./goal-short-planner.js";
import { SHORT_AVOID, SHORT_BANNED_WORDS, SHORT_RULES } from "./goal-short-rules.js";
import { loadGuide } from "./tools/rewrite-prompt.js";

const words = (count: number) => Array.from({ length: count }, (_, index) => `word${index}`).join(" ");

describe("shortAuthoredCopy", () => {
  it("reads a quoted frame and beats by their labels", () => {
    expect(shortAuthoredCopy('he waits for a bus, frame: "He stands under a bus shelter." beat 2: "He boards the bus."', 2))
      .toEqual({ frame: "He stands under a bus shelter.", beats: [null, "He boards the bus."] });
    expect(shortAuthoredCopy("Frame: “Dusk at the shelter.” Beat1: “He checks the road.”", 1))
      .toEqual({ frame: "Dusk at the shelter.", beats: ["He checks the road."] });
  });

  it("takes beat 1 from beat 1, then video, then the only unlabelled quote", () => {
    expect(shortAuthoredCopy('video: "He waves." beat 1: "He checks the road."', 2).beats).toEqual(["He checks the road.", null]);
    expect(shortAuthoredCopy('video: "He waves." frame: "Dusk."', 2).beats).toEqual(["He waves.", null]);
    expect(shortAuthoredCopy('he waits, "He checks the road." frame: "Dusk."', 2)).toEqual({ frame: "Dusk.", beats: ["He checks the road.", null] });
    expect(shortAuthoredCopy('he says "hi" then "bye"', 1)).toEqual({ frame: null, beats: [null] });
    expect(shortAuthoredCopy('frame: "  " he waits', 1)).toEqual({ frame: null, beats: [null] });
  });

  it("refuses a quoted beat the short has no segment for", () => {
    expect(() => shortAuthoredCopy('beat 3: "He leaves."', 2)).toThrow("The brief quotes beat 3, but this short has 2 segments.");
    expect(() => shortAuthoredCopy('beat 2: "He leaves."', 1)).toThrow("The brief quotes beat 2, but this short has 1 segment.");
  });
});

describe("shortPlannerNeeded", () => {
  let key: string | undefined;
  beforeEach(() => { key = process.env.OPENAI_API_KEY; });
  afterEach(() => {
    if (key === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = key;
  });

  it("needs the planner for any part left to fill, and refuses that without OPENAI_API_KEY", () => {
    delete process.env.OPENAI_API_KEY;
    expect(shortPlannerNeeded('frame: "Dusk." beat 1: "He waits."', 1)).toBe(false);
    expect(() => shortPlannerNeeded('frame: "Dusk."', 1)).toThrow("Set OPENAI_API_KEY in Settings, or quote the frame and beat prompts.");
    process.env.OPENAI_API_KEY = "offline-openai-key";
    expect(shortPlannerNeeded('frame: "Dusk."', 1)).toBe(true);
    expect(shortPlannerNeeded("he waits for a bus", 2)).toBe(true);
  });
});

describe("shortTitle", () => {
  it("titles a short from the brief's own words, then the frame", () => {
    expect(shortTitle('@a1 he waits for a bus in the rain at dusk, frame: "Dusk."', "Dusk.")).toBe("he waits for a bus in");
    expect(shortTitle('frame: "A man at a rainy bus stop at dusk." beat 1: "He waits."', "A man at a rainy bus stop at dusk.")).toBe("A man at a rainy bus");
    expect(shortTitle('frame: "" beat 1: "x"', "")).toBe("Short");
  });
});

describe("shortPlannerBrief", () => {
  it("names mentioned cells as the references they are, by their current address", () => {
    const document = {
      id: "019a1f3e-5b10-7c2a-9d41-3f6b2a8c1e30", name: "Shorts", createdAt: "2026-11-12T00:00:00.000Z", edges: [],
      cells: [
        { id: "019a1f3e-5b10-7c2a-9d41-3f6b2a8c1e11", type: "image", slot: { row: 0, column: 0 }, outputArtifactId: "019a1f3e-5b10-7c2a-9d41-3f6b2a8c1e01" },
        { id: "019a1f3e-5b10-7c2a-9d41-3f6b2a8c1e12", type: "image", slot: { row: 1, column: 2 }, outputArtifactId: "019a1f3e-5b10-7c2a-9d41-3f6b2a8c1e02" },
      ],
    } satisfies NotebookDocument;
    const references = [{ artifactId: "019a1f3e-5b10-7c2a-9d41-3f6b2a8c1e01" }, { artifactId: "019a1f3e-5b10-7c2a-9d41-3f6b2a8c1e02" }];
    expect(shortPlannerBrief("he waits under @b3 holding @a1's umbrella, not @c4", references, document))
      .toBe("he waits under Reference 2 holding Reference 1's umbrella, not @c4");
  });
});

describe("shortPlannerResponseSchema", () => {
  it("asks for a title, a frame and exactly one beat per segment", () => {
    expect(z.toJSONSchema(shortPlannerResponseSchema(3))).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["title", "frame", "beats"],
      properties: { beats: { type: "array", minItems: 3, maxItems: 3 } },
    });
  });
});

describe("shortPlannerIssues", () => {
  const clean = { title: "Waiting for the bus", frame: "He stands under a bus shelter at dusk.", beats: ["He checks the road.", "He boards the bus."] };

  it("finds nothing in a plan within the ceilings", () => {
    expect(shortPlannerIssues(clean, 2)).toEqual([]);
    expect(shortPlannerIssues({ title: words(6), frame: words(40), beats: [words(45), words(45)] }, 2)).toEqual([]);
  });

  it("names every ceiling, count, empty part and banned word it finds", () => {
    expect(shortPlannerIssues({ title: words(7), frame: words(41), beats: [words(46)] }, 2)).toEqual([
      { kind: "count", message: "Write exactly 2 beats, one per segment, not 1." },
      { kind: "ceiling", message: "Shorten the title to at most 6 words; it has 7." },
      { kind: "ceiling", message: "Shorten the frame to at most 40 words; it has 41." },
      { kind: "ceiling", message: "Shorten the beat 1 to at most 45 words; it has 46." },
    ]);
    expect(shortPlannerIssues({ ...clean, frame: "A cinematic, epic bus stop in 8K.", beats: ["", "He boards the bus."] }, 2)).toEqual([
      { kind: "banned", message: 'Remove "cinematic", "epic", "8k" from the frame.' },
      { kind: "empty", message: "Write the beat 1." },
    ]);
  });

  it("leaves authored parts unchecked", () => {
    const authored = { frame: "A cinematic bus stop.", beats: [words(60), null] };
    expect(shortPlannerIssues({ ...clean, frame: authored.frame, beats: [authored.beats[0]!, "He boards the bus."] }, 2, authored)).toEqual([]);
    expect(shortPlannerIssues({ ...clean, beats: [authored.beats[0]!, words(50)] }, 2, authored)).toEqual([
      { kind: "ceiling", message: "Shorten the beat 2 to at most 45 words; it has 50." },
    ]);
  });
});

describe("shortPlannerInstructions", () => {
  it("tells the planner the character, segments, ceilings, continuity, rule lines, avoid list and both guides", async () => {
    const instructions = await shortPlannerInstructions({
      character: { name: "Main character", description: "a man in a green shirt" }, aspectRatio: "9:16", segmentSeconds: [11, 10, 10],
    });
    for (const line of Object.values(SHORT_RULES)) expect(instructions).toContain(line);
    for (const avoid of SHORT_AVOID) expect(instructions).toContain(avoid);
    for (const word of SHORT_BANNED_WORDS) expect(instructions).toContain(word);
    expect(instructions).toContain("starring Main character: a man in a green shirt. The main character never speaks.");
    expect(instructions).toContain("3 beats for MiniMax H3 Max, one per segment: beat 1 lasts 11 seconds, beat 2 lasts 10 seconds, beat 3 lasts 10 seconds. The aspect ratio is 9:16.");
    expect(instructions).toContain("Word ceilings, not targets: title 6, frame 40, each beat 45.");
    expect(instructions).toContain("Each later beat continues from where the previous one ends, in the same place, and every beat ends with the main character in frame.");
    expect(instructions).toContain((await loadGuide("minimax_h3")).trim());
    expect(instructions).toContain((await loadGuide("gpt_image_26")).trim());
  });
});

describe("short prompting guides", () => {
  it.each(["minimax_h3", "gpt_image_26"])("%s holds at most 250 words of guidance under its front matter", async (guide) => {
    const text = await loadGuide(guide);
    const body = text.replace(/^---\n[\s\S]*?\n---\n/u, "");
    expect(body.length).toBeLessThan(text.length);
    expect(body.split(/\s+/u).filter(Boolean).length).toBeLessThanOrEqual(250);
  });
});
