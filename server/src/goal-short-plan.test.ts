import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FAL_ENDPOINT_REQUEST_SCHEMAS } from "@apicity/fal/zod";
import type { NotebookDocument } from "videobook-engine";
import type { ChainStep } from "./chain-plan.js";
import {
  GOAL_SHORT_DEFAULTS,
  SHORT_ASPECT_RATIOS,
  SHORT_EXTEND_MODELS,
  SHORT_EXTEND_OUTPUTS,
  SHORT_FRAME_FORMATS,
  SHORT_FRAME_MODELS,
  SHORT_FRAME_QUALITIES,
  SHORT_IMAGE_SIZES,
  SHORT_PROMPT_EXPANSIONS,
  SHORT_RESOLUTIONS,
  SHORT_VIDEO_MODELS,
  SHORT_WORD_CEILINGS,
  buildGoalShortPlan,
  compileShortClipStep,
  compileShortContinuationStep,
  compileShortFrameStep,
  goalShortPlanSchema,
  refreshGoalShortPlan,
  shortSheetStep,
  shortTiming,
  type GoalShortPlan,
} from "./goal-short-plan.js";
import { SHORT_RULES } from "./goal-short-rules.js";
import { LIGHTNING_COLD_OPEN_SECONDS, LIGHTNING_WATERMARK_PROFILE } from "./lightning-defaults.js";
import { resolveModel } from "./media/descriptor.js";
import { applyPromptDialect } from "./media/prompt-dialects.js";
import { buildWireRequest } from "./media/request.js";
import type { MediaRefs, RefRole } from "./media/types.js";

function imageRef(index: number, label: string) {
  return {
    kind: "image" as const,
    artifactId: `019a1f3e-5b10-7c2a-9d41-3f6b2a8c1e0${index}`,
    cellId: `019a1f3e-5b10-7c2a-9d41-3f6b2a8c1e1${index}`,
    address: `@a${index}`,
    label,
    objectHash: String(index).repeat(64),
  };
}

const sheet = imageRef(1, "Character sheet");
const sideView = imageRef(2, "Side view");
const shelter = imageRef(3, "Bus shelter");
const umbrella = imageRef(4, "Umbrella");
const CHARACTER = { name: "Main character", description: "a man in a green shirt" };
const FRAME_PROMPT = "He stands under a bus shelter at dusk, rain on the road.";
const BEATS = ["He checks the road for the bus.", "He steps back from a splash.", "He boards the bus."];

function shortPlan(overrides: Partial<Parameters<typeof buildGoalShortPlan>[0]> = {}): GoalShortPlan {
  return buildGoalShortPlan({
    title: "Waiting for the bus",
    aspectRatio: "9:16",
    character: { ...CHARACTER, references: [sheet, sideView] },
    framePrompt: FRAME_PROMPT,
    beats: BEATS,
    segmentSeconds: [11, 10, 10],
    extraReferences: [shelter, umbrella],
    ...overrides,
  });
}

function issues(value: unknown): string[] {
  const parsed = goalShortPlanSchema.safeParse(value);
  return parsed.success ? [] : parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
}

function valueAt(value: unknown, path: string): unknown {
  return path.split(".").reduce((current, key) => (current as Record<string, unknown> | undefined)?.[key], value);
}

function withSetting(plan: GoalShortPlan, field: string, value: string): GoalShortPlan {
  const copy = structuredClone(plan) as unknown as Record<string, unknown>;
  const keys = field.split(".");
  const holder = keys.slice(0, -1).reduce((current, key) => current[key] as Record<string, unknown>, copy);
  holder[keys.at(-1)!] = value;
  return copy as unknown as GoalShortPlan;
}

function saved(plan: GoalShortPlan): unknown {
  return JSON.parse(JSON.stringify(plan));
}

type StepParams = {
  model: string;
  prompt: string;
  refs?: Partial<Record<RefRole, string[]>>;
  options?: Record<string, unknown>;
};

function mediaUrl(role: RefRole, ref: string): string {
  return `https://example.com/${ref.replace(/^@/u, "")}.${role === "video" ? "mp4" : "jpg"}`;
}

function wire(step: ChainStep): { apiId: string; request: Record<string, unknown> } {
  const params = step.params as StepParams;
  const model = resolveModel(params.model);
  const roles = Object.entries(params.refs ?? {}) as [RefRole, string[]][];
  let next = 0;
  const ids: MediaRefs = Object.fromEntries(roles.map(([role, list]) => [role, list.map(() => `01890f1c-0000-7000-8000-${String(++next).padStart(12, "0")}`)]));
  const urls: MediaRefs = Object.fromEntries(roles.map(([role, list]) => [role, list.map((ref) => mediaUrl(role, ref))]));
  const built = buildWireRequest(model, { prompt: applyPromptDialect(model.entry.dialect, params.prompt, ids), refUrls: urls, options: params.options });
  if (!built.ok) throw new Error(`${step.id}: ${built.error}`);
  return { apiId: model.id.replace(/^fal:/u, ""), request: built.request };
}

function expectAccepted(step: ChainStep): Record<string, unknown> {
  const { apiId, request } = wire(step);
  const schema = FAL_ENDPOINT_REQUEST_SCHEMAS[apiId as keyof typeof FAL_ENDPOINT_REQUEST_SCHEMAS];
  expect(schema, apiId).toBeDefined();
  const parsed = schema.safeParse(request);
  expect(parsed.success, `${apiId} refused ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
  expect(request.prompt, "every @image slot in the prompt names a reference the step sends").not.toMatch(/@image\d/u);
  return request;
}

function compiledSteps(plan: GoalShortPlan): Record<"frame" | "clip" | "continuation", ChainStep> {
  return {
    frame: compileShortFrameStep(plan),
    clip: compileShortClipStep(plan, "@c1"),
    continuation: compileShortContinuationStep(plan, 1, "@d1"),
  };
}

describe("shortTiming", () => {
  it("makes 12 vertical seconds in one segment from a brief that names no length", () => {
    expect(shortTiming("he waits for a bus in the rain")).toEqual({ aspectRatio: "9:16", totalSeconds: 12, segmentSeconds: [12], note: null });
  });

  it("splits the seconds a brief names into segments of at most 15, as even as whole seconds allow, longest first", () => {
    expect(shortTiming("he waits for a bus, 20 seconds")).toEqual({ aspectRatio: "9:16", totalSeconds: 20, segmentSeconds: [10, 10], note: null });
    expect(shortTiming("a 31-second short of him waiting").segmentSeconds).toEqual([11, 10, 10]);
    expect(shortTiming("5s of rain").segmentSeconds).toEqual([5]);
    expect(shortTiming("15 secs").segmentSeconds).toEqual([15]);
    expect(shortTiming("16 sec").segmentSeconds).toEqual([8, 8]);
    expect(shortTiming("46 seconds").segmentSeconds).toEqual([12, 12, 11, 11]);
    expect(shortTiming("(60 seconds)").segmentSeconds).toEqual([15, 15, 15, 15]);
  });

  it("rounds a fractional length to whole seconds", () => {
    expect(shortTiming("7.5 seconds of rain")).toMatchObject({ totalSeconds: 8, segmentSeconds: [8] });
  });

  it("reads the aspect ratio from the brief's words", () => {
    for (const brief of ["a landscape short", "horizontal", "16:9 please"]) expect(shortTiming(brief).aspectRatio, brief).toBe("16:9");
    for (const brief of ["a square short", "1:1"]) expect(shortTiming(brief).aspectRatio, brief).toBe("1:1");
    for (const brief of ["a vertical short", "portrait", "9:16"]) expect(shortTiming(brief).aspectRatio, brief).toBe("9:16");
  });

  it("clamps a length outside 5 to 60 seconds and notes the length it used", () => {
    expect(shortTiming("4 seconds of rain")).toEqual({ aspectRatio: "9:16", totalSeconds: 5, segmentSeconds: [5], note: "A short runs 5 to 60 seconds, so this one is 5." });
    expect(shortTiming("2 seconds of rain")).toMatchObject({ totalSeconds: 5, segmentSeconds: [5], note: "A short runs 5 to 60 seconds, so this one is 5." });
    expect(shortTiming("a 61 second short")).toMatchObject({ totalSeconds: 60, segmentSeconds: [15, 15, 15, 15], note: "A short runs 5 to 60 seconds, so this one is 60." });
    expect(shortTiming("a 90 second short")).toMatchObject({ totalSeconds: 60, segmentSeconds: [15, 15, 15, 15], note: "A short runs 5 to 60 seconds, so this one is 60." });
  });
});

describe("buildGoalShortPlan", () => {
  it("builds a version-4 plan the schema accepts, with the rules and defaults copied in", () => {
    const plan = shortPlan();
    expect(goalShortPlanSchema.parse(saved(plan))).toEqual(plan);
    expect(plan).toMatchObject({
      version: 4,
      title: "Waiting for the bus",
      aspectRatio: "9:16",
      character: { ...CHARACTER, silent: true },
      frame: { prompt: FRAME_PROMPT, model: GOAL_SHORT_DEFAULTS.frame.model, imageSize: "portrait_16_9", quality: "high", outputFormat: "jpeg" },
      segments: [{ prompt: BEATS[0], seconds: 11 }, { prompt: BEATS[1], seconds: 10 }, { prompt: BEATS[2], seconds: 10 }],
      video: GOAL_SHORT_DEFAULTS.video,
      rules: SHORT_RULES,
    });
  });

  it("gives the character references the first image slots and the extra references the next", () => {
    const plan = shortPlan();
    expect(plan.character.references).toEqual([{ ...sheet, slot: "@image1" }, { ...sideView, slot: "@image2" }]);
    expect(plan.frame.references).toEqual([{ ...shelter, slot: "@image3" }, { ...umbrella, slot: "@image4" }]);
  });

  it("keeps only the reference fields, whatever slot a reference arrives with", () => {
    const moved = { ...shelter, slot: "@image9", note: "from an older plan" };
    expect(shortPlan({ extraReferences: [moved] }).frame.references).toEqual([{ ...shelter, slot: "@image3" }]);
  });

  it("frames each aspect ratio at its own GPT Image size", () => {
    expect(shortPlan({ aspectRatio: "9:16" }).frame.imageSize).toBe("portrait_16_9");
    expect(shortPlan({ aspectRatio: "16:9" }).frame.imageSize).toBe("landscape_16_9");
    expect(shortPlan({ aspectRatio: "1:1" }).frame.imageSize).toBe("square_hd");
  });

  it("stores the finish block version 3 stores: the Lightning cold open and the TikTok watermark", () => {
    const profile = LIGHTNING_WATERMARK_PROFILE;
    expect(shortPlan().finish).toEqual({
      suggestedColdOpenSeconds: LIGHTNING_COLD_OPEN_SECONDS,
      watermark: {
        platform: "tiktok",
        handle: profile.handle,
        profileUrl: profile.profileUrl,
        mode: "burn",
        handleEndSeconds: profile.handleEndSeconds,
        qrLeadSeconds: profile.qrLeadSeconds,
        handleOpacity: profile.handleOpacity,
        qrOpacity: profile.qrOpacity,
        fadeSeconds: profile.fadeSeconds,
      },
    });
  });

  it("refuses beats that do not match the segments one for one", () => {
    expect(() => shortPlan({ beats: BEATS.slice(0, 2) })).toThrow("A short needs one beat per segment: 3 segments, 2 beats.");
  });

  it("uses the defaults of the plan", () => {
    expect(GOAL_SHORT_DEFAULTS).toEqual({
      aspectRatio: "9:16",
      totalSeconds: 12,
      frame: {
        model: "fal:openai/gpt-image-2.6/sunburst/edit",
        imageSize: { "9:16": "portrait_16_9", "16:9": "landscape_16_9", "1:1": "square_hd" },
        quality: "high",
        outputFormat: "jpeg",
      },
      video: {
        model: "fal:minimax/h3-max/reference-to-video",
        extendModel: "fal:minimax/h3-max/extend-video",
        resolution: "1080P",
        promptExpansion: "disabled",
        extendOutput: "extended",
      },
    });
    expect(SHORT_WORD_CEILINGS).toEqual({ title: 6, frame: 40, beat: 45 });
  });
});

describe("goalShortPlanSchema", () => {
  it("rejects a model outside the short's lists", () => {
    expect(issues(withSetting(shortPlan(), "frame.model", "fal:openai/gpt-image-2/edit"))).toEqual([expect.stringMatching(/^frame\.model: /u)]);
    expect(issues(withSetting(shortPlan(), "video.model", "kie:bytedance/seedance-2-5"))).toEqual([expect.stringMatching(/^video\.model: /u)]);
    expect(issues(withSetting(shortPlan(), "video.extendModel", "fal:minimax/h3-max-turbo/extend-video"))).toEqual([expect.stringMatching(/^video\.extendModel: /u)]);
  });

  it("rejects a fifth segment", () => {
    const segments = Array.from({ length: 5 }, (_, index) => ({ prompt: `Beat ${index + 1}.`, seconds: 10 }));
    expect(issues({ ...shortPlan(), segments })).toEqual([expect.stringMatching(/^segments: .*<=4/u)]);
  });

  it("rejects a first segment under 5 seconds and allows shorter later ones", () => {
    expect(issues({ ...shortPlan(), segments: [{ prompt: BEATS[0], seconds: 4 }, { prompt: BEATS[1], seconds: 10 }] }))
      .toEqual(["segments.0.seconds: The first segment runs at least 5 seconds"]);
    expect(issues({ ...shortPlan(), segments: [{ prompt: BEATS[0], seconds: 5 }, { prompt: BEATS[1], seconds: 2 }] })).toEqual([]);
  });

  it("rejects a total above 60 seconds", () => {
    const segments = [15, 15, 15, 16].map((seconds, index) => ({ prompt: `Beat ${index + 1}.`, seconds }));
    expect(issues({ ...shortPlan(), segments })).toContain("segments: A short runs at most 60 seconds in total, not 61");
    expect(issues({ ...shortPlan(), segments: segments.map((segment) => ({ ...segment, seconds: 15 })) })).toEqual([]);
  });

  it("rejects segment seconds that are not whole or fall outside 2 to 15", () => {
    for (const seconds of [1, 16, 10.5]) {
      expect(issues({ ...shortPlan(), segments: [{ prompt: BEATS[0], seconds: 12 }, { prompt: BEATS[1], seconds }] }), String(seconds))
        .toEqual([expect.stringMatching(/^segments\.1\.seconds: /u)]);
    }
  });

  it("rejects a fifth character reference and a thirteenth frame reference", () => {
    const characters = [1, 2, 3, 4, 5].map((index) => imageRef(index, `Character ${index}`));
    expect(issues(shortPlan({ character: { ...CHARACTER, references: characters.slice(0, 4) }, extraReferences: [] }))).toEqual([]);
    expect(() => shortPlan({ character: { ...CHARACTER, references: characters }, extraReferences: [] })).toThrow(/character/u);
    expect(issues({ ...shortPlan(), character: { ...shortPlan().character, references: characters.map((reference, index) => ({ ...reference, slot: `@image${index + 1}` })) }, frame: { ...shortPlan().frame, references: [] } }))
      .toEqual([expect.stringMatching(/^character\.references: .*<=4/u)]);
    const extras = Array.from({ length: 13 }, (_, index) => imageRef(index + 1, `Place ${index + 1}`));
    expect(() => shortPlan({ character: { ...CHARACTER, references: [] }, extraReferences: extras.slice(0, 12) })).not.toThrow();
    expect(() => shortPlan({ character: { ...CHARACTER, references: [] }, extraReferences: extras })).toThrow(/frame/u);
  });

  it("rejects image slots that do not follow the character references and then the frame references", () => {
    const plan = shortPlan();
    const swapped = { ...plan, frame: { ...plan.frame, references: [{ ...plan.frame.references[0]!, slot: "@image1" }, plan.frame.references[1]!] } };
    expect(issues(swapped)).toEqual(["frame.references.0.slot: Expected @image3: character references take the first image slots and frame references the next"]);
  });

  it("rejects a character who speaks, an unknown field and an empty prompt", () => {
    const plan = shortPlan();
    expect(issues({ ...plan, character: { ...plan.character, silent: false } })).toEqual([expect.stringMatching(/^character\.silent: /u)]);
    expect(issues({ ...plan, style: "cinematic" })).toEqual([expect.stringMatching(/style/u)]);
    expect(issues({ ...plan, frame: { ...plan.frame, prompt: "  " } })).toEqual([expect.stringMatching(/^frame\.prompt: /u)]);
  });
});

describe("compiled short steps", () => {
  it("makes the frame with GPT Image 2.6 edit from the character references, then the extra references, ending on the frame rule", () => {
    const step = compileShortFrameStep(shortPlan());
    expect(step).toEqual({
      id: "frame",
      tool: "generate_image",
      params: {
        model: "fal:openai/gpt-image-2.6/sunburst/edit",
        prompt: [
          FRAME_PROMPT,
          "@image1 and @image2 are Main character (a man in a green shirt): keep the face, hair, build and clothes exactly.",
          "The other images are references for the place and props.",
          SHORT_RULES.frame,
        ].join("\n\n"),
        refs: { image: ["@a1", "@a2", "@a3", "@a4"] },
        options: { image_size: "portrait_16_9", quality: "high", output_format: "jpeg" },
      },
    });
    expect((step.params as StepParams).prompt.endsWith(SHORT_RULES.frame)).toBe(true);
  });

  it("names one character reference as @image1 and three by all their slots, and leaves out the place line without extras", () => {
    const one = compileShortFrameStep(shortPlan({ character: { ...CHARACTER, references: [sheet] }, extraReferences: [] }));
    expect(one.params).toMatchObject({
      prompt: [FRAME_PROMPT, "@image1 is Main character (a man in a green shirt): keep the face, hair, build and clothes exactly.", SHORT_RULES.frame].join("\n\n"),
      refs: { image: ["@a1"] },
    });
    const three = compileShortFrameStep(shortPlan({ character: { name: "Mr Green.", description: "a man in a green shirt.", references: [sheet, sideView, shelter] }, extraReferences: [] }));
    expect((three.params as StepParams).prompt).toContain("\n\n@image1, @image2 and @image3 are Mr Green (a man in a green shirt): keep the face");
  });

  it("starts the base clip with H3 Max on the approved frame, keeping the character references", () => {
    expect(compileShortClipStep(shortPlan(), "@c1")).toEqual({
      id: "clip1",
      tool: "generate_video",
      params: {
        model: "fal:minimax/h3-max/reference-to-video",
        prompt: [BEATS[0], "@image1 and @image2 are Main character: keep the same person in the same clothes.", SHORT_RULES.video, SHORT_RULES.silence].join("\n\n"),
        refs: { first_frame: ["@c1"], image: ["@a1", "@a2"] },
        options: { duration: 11, resolution: "1080P", aspect_ratio: "9:16", prompt_expansion_mode: "disabled" },
        transcribe: false,
      },
    });
    const single = compileShortClipStep(shortPlan({ character: { ...CHARACTER, references: [sheet] } }), "@c2");
    expect(single.params).toMatchObject({
      prompt: [BEATS[0], "@image1 is Main character: keep the same person in the same clothes.", SHORT_RULES.video, SHORT_RULES.silence].join("\n\n"),
      refs: { first_frame: ["@c2"], image: ["@a1"] },
    });
  });

  it("continues the current clip with H3 Max Extend, one step per later beat", () => {
    const plan = shortPlan();
    expect(compileShortContinuationStep(plan, 1, "@d1")).toEqual({
      id: "clip2",
      tool: "generate_video",
      params: {
        model: "fal:minimax/h3-max/extend-video",
        prompt: [BEATS[1], "Continue the same shot: the same person, clothes, place and light.", SHORT_RULES.video, SHORT_RULES.silence].join("\n\n"),
        refs: { video: ["@d1"] },
        options: { duration: 10, resolution: "1080P", aspect_ratio: "auto", output: "extended", enable_prompt_expansion: false },
        transcribe: false,
      },
    });
    expect(compileShortContinuationStep(plan, 2, "@d2")).toMatchObject({ id: "clip3", params: { prompt: expect.stringMatching(/^He boards the bus\./u), refs: { video: ["@d2"] } } });
    const four = shortPlan({ beats: [...BEATS, "He waves from the window."], segmentSeconds: shortTiming("46 seconds").segmentSeconds });
    expect(compileShortContinuationStep(four, 3, "@d3")).toMatchObject({ id: "clip4", params: { options: { duration: 11 } } });
  });

  it("refuses a continuation of the base clip or of a segment the plan does not have", () => {
    const plan = shortPlan();
    expect(() => compileShortContinuationStep(plan, 0, "@d1")).toThrow(RangeError);
    expect(() => compileShortContinuationStep(plan, 3, "@d1")).toThrow("Segment 3 is not a continuation in this 3-segment short.");
  });

  it("turns Extend's prompt expansion on only when the short allows it", () => {
    const balanced = withSetting(shortPlan(), "video.promptExpansion", "balanced");
    expect(valueAt(compileShortContinuationStep(balanced, 1, "@d1").params, "options.enable_prompt_expansion")).toBe(true);
    expect(valueAt(compileShortContinuationStep(shortPlan(), 1, "@d1").params, "options.enable_prompt_expansion")).toBe(false);
  });

  it("compiles clips whose only phone is the off-screen camera of the video rule, with prompt expansion off", () => {
    const plan = shortPlan();
    for (const step of [compileShortClipStep(plan, "@c1"), compileShortContinuationStep(plan, 1, "@d1")]) {
      expect(String((step.params as StepParams).prompt).match(/[^.\n]*\bphones?\b[^.\n]*/giu), step.id).toEqual([
        "Real phone footage filmed by someone off screen, in one continuous take at real-time speed, with slight handheld camera movement and natural weight and physics",
      ]);
    }
    expect(valueAt(compileShortClipStep(plan, "@c1").params, "options.prompt_expansion_mode")).toBe("disabled");
    expect(valueAt(compileShortContinuationStep(plan, 1, "@d1").params, "options.enable_prompt_expansion")).toBe(false);
  });

  it("compiles a saved short with the rule wording it was made with", () => {
    const rules = { frame: "Earlier frame rule.", video: "Earlier video rule.", silence: "Earlier silence rule." };
    const plan = goalShortPlanSchema.parse(saved({ ...shortPlan(), rules }));
    expect((compileShortFrameStep(plan).params as StepParams).prompt).toMatch(/\n\nEarlier frame rule\.$/u);
    expect((compileShortClipStep(plan, "@c1").params as StepParams).prompt).toMatch(/\n\nEarlier video rule\.\n\nEarlier silence rule\.$/u);
    expect((compileShortContinuationStep(plan, 1, "@d1").params as StepParams).prompt).toMatch(/\n\nEarlier video rule\.\n\nEarlier silence rule\.$/u);
  });

  it("makes the character sheet on a plain background with GPT Image 2.6 text-to-image, or with the edit model from the references", () => {
    const prompt = "Character reference sheet of a man in a green shirt: the same person three times on a plain light grey background, a front view, a three-quarter view and a full-body view, neutral expression, mouth closed, even daylight.";
    const options = { image_size: "landscape_16_9", quality: "high" };
    expect(shortSheetStep({ description: "a man in a green shirt", references: [] })).toEqual({
      id: "sheet",
      tool: "generate_image",
      params: { model: "fal:openai/gpt-image-2.6/sunburst/text-to-image", prompt, options },
    });
    expect(shortSheetStep({ description: "a man in a green shirt.", references: [sheet.artifactId, "@b2"] })).toEqual({
      id: "sheet",
      tool: "generate_image",
      params: { model: "fal:openai/gpt-image-2.6/sunburst/edit", prompt, refs: { image: [sheet.artifactId, "@b2"] }, options },
    });
  });
});

describe("short provider requests", () => {
  const steps: [string, () => ChainStep][] = [
    ["frame", () => compileShortFrameStep(shortPlan())],
    ["base clip", () => compileShortClipStep(shortPlan(), "@c1")],
    ["continuation", () => compileShortContinuationStep(shortPlan(), 1, "@d1")],
    ["character sheet", () => shortSheetStep({ description: CHARACTER.description, references: [] })],
    ["character sheet from references", () => shortSheetStep({ description: CHARACTER.description, references: ["@a1", "@a2"] })],
  ];

  it.each(steps)("builds the %s request through the catalog and apicity's schema accepts it", (_name, step) => {
    expectAccepted(step());
  });

  it("sends each reference to the field its role names", () => {
    const plan = shortPlan();
    expect(expectAccepted(compileShortFrameStep(plan))).toMatchObject({
      image_urls: ["https://example.com/a1.jpg", "https://example.com/a2.jpg", "https://example.com/a3.jpg", "https://example.com/a4.jpg"],
      image_size: "portrait_16_9",
      quality: "high",
      output_format: "jpeg",
    });
    expect(expectAccepted(compileShortClipStep(plan, "@c1"))).toMatchObject({
      image_url: "https://example.com/c1.jpg",
      reference_image_urls: ["https://example.com/a1.jpg", "https://example.com/a2.jpg"],
      duration: 11,
      resolution: "1080P",
      aspect_ratio: "9:16",
      prompt_expansion_mode: "disabled",
    });
    expect(expectAccepted(compileShortContinuationStep(plan, 1, "@d1"))).toMatchObject({
      video_url: "https://example.com/d1.mp4",
      duration: 10,
      resolution: "1080P",
      aspect_ratio: "auto",
      output: "extended",
      enable_prompt_expansion: false,
    });
    expect(expectAccepted(shortSheetStep({ description: CHARACTER.description, references: [] }))).toMatchObject({ image_size: "landscape_16_9", quality: "high" });
  });
});

const DEFAULTS = GOAL_SHORT_DEFAULTS;

const SAVED_SETTINGS = [
  { field: "aspectRatio", values: SHORT_ASPECT_RATIOS, defaults: [DEFAULTS.aspectRatio], compiledAs: [["clip", "options.aspect_ratio"]] },
  { field: "frame.model", values: SHORT_FRAME_MODELS, defaults: [DEFAULTS.frame.model], compiledAs: [["frame", "model"]] },
  { field: "frame.imageSize", values: SHORT_IMAGE_SIZES, defaults: Object.values(DEFAULTS.frame.imageSize), compiledAs: [["frame", "options.image_size"]] },
  { field: "frame.quality", values: SHORT_FRAME_QUALITIES, defaults: [DEFAULTS.frame.quality], compiledAs: [["frame", "options.quality"]] },
  { field: "frame.outputFormat", values: SHORT_FRAME_FORMATS, defaults: [DEFAULTS.frame.outputFormat], compiledAs: [["frame", "options.output_format"]] },
  { field: "video.model", values: SHORT_VIDEO_MODELS, defaults: [DEFAULTS.video.model], compiledAs: [["clip", "model"]] },
  { field: "video.extendModel", values: SHORT_EXTEND_MODELS, defaults: [DEFAULTS.video.extendModel], compiledAs: [["continuation", "model"]] },
  { field: "video.resolution", values: SHORT_RESOLUTIONS, defaults: [DEFAULTS.video.resolution], compiledAs: [["clip", "options.resolution"], ["continuation", "options.resolution"]] },
  { field: "video.promptExpansion", values: SHORT_PROMPT_EXPANSIONS, defaults: [DEFAULTS.video.promptExpansion], compiledAs: [["clip", "options.prompt_expansion_mode"]] },
  { field: "video.extendOutput", values: SHORT_EXTEND_OUTPUTS, defaults: [DEFAULTS.video.extendOutput], compiledAs: [["continuation", "options.output"]] },
] as const;

describe("saved short settings", () => {
  it.each(SAVED_SETTINGS)("loads a short saved with every allowed $field and compiles with that value", ({ field, values, compiledAs }) => {
    for (const value of values) {
      const stored = saved(withSetting(shortPlan(), field, value));
      const loaded = goalShortPlanSchema.parse(stored);
      expect(loaded, `a short saved with ${field} ${value} must keep loading`).toEqual(stored);
      const steps = compiledSteps(loaded);
      for (const [step, path] of compiledAs) {
        expect(valueAt(steps[step].params, path), `${field} ${value} compiled as ${step} ${path}`).toBe(value);
        expectAccepted(steps[step]);
      }
    }
  });

  it.each(SAVED_SETTINGS)("records the default $field among the values a short may be saved with", ({ field, values, defaults }) => {
    for (const value of defaults) {
      expect(values, `New shorts now save ${field} ${value}. Add it to the allowed values next to every earlier one, so shorts saved before the change keep loading.`).toContain(value);
    }
  });
});

describe("refreshGoalShortPlan", () => {
  it("refreshes reference addresses from the cells' current slots and keeps those whose cell is gone", () => {
    const document: NotebookDocument = {
      id: "019a1f3e-5b10-7c2a-9d41-3f6b2a8c1e30",
      name: "Main",
      createdAt: "2026-11-12T00:00:00.000Z",
      edges: [],
      cells: [
        { id: sheet.cellId, type: "image", slot: { row: 2, column: 4 } },
        { id: shelter.cellId, type: "image", slot: { row: 0, column: 7 } },
      ],
    };
    const refreshed = refreshGoalShortPlan(shortPlan(), document);
    expect(refreshed.character.references.map((reference) => reference.address)).toEqual(["@c5", "@a2"]);
    expect(refreshed.frame.references.map((reference) => reference.address)).toEqual(["@a8", "@a4"]);
    expect(goalShortPlanSchema.parse(refreshed)).toEqual(refreshed);
    expect(compileShortFrameStep(refreshed).params.refs).toEqual({ image: ["@c5", "@a2", "@a8", "@a4"] });
    expect(compileShortClipStep(refreshed, "@d1").params.refs).toEqual({ first_frame: ["@d1"], image: ["@c5", "@a2"] });
  });
});

describe("browser-safe short modules", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const specifiers = /^\s*(?:import|export)\s+(type\s+)?[^;]*?\bfrom\s+"([^"]+)"|^\s*import\s+"([^"]+)"/gmu;

  function valueImports(file: string): string[] {
    return [...readFileSync(file, "utf8").matchAll(specifiers)].filter((match) => !match[1]).map((match) => (match[2] ?? match[3])!);
  }

  function reachable(file: string, seen = new Set<string>()): Set<string> {
    if (seen.has(file)) return seen;
    seen.add(file);
    for (const specifier of valueImports(file)) {
      if (specifier.startsWith(".")) reachable(resolve(dirname(file), specifier.replace(/\.js$/u, ".ts")), seen);
    }
    return seen;
  }

  function forbidden(specifier: string): boolean {
    return specifier.startsWith("node:") || builtinModules.includes(specifier) || specifier === "sharp" || specifier === "videobook-engine";
  }

  it.each(["goal-short-plan.ts", "goal-short-rules.ts"])("%s reaches no node:, sharp or engine barrel value import", (name) => {
    const files = [...reachable(join(here, name))];
    const problems = files.flatMap((file) => valueImports(file).filter(forbidden).map((specifier) => `${relative(here, file)} imports ${specifier}`));
    expect(problems).toEqual([]);
  });

  it("follows relative imports and notices a forbidden one", () => {
    expect([...reachable(join(here, "goal-short-plan.ts"))].map((file) => relative(here, file)).sort())
      .toEqual(["goal-short-plan.ts", "goal-short-rules.ts", "lightning-defaults.ts"]);
    expect(valueImports(join(here, "test-budget.ts")).filter(forbidden)).toEqual(["node:os"]);
  });
});
