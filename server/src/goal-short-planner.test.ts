import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { NotebookDocument } from "videobook-engine";
import { buildGoalShortPlan } from "./goal-short-plan.js";
import {
  shortAuthoredCopy, shortBriefPlan, shortPlannerBrief, shortPlannerInstructions, shortPlannerIssues, shortPlannerNeeded, shortPlannerResponseSchema, shortRevisionInstructions,
  shortRevisionIssues, shortRevisionPart, shortRevisionResponseSchema, shortTitle,
} from "./goal-short-planner.js";
import { SHORT_AVOID, SHORT_BANNED_WORDS, SHORT_RULES } from "./goal-short-rules.js";
import { loadGuide } from "./tools/rewrite-prompt.js";

const words = (count: number) => Array.from({ length: count }, (_, index) => `word${index}`).join(" ");

const kept = (segmentSeconds: number[]) => ({ segmentSeconds, note: null });

describe("shortAuthoredCopy", () => {
  it("reads a quoted frame and beats by their labels", () => {
    expect(shortAuthoredCopy('he waits for a bus, frame: "He stands under a bus shelter." beat 2: "He boards the bus."', [10, 10]))
      .toEqual({ frame: "He stands under a bus shelter.", beats: [null, "He boards the bus."], ...kept([10, 10]) });
    expect(shortAuthoredCopy("Frame: “Dusk at the shelter.” Beat1: “He checks the road.”", [12]))
      .toEqual({ frame: "Dusk at the shelter.", beats: ["He checks the road."], ...kept([12]) });
  });

  it("takes beat 1 from beat 1, then video, then the only unlabelled quote", () => {
    expect(shortAuthoredCopy('video: "He waves." beat 1: "He checks the road."', [10, 10]).beats).toEqual(["He checks the road.", null]);
    expect(shortAuthoredCopy('video: "He waves." frame: "Dusk."', [10, 10]).beats).toEqual(["He waves.", null]);
    expect(shortAuthoredCopy('he waits, "He checks the road." frame: "Dusk."', [10, 10])).toEqual({ frame: "Dusk.", beats: ["He checks the road.", null], ...kept([10, 10]) });
    expect(shortAuthoredCopy('he says "hi" then "bye"', [12])).toEqual({ frame: null, beats: [null], ...kept([12]) });
    expect(shortAuthoredCopy('frame: "  " he waits', [12])).toEqual({ frame: null, beats: [null], ...kept([12]) });
  });

  it("grows the short when a later quoted beat still fits", () => {
    expect(shortAuthoredCopy('beat 3: "He leaves."', [15])).toEqual({
      frame: null, beats: [null, null, "He leaves."], segmentSeconds: [5, 5, 5],
      note: "The brief quotes beat 3, so this short has 3 segments.",
    });
    expect(shortAuthoredCopy('beat 3: "He leaves."', [10, 10])).toEqual({
      frame: null, beats: [null, null, "He leaves."], segmentSeconds: [7, 7, 6],
      note: "The brief quotes beat 3, so this short has 3 segments.",
    });
  });

  it("folds a quoted beat that does not fit into the last beat", () => {
    expect(shortAuthoredCopy('beat 2: "He leaves."', [5])).toEqual({
      frame: null, beats: ["He leaves."], segmentSeconds: [5],
      note: "The brief quotes beat 2, so that line is part of the last beat.",
    });
    expect(shortAuthoredCopy('beat 1: "He waits." beat 5: "He waves." beat 6: "He sits."', [15])).toEqual({
      frame: null, beats: ["He waits. He waves. He sits."], segmentSeconds: [15],
      note: "The brief quotes beat 5 and beat 6, so those lines are part of the last beat.",
    });
    expect(shortAuthoredCopy('video: "He waves." beat 2: "He leaves."', [5])).toMatchObject({ beats: ["He waves. He leaves."] });
  });
});

describe("shortPlannerNeeded", () => {
  let key: string | undefined;
  beforeEach(() => { key = process.env.OPENAI_API_KEY; });
  afterEach(() => {
    if (key === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = key;
  });

  it("needs the planner only when a part is open and OPENAI_API_KEY is set", () => {
    delete process.env.OPENAI_API_KEY;
    expect(shortPlannerNeeded('frame: "Dusk." beat 1: "He waits."', [12])).toBe(false);
    expect(shortPlannerNeeded('frame: "Dusk."', [12])).toBe(false);
    process.env.OPENAI_API_KEY = "offline-openai-key";
    expect(shortPlannerNeeded('frame: "Dusk."', [12])).toBe(true);
    expect(shortPlannerNeeded("he waits for a bus", [10, 10])).toBe(true);
    process.env.OPENAI_API_KEY = "test-openai-key";
    expect(shortPlannerNeeded("he waits for a bus", [12])).toBe(false);
  });
});

describe("shortBriefPlan", () => {
  it("keeps quoted parts and fills the rest from the brief prose", () => {
    const brief = 'he waits for a bus in the rain frame: "Dusk."';
    const authored = shortAuthoredCopy(brief, [12]);
    expect(shortBriefPlan(brief, authored)).toEqual({
      frame: "Dusk.",
      beats: ["he waits for a bus in the rain"],
      note: "Planned from the brief as written. Add OPENAI_API_KEY in Settings for a written plan.",
    });
  });

  it("adds no note when the brief already quotes every part", () => {
    const brief = 'frame: "Dusk." beat 1: "He waits."';
    expect(shortBriefPlan(brief, shortAuthoredCopy(brief, [12]))).toEqual({ frame: "Dusk.", beats: ["He waits."], note: null });
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
      .toBe("he waits under Source image 2 holding Source image 1's umbrella, not @c4");
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

  it("flags a planner-written frame or beat that names a phone unless phones are allowed, and leaves the title and authored parts alone", () => {
    const phoned = { title: "Phone at the bus stop", frame: "He stands at the stop, phone at chest height.", beats: ["He checks the road. The phone stays at chest height, keeping him framed.", "He boards the bus."] };
    expect(shortPlannerIssues(phoned, 2, undefined, false)).toEqual([
      { kind: "phone", message: "Leave the phone out of the frame: call it the camera, which someone off screen holds." },
      { kind: "phone", message: "Leave the phone out of the beat 1: call it the camera, which someone off screen holds." },
    ]);
    expect(shortPlannerIssues(phoned, 2)).toEqual([]);
    expect(shortPlannerIssues(phoned, 2, { frame: phoned.frame, beats: [phoned.beats[0]!, null], segmentSeconds: [10, 10], note: null }, false)).toEqual([]);
  });

  it("leaves authored parts unchecked", () => {
    const authored = { frame: "A cinematic bus stop.", beats: [words(60), null], segmentSeconds: [10, 10], note: null };
    expect(shortPlannerIssues({ ...clean, frame: authored.frame, beats: [authored.beats[0]!, "He boards the bus."] }, 2, authored)).toEqual([]);
    expect(shortPlannerIssues({ ...clean, beats: [authored.beats[0]!, words(50)] }, 2, authored)).toEqual([
      { kind: "ceiling", message: "Shorten the beat 2 to at most 45 words; it has 50." },
    ]);
  });
});

describe("shortPlannerInstructions", () => {
  it("tells the planner the person, segments, ceilings, continuity, rule lines, avoid list and both guides", async () => {
    const instructions = await shortPlannerInstructions({ sourceImageCount: 1, aspectRatio: "9:16", segmentSeconds: [11, 10, 10] });
    for (const line of Object.values(SHORT_RULES)) expect(instructions).toContain(line);
    for (const avoid of SHORT_AVOID) expect(instructions).toContain(avoid);
    for (const word of SHORT_BANNED_WORDS) expect(instructions).toContain(word);
    expect(instructions).toContain("starring the person in the source images. That person never speaks.");
    expect(instructions).not.toMatch(/Main character|a man in a green shirt/u);
    expect(instructions).toContain("3 beats for MiniMax H3 Max, one per segment: beat 1 lasts 11 seconds, beat 2 lasts 10 seconds, beat 3 lasts 10 seconds. The aspect ratio is 9:16.");
    expect(instructions).toContain("Word ceilings, not targets: title 6, frame 40, each beat 45.");
    expect(instructions).toContain("Each later beat continues from where the previous one ends, in the same place, and every beat ends with that person in frame.");
    expect(instructions).toContain("Plan a short that looks like real phone footage filmed by someone off screen, starring");
    expect(instructions).toContain("Call it the camera, never the phone: someone off screen holds it.");
    expect(instructions).toContain('Say what is there rather than what is not, such as "both hands hang empty at the sides" rather than "no phone in hand"');
    expect(instructions).toContain("Give that person a phone only when the brief does.");
    expect(instructions).toContain("The images are source images, labelled Source image 1, Source image 2");
    expect(instructions).toContain((await loadGuide("minimax_h3")).trim());
    expect(instructions).toContain((await loadGuide("gpt_image_26")).trim());
    const fromWords = await shortPlannerInstructions({ sourceImageCount: 0, aspectRatio: "9:16", segmentSeconds: [12] });
    expect(fromWords).toContain("starring the person the brief describes. That person never speaks.");
    expect(fromWords).not.toMatch(/Main character|a man in a green shirt/u);
  });
});

describe("short revisions", () => {
  const plan = buildGoalShortPlan({
    title: "Waiting", aspectRatio: "9:16", sourceImages: [],
    framePrompt: "He stands under a bus shelter at dusk.", beats: ["He checks the road. The phone stays at chest height, keeping him framed.", "He boards the bus."],
    segmentSeconds: [10, 10],
  });

  it("names the part it rewrites with its ceiling and current prompt", () => {
    expect(shortRevisionPart(plan, "frame", 0)).toEqual({ name: "frame", ceiling: 40, prompt: "He stands under a bus shelter at dusk." });
    expect(shortRevisionPart(plan, "videos", 1)).toEqual({ name: "beat 2", ceiling: 45, prompt: "He boards the bus." });
    expect(() => shortRevisionPart(plan, "videos", 2)).toThrow("This short has 2 segments.");
    expect(z.toJSONSchema(shortRevisionResponseSchema(shortRevisionPart(plan, "videos", 0)))).toMatchObject({
      type: "object", additionalProperties: false, required: ["prompt"],
    });
  });

  it("tells the rewrite to drop what the feedback contradicts, with the plan's own rule lines and the one guide its model needs", async () => {
    const saved = { ...plan, rules: { frame: "Earlier frame rule.", video: "Earlier video rule.", silence: "Earlier silence rule." } };
    const beat = await shortRevisionInstructions(saved, "videos", 0);
    expect(beat).toContain("Rewrite beat 1 of 2 for MiniMax H3 Max, which lasts 10 seconds, so it follows the operator's feedback.");
    expect(beat).toContain("It starts from the opening frame and ends with that person in frame.");
    expect(beat).toContain("Remove or rewrite every sentence the feedback contradicts, so the prompt no longer says anything the feedback rules out.");
    expect(beat).toContain("Call it the camera, never the phone: someone off screen holds it.");
    expect(beat).toContain('"both hands hang empty at the sides" rather than "no phone in hand"');
    expect(beat).toContain("Give that person a phone only when the feedback or the brief does.");
    expect(beat).toContain("Write at most 45 words, and answer with the whole revised beat 1.");
    expect(beat).toContain("Video: Earlier video rule.\nSilence: Earlier silence rule.");
    expect(beat).not.toContain("Earlier frame rule.");
    for (const avoid of SHORT_AVOID) expect(beat).toContain(avoid);
    expect(beat).toContain((await loadGuide("minimax_h3")).trim());
    expect(beat).not.toContain((await loadGuide("gpt_image_26")).trim());
    expect(await shortRevisionInstructions(saved, "videos", 1)).toContain("It continues from where the beat before it ends, in the same place, and ends with that person in frame.");
    const frame = await shortRevisionInstructions(saved, "frame", 0);
    expect(frame).toContain("Rewrite the opening frame prompt for GPT Image 2.6 so it follows the operator's feedback.");
    expect(frame).toContain("Frame: Earlier frame rule.");
    expect(frame).not.toContain("Earlier video rule.");
    expect(frame).toContain((await loadGuide("gpt_image_26")).trim());
  });

  it("checks a rewritten prompt for its ceiling, banned words and an unwanted phone", () => {
    const part = shortRevisionPart(plan, "videos", 0);
    expect(shortRevisionIssues("He checks the road with both hands empty.", part, false)).toEqual([]);
    expect(shortRevisionIssues(`A cinematic ${words(45)}. The phone stays at chest height.`, part, false)).toEqual([
      { kind: "ceiling", message: "Shorten the beat 1 to at most 45 words; it has 53." },
      { kind: "banned", message: 'Remove "cinematic" from the beat 1.' },
      { kind: "phone", message: "Leave the phone out of the beat 1: call it the camera, which someone off screen holds." },
    ]);
    expect(shortRevisionIssues("He checks his phone.", part, true)).toEqual([]);
    expect(shortRevisionIssues(" ", part, true)).toEqual([{ kind: "empty", message: "Write the whole revised beat 1." }]);
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
