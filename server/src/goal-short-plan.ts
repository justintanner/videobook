import { z } from "zod";
import type { NotebookDocument } from "videobook-engine";
import { notebookGridTag } from "videobook-engine/notebook-grid";
import type { ChainStep } from "./chain-plan.js";
import { LEGACY_SHORT_SILENCE, SHORT_RULES } from "./goal-short-rules.js";
import { LIGHTNING_WATERMARK_PROFILE } from "./lightning-defaults.js";

export const SHORT_ASPECT_RATIOS = ["9:16", "16:9", "1:1"] as const;
export const SHORT_FRAME_MODELS = ["fal:openai/gpt-image-2.6/sunburst/edit", "fal:openai/gpt-image-2.6/flare/edit"] as const;
export const SHORT_IMAGE_SIZES = ["portrait_16_9", "landscape_16_9", "square_hd"] as const;
export const SHORT_FRAME_QUALITIES = ["high"] as const;
export const SHORT_FRAME_FORMATS = ["jpeg"] as const;
export const SHORT_VIDEO_MODELS = ["fal:minimax/h3-max/reference-to-video"] as const;
export const SHORT_EXTEND_MODELS = ["fal:minimax/h3-max/extend-video"] as const;
export const SHORT_RESOLUTIONS = ["1080P", "768P"] as const;
export const SHORT_PROMPT_EXPANSIONS = ["disabled", "balanced"] as const;
export const SHORT_EXTEND_OUTPUTS = ["extended"] as const;
export const SHORT_STORYBOARD_MODELS = ["fal:google/nano-banana-2.1/edit"] as const;
export const SHORT_STORYBOARD_ASPECT_RATIOS = ["1:1", "16:9", "21:9", "9:16", "4:3", "3:4", "3:2", "5:4", "4:5", "2:3", "4:1", "1:4", "8:1", "1:8"] as const;

export type ShortAspectRatio = (typeof SHORT_ASPECT_RATIOS)[number];
export type ShortStoryboardAspectRatio = (typeof SHORT_STORYBOARD_ASPECT_RATIOS)[number];

export const GOAL_SHORT_DEFAULTS = {
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
} as const satisfies {
  aspectRatio: ShortAspectRatio;
  totalSeconds: number;
  frame: {
    model: (typeof SHORT_FRAME_MODELS)[number];
    imageSize: Record<ShortAspectRatio, (typeof SHORT_IMAGE_SIZES)[number]>;
    quality: (typeof SHORT_FRAME_QUALITIES)[number];
    outputFormat: (typeof SHORT_FRAME_FORMATS)[number];
  };
  video: {
    model: (typeof SHORT_VIDEO_MODELS)[number];
    extendModel: (typeof SHORT_EXTEND_MODELS)[number];
    resolution: (typeof SHORT_RESOLUTIONS)[number];
    promptExpansion: (typeof SHORT_PROMPT_EXPANSIONS)[number];
    extendOutput: (typeof SHORT_EXTEND_OUTPUTS)[number];
  };
};

export const SHORT_WORD_CEILINGS = { title: 6, frame: 40, beat: 45, cleanup: 160 } as const;

const SHORT_MIN_SECONDS = 5;
const SHORT_MAX_SECONDS = 60;
const SEGMENT_MAX_SECONDS = 15;
const SEGMENT_LIMIT = 4;
const CHARACTER_REFERENCE_LIMIT = 4;
const FRAME_REFERENCE_LIMIT = 12;
const SOURCE_IMAGE_LIMIT = 12;
const STORYBOARD_FRAME_LIMIT = 4;

const goalShortImageRefSchema = z.object({
  kind: z.literal("image"),
  artifactId: z.string().min(1),
  cellId: z.string().min(1),
  address: z.string().min(1),
  label: z.string(),
  objectHash: z.string().min(1),
  slot: z.string().regex(/^@image[1-9]\d*$/u),
}).strict();

export type GoalShortImageRef = z.infer<typeof goalShortImageRefSchema>;

const storyboardSchema = z.object({
  video: z.object({
    artifactId: z.string().min(1),
    cellId: z.string().min(1).nullable(),
    address: z.string().min(1).nullable(),
    label: z.string(),
  }).strict(),
  model: z.enum(SHORT_STORYBOARD_MODELS),
  frames: z.array(goalShortImageRefSchema.omit({ slot: true }).extend({
    index: z.number().int().nonnegative(),
    atSeconds: z.number().nonnegative(),
    aspectRatio: z.enum(SHORT_STORYBOARD_ASPECT_RATIOS),
    prompt: z.string().trim().min(1).max(2000),
  }).strict()).min(1).max(STORYBOARD_FRAME_LIMIT),
}).strict().superRefine((storyboard, context) => {
  storyboard.frames.forEach((frame, position) => {
    if (frame.index !== position) {
      context.addIssue({ code: "custom", path: ["frames", position, "index"], message: `Expected storyboard frame index ${position}` });
    }
  });
});

export type ShortStoryboard = z.infer<typeof storyboardSchema>;
export type ShortStoryboardVideo = ShortStoryboard["video"];

const segmentsSchema = z.array(z.object({
  prompt: z.string().trim().min(1).max(2000),
  seconds: z.number().int().min(2).max(SEGMENT_MAX_SECONDS),
}).strict()).min(1).max(SEGMENT_LIMIT).superRefine((segments, context) => {
  if (segments[0] && segments[0].seconds < SHORT_MIN_SECONDS) {
    context.addIssue({ code: "custom", path: [0, "seconds"], message: `The first segment runs at least ${SHORT_MIN_SECONDS} seconds` });
  }
  const total = segments.reduce((sum, segment) => sum + segment.seconds, 0);
  if (total > SHORT_MAX_SECONDS) {
    context.addIssue({ code: "custom", message: `A short runs at most ${SHORT_MAX_SECONDS} seconds in total, not ${total}` });
  }
});

const frameSettingsSchema = z.object({
  prompt: z.string().trim().min(1).max(2000),
  model: z.enum(SHORT_FRAME_MODELS),
  imageSize: z.enum(SHORT_IMAGE_SIZES),
  quality: z.enum(SHORT_FRAME_QUALITIES),
  outputFormat: z.enum(SHORT_FRAME_FORMATS),
}).strict();

const videoSettingsSchema = z.object({
  model: z.enum(SHORT_VIDEO_MODELS),
  extendModel: z.enum(SHORT_EXTEND_MODELS),
  resolution: z.enum(SHORT_RESOLUTIONS),
  promptExpansion: z.enum(SHORT_PROMPT_EXPANSIONS),
  extendOutput: z.enum(SHORT_EXTEND_OUTPUTS),
}).strict();

const rulesSchema = z.object({
  frame: z.string().trim().min(1),
  video: z.string().trim().min(1),
  silence: z.string().trim().min(1),
}).strict();

const finishSchema = z.object({
  suggestedColdOpenSeconds: z.number().positive().optional(),
  watermark: z.object({
    platform: z.literal("tiktok"),
    handle: z.string().min(1),
    profileUrl: z.string().min(1),
    mode: z.literal("burn"),
    handleEndSeconds: z.number().nullable(),
    qrLeadSeconds: z.number().nullable(),
    handleOpacity: z.number(),
    qrOpacity: z.number(),
    fadeSeconds: z.number(),
  }).strict(),
}).strict();

const titleSchema = z.string().trim().min(1).max(120);

const goalShortPlanV4Schema = z.object({
  version: z.literal(4),
  title: titleSchema,
  aspectRatio: z.enum(SHORT_ASPECT_RATIOS),
  character: z.object({
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().min(1).max(400),
    silent: z.literal(true),
    references: z.array(goalShortImageRefSchema).max(CHARACTER_REFERENCE_LIMIT),
  }).strict(),
  frame: frameSettingsSchema.extend({
    references: z.array(goalShortImageRefSchema).max(FRAME_REFERENCE_LIMIT),
  }).strict(),
  segments: segmentsSchema,
  video: videoSettingsSchema,
  rules: rulesSchema,
  finish: finishSchema,
}).strict().superRefine((plan, context) => {
  const groups = [["character", plan.character.references], ["frame", plan.frame.references]] as const;
  let expected = 0;
  for (const [stage, references] of groups) {
    references.forEach((reference, index) => {
      const slot = `@image${++expected}`;
      if (reference.slot !== slot) {
        context.addIssue({ code: "custom", path: [stage, "references", index, "slot"], message: `Expected ${slot}: character references take the first image slots and frame references the next` });
      }
    });
  }
});

const goalShortPlanV5Schema = z.object({
  version: z.literal(5),
  title: titleSchema,
  aspectRatio: z.enum(SHORT_ASPECT_RATIOS),
  sourceImages: z.array(goalShortImageRefSchema).max(SOURCE_IMAGE_LIMIT),
  storyboard: storyboardSchema.optional(),
  frame: frameSettingsSchema,
  segments: segmentsSchema,
  video: videoSettingsSchema,
  rules: rulesSchema,
  finish: finishSchema,
}).strict().superRefine((plan, context) => {
  plan.sourceImages.forEach((reference, index) => {
    const slot = `@image${index + 1}`;
    if (reference.slot !== slot) {
      context.addIssue({ code: "custom", path: ["sourceImages", index, "slot"], message: `Expected ${slot}` });
    }
  });
});

export const goalShortPlanSchema = z.discriminatedUnion("version", [goalShortPlanV4Schema, goalShortPlanV5Schema]);

export type GoalShortPlanV4 = z.infer<typeof goalShortPlanV4Schema>;
export type GoalShortPlanV5 = z.infer<typeof goalShortPlanV5Schema>;
export type GoalShortPlan = z.infer<typeof goalShortPlanSchema>;

type ShortReferenceInput = Omit<GoalShortImageRef, "slot">;

const shortReferenceInputSchema = goalShortImageRefSchema.omit({ slot: true });

const segmentSecondsSchema = z.array(z.number().int().min(2).max(SEGMENT_MAX_SECONDS)).min(1).max(SEGMENT_LIMIT);

const goalShortDraftV4Schema = z.object({
  aspectRatio: z.enum(SHORT_ASPECT_RATIOS),
  segmentSeconds: segmentSecondsSchema,
  character: z.object({
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().min(1).max(400),
    references: z.array(shortReferenceInputSchema).max(CHARACTER_REFERENCE_LIMIT),
  }).strict(),
  extraReferences: z.array(shortReferenceInputSchema).max(FRAME_REFERENCE_LIMIT),
}).strict();

const goalShortDraftV5Schema = z.object({
  aspectRatio: z.enum(SHORT_ASPECT_RATIOS),
  segmentSeconds: segmentSecondsSchema,
  sourceImages: z.array(shortReferenceInputSchema).max(SOURCE_IMAGE_LIMIT),
  storyboard: storyboardSchema.optional(),
}).strict();

export const goalShortDraftSchema = z.union([goalShortDraftV5Schema, goalShortDraftV4Schema]);

export type GoalShortDraft = z.infer<typeof goalShortDraftSchema>;

export function isLegacyShortPlan(plan: GoalShortPlan): plan is GoalShortPlanV4 {
  return plan.version === 4;
}

export function shortStoryboardOf(plan: GoalShortPlan | GoalShortDraft | null | undefined): ShortStoryboard | null {
  return plan && "storyboard" in plan ? plan.storyboard ?? null : null;
}

export function formatShortSeconds(seconds: number): string {
  return (Math.round(seconds * 10) / 10).toFixed(1);
}

export function isLegacyShortDraft(draft: GoalShortDraft): draft is z.infer<typeof goalShortDraftV4Schema> {
  return "character" in draft;
}

export type ShortTiming = {
  aspectRatio: ShortAspectRatio;
  totalSeconds: number;
  segmentSeconds: number[];
  note: string | null;
};

function briefAspectRatio(brief: string): ShortAspectRatio {
  if (/\b(?:9:16|portrait|vertical)\b/iu.test(brief)) return "9:16";
  if (/\b(?:1:1|square)\b/iu.test(brief)) return "1:1";
  if (/\b(?:16:9|landscape|horizontal)\b/iu.test(brief)) return "16:9";
  return GOAL_SHORT_DEFAULTS.aspectRatio;
}

function briefSeconds(brief: string): number | null {
  const match = /(?<![\w.:])(\d+(?:\.\d+)?)[ -]*(?:s|secs?|seconds?)\b/iu.exec(brief);
  return match ? Math.round(Number(match[1])) : null;
}

const EXTEND_SOURCE_MIN_SECONDS = 1.625;

function evenSegments(totalSeconds: number, count = Math.ceil(totalSeconds / SEGMENT_MAX_SECONDS)): number[] {
  const size = Math.max(1, count);
  const base = Math.floor(totalSeconds / size);
  const longer = totalSeconds % size;
  return Array.from({ length: size }, (_, index) => base + (index < longer ? 1 : 0));
}

export function grownShortSegments(segmentSeconds: readonly number[], beatCount: number): number[] | null {
  if (beatCount <= segmentSeconds.length || beatCount > SEGMENT_LIMIT) return null;
  const total = segmentSeconds.reduce((sum, seconds) => sum + seconds, 0);
  const split = evenSegments(total, beatCount);
  const first = split[0] ?? 0;
  if (first < SHORT_MIN_SECONDS || split.some((seconds) => seconds < EXTEND_SOURCE_MIN_SECONDS || seconds > SEGMENT_MAX_SECONDS)) return null;
  return split;
}

export function shortTiming(brief: string): ShortTiming {
  const requested = briefSeconds(brief);
  const unclamped = requested ?? GOAL_SHORT_DEFAULTS.totalSeconds;
  const totalSeconds = Math.min(SHORT_MAX_SECONDS, Math.max(SHORT_MIN_SECONDS, unclamped));
  const note = requested !== null && requested !== totalSeconds
    ? `A short runs ${SHORT_MIN_SECONDS} to ${SHORT_MAX_SECONDS} seconds, so this one is ${totalSeconds}.`
    : null;
  return { aspectRatio: briefAspectRatio(brief), totalSeconds, segmentSeconds: evenSegments(totalSeconds), note };
}

function slotted(references: readonly ShortReferenceInput[], offset: number): GoalShortImageRef[] {
  return references.map(({ artifactId, cellId, address, label, objectHash }, index) => ({
    kind: "image",
    artifactId,
    cellId,
    address,
    label,
    objectHash,
    slot: `@image${offset + index + 1}`,
  }));
}

function assertBeatCount(segmentSeconds: readonly number[], beats: readonly string[]): void {
  if (beats.length !== segmentSeconds.length) {
    throw new Error(`A short needs one beat per segment: ${segmentSeconds.length} segments, ${beats.length} beats.`);
  }
}

function shortPlanBody(input: { title: string; aspectRatio: ShortAspectRatio; framePrompt: string; beats: readonly string[]; segmentSeconds: readonly number[] }) {
  const profile = LIGHTNING_WATERMARK_PROFILE;
  return {
    title: input.title,
    aspectRatio: input.aspectRatio,
    segments: input.segmentSeconds.map((seconds, index) => ({ prompt: input.beats[index], seconds })),
    video: { ...GOAL_SHORT_DEFAULTS.video },
    finish: {
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
    },
  };
}

function frameSettings(aspectRatio: ShortAspectRatio, prompt: string) {
  return {
    prompt,
    model: GOAL_SHORT_DEFAULTS.frame.model,
    imageSize: GOAL_SHORT_DEFAULTS.frame.imageSize[aspectRatio],
    quality: GOAL_SHORT_DEFAULTS.frame.quality,
    outputFormat: GOAL_SHORT_DEFAULTS.frame.outputFormat,
  };
}

export function buildGoalShortPlan(input: {
  title: string;
  aspectRatio: ShortAspectRatio;
  sourceImages: readonly ShortReferenceInput[];
  storyboard?: ShortStoryboard | null;
  framePrompt: string;
  beats: readonly string[];
  segmentSeconds: readonly number[];
}): GoalShortPlanV5 {
  assertBeatCount(input.segmentSeconds, input.beats);
  return goalShortPlanV5Schema.parse({
    version: 5,
    ...shortPlanBody(input),
    sourceImages: slotted(input.sourceImages, 0),
    ...(input.storyboard ? { storyboard: input.storyboard } : {}),
    frame: frameSettings(input.aspectRatio, input.framePrompt),
    rules: { ...SHORT_RULES },
  });
}

export function buildLegacyGoalShortPlan(input: {
  title: string;
  aspectRatio: ShortAspectRatio;
  character: { name: string; description: string; references: readonly ShortReferenceInput[] };
  framePrompt: string;
  beats: readonly string[];
  segmentSeconds: readonly number[];
  extraReferences: readonly ShortReferenceInput[];
}): GoalShortPlanV4 {
  assertBeatCount(input.segmentSeconds, input.beats);
  const characterCount = input.character.references.length;
  return goalShortPlanV4Schema.parse({
    version: 4,
    ...shortPlanBody(input),
    character: {
      name: input.character.name,
      description: input.character.description,
      silent: true,
      references: slotted(input.character.references, 0),
    },
    frame: {
      ...frameSettings(input.aspectRatio, input.framePrompt),
      references: slotted(input.extraReferences, characterCount),
    },
    rules: { frame: SHORT_RULES.frame, video: SHORT_RULES.video, silence: LEGACY_SHORT_SILENCE },
  });
}

export function refreshGoalShortPlan(plan: GoalShortPlan, document: NotebookDocument): GoalShortPlan {
  const live = <T extends { cellId: string | null; address: string | null }>(reference: T): T => {
    const cell = reference.cellId ? document.cells.find((candidate) => candidate.id === reference.cellId) : undefined;
    return cell ? { ...reference, address: notebookGridTag(cell.slot) } : reference;
  };
  if (plan.version === 4) {
    return {
      ...plan,
      character: { ...plan.character, references: plan.character.references.map(live) },
      frame: { ...plan.frame, references: plan.frame.references.map(live) },
    };
  }
  const { storyboard } = plan;
  return {
    ...plan,
    sourceImages: plan.sourceImages.map(live),
    ...(storyboard ? { storyboard: { ...storyboard, video: live(storyboard.video), frames: storyboard.frames.map(live) } } : {}),
  };
}

function phrase(text: string): string {
  return text.trim().replace(/[\s.]+$/u, "");
}

function slotNames(count: number): string {
  const slots = Array.from({ length: count }, (_, index) => `@image${index + 1}`);
  return slots.length > 1 ? `${slots.slice(0, -1).join(", ")} and ${slots.at(-1)}` : slots.join("");
}

function characterLine(count: number, who: string, instruction: string): string {
  if (count === 0) return `${who}: ${instruction}`;
  return `${slotNames(count)} ${count > 1 ? "are" : "is"} ${who}: ${instruction}`;
}

function sourceImageLine(count: number, instruction: string): string | null {
  if (count === 0) return null;
  const noun = count > 1 ? "source images" : "a source image";
  return `${slotNames(count)} ${count > 1 ? "are" : "is"} ${noun}: ${instruction}`;
}

function storyboardFrameLine(sourceCount: number): string {
  const slot = `@image${sourceCount + 1}`;
  const people = sourceCount === 0 ? "this prompt" : `${sourceCount > 1 ? "the source images" : "the source image"} and this prompt`;
  return `${slot} is the first frame of the storyboard: copy its camera angle, framing, pose and action, but take the people and animals from ${people}, never from ${slot}.`;
}

function paragraphs(...parts: (string | null)[]): string {
  return parts.filter((part): part is string => part !== null).join("\n\n");
}

function addresses(references: readonly GoalShortImageRef[]): string[] {
  return references.map((reference) => reference.address);
}

function frameModel(plan: GoalShortPlan, images: readonly string[]): string {
  return images.length > 0 ? plan.frame.model : plan.frame.model.replace(/\/edit$/u, "/text-to-image");
}

function frameStep(plan: GoalShortPlan, prompt: string, images: readonly string[]): ChainStep {
  return {
    id: "frame",
    tool: "generate_image",
    params: {
      model: frameModel(plan, images),
      prompt,
      ...(images.length > 0 ? { refs: { image: images } } : {}),
      options: {
        image_size: plan.frame.imageSize,
        quality: plan.frame.quality,
        output_format: plan.frame.outputFormat,
      },
    },
  };
}

export function compileShortStoryboardStep(storyboard: ShortStoryboard, index: number): ChainStep {
  const frame = storyboard.frames[index];
  if (!frame) throw new RangeError(`The storyboard has ${storyboard.frames.length} frames.`);
  return {
    id: `storyboard${index + 1}`,
    tool: "generate_image",
    params: {
      model: storyboard.model,
      prompt: frame.prompt,
      refs: { image: [frame.address] },
      options: { aspect_ratio: frame.aspectRatio, output_format: "jpeg" },
    },
  };
}

export function compileShortFrameStep(plan: GoalShortPlan, storyboardFrameAddress: string | null = null): ChainStep {
  if (plan.version === 4) {
    const { character, frame } = plan;
    const placeLine = frame.references.length === 0
      ? null
      : `${character.references.length > 0 ? "The other images" : "The images"} are references for the place and props.`;
    return frameStep(plan, paragraphs(
      frame.prompt,
      characterLine(character.references.length, `${phrase(character.name)} (${phrase(character.description)})`, "keep the face, hair, build and clothes exactly."),
      placeLine,
      plan.rules.frame,
    ), addresses([...character.references, ...frame.references]));
  }
  const images = addresses(plan.sourceImages);
  return frameStep(plan, paragraphs(
    plan.frame.prompt,
    sourceImageLine(images.length, images.length > 1
      ? "keep each person exactly as photographed (face, hair, build and clothes), and keep whatever else the brief takes from them."
      : "keep that person exactly as photographed (face, hair, build and clothes), and keep whatever else the brief takes from it."),
    storyboardFrameAddress ? storyboardFrameLine(images.length) : null,
    plan.rules.frame,
  ), storyboardFrameAddress ? [...images, storyboardFrameAddress] : images);
}

function clipStep(plan: GoalShortPlan, frameAddress: string, prompt: string, images: readonly string[]): ChainStep {
  const segment = plan.segments[0];
  return {
    id: "clip1",
    tool: "generate_video",
    params: {
      model: plan.video.model,
      prompt,
      refs: { first_frame: [frameAddress], ...(images.length > 0 ? { image: images } : {}) },
      options: {
        duration: segment.seconds,
        resolution: plan.video.resolution,
        aspect_ratio: plan.aspectRatio,
        prompt_expansion_mode: plan.video.promptExpansion,
      },
      transcribe: false,
    },
  };
}

export function compileShortClipStep(plan: GoalShortPlan, frameAddress: string): ChainStep {
  const segment = plan.segments[0];
  if (plan.version === 4) {
    return clipStep(plan, frameAddress, paragraphs(
      segment.prompt,
      characterLine(plan.character.references.length, phrase(plan.character.name), "keep the same person in the same clothes."),
      plan.rules.video,
      plan.rules.silence,
    ), addresses(plan.character.references));
  }
  return clipStep(plan, frameAddress, paragraphs(
    segment.prompt,
    sourceImageLine(plan.sourceImages.length, plan.sourceImages.length > 1
      ? "keep each person exactly, in the same clothes."
      : "keep that person exactly, in the same clothes."),
    plan.rules.video,
    plan.rules.silence,
  ), addresses(plan.sourceImages));
}

export function compileShortContinuationStep(plan: GoalShortPlan, index: number, clipAddress: string): ChainStep {
  const segment = index >= 1 ? plan.segments[index] : undefined;
  if (!segment) {
    throw new RangeError(`Segment ${index} is not a continuation in this ${plan.segments.length}-segment short.`);
  }
  return {
    id: `clip${index + 1}`,
    tool: "generate_video",
    params: {
      model: plan.video.extendModel,
      prompt: paragraphs(
        segment.prompt,
        "Continue the same shot: the same person, clothes, place and light.",
        plan.rules.video,
        plan.rules.silence,
      ),
      refs: { video: [clipAddress] },
      options: {
        duration: segment.seconds,
        resolution: plan.video.resolution,
        aspect_ratio: "auto",
        output: plan.video.extendOutput,
        enable_prompt_expansion: plan.video.promptExpansion !== "disabled",
      },
      transcribe: false,
    },
  };
}


