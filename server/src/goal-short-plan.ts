import { z } from "zod";
import type { NotebookDocument } from "videobook-engine";
import { notebookGridTag } from "videobook-engine/notebook-grid";
import type { ChainStep } from "./chain-plan.js";
import { SHORT_RULES } from "./goal-short-rules.js";
import { LIGHTNING_COLD_OPEN_SECONDS, LIGHTNING_WATERMARK_PROFILE } from "./lightning-defaults.js";

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

export type ShortAspectRatio = (typeof SHORT_ASPECT_RATIOS)[number];

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

export const SHORT_WORD_CEILINGS = { title: 6, frame: 40, beat: 45 } as const;

const SHORT_MIN_SECONDS = 5;
const SHORT_MAX_SECONDS = 60;
const SEGMENT_MAX_SECONDS = 15;
const SEGMENT_LIMIT = 4;
const CHARACTER_REFERENCE_LIMIT = 4;
const FRAME_REFERENCE_LIMIT = 12;
const SHEET_TEXT_MODEL = "fal:openai/gpt-image-2.6/sunburst/text-to-image";
const SHEET_EDIT_MODEL = GOAL_SHORT_DEFAULTS.frame.model;

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

export const goalShortPlanSchema = z.object({
  version: z.literal(4),
  title: z.string().trim().min(1).max(120),
  aspectRatio: z.enum(SHORT_ASPECT_RATIOS),
  character: z.object({
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().min(1).max(400),
    silent: z.literal(true),
    references: z.array(goalShortImageRefSchema).max(CHARACTER_REFERENCE_LIMIT),
  }).strict(),
  frame: z.object({
    prompt: z.string().trim().min(1).max(2000),
    model: z.enum(SHORT_FRAME_MODELS),
    imageSize: z.enum(SHORT_IMAGE_SIZES),
    quality: z.enum(SHORT_FRAME_QUALITIES),
    outputFormat: z.enum(SHORT_FRAME_FORMATS),
    references: z.array(goalShortImageRefSchema).max(FRAME_REFERENCE_LIMIT),
  }).strict(),
  segments: segmentsSchema,
  video: z.object({
    model: z.enum(SHORT_VIDEO_MODELS),
    extendModel: z.enum(SHORT_EXTEND_MODELS),
    resolution: z.enum(SHORT_RESOLUTIONS),
    promptExpansion: z.enum(SHORT_PROMPT_EXPANSIONS),
    extendOutput: z.enum(SHORT_EXTEND_OUTPUTS),
  }).strict(),
  rules: z.object({
    frame: z.string().trim().min(1),
    video: z.string().trim().min(1),
    silence: z.string().trim().min(1),
  }).strict(),
  finish: z.object({
    suggestedColdOpenSeconds: z.number().positive(),
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
  }).strict(),
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

export type GoalShortPlan = z.infer<typeof goalShortPlanSchema>;

type ShortReferenceInput = Omit<GoalShortImageRef, "slot">;

export type ShortTiming = {
  aspectRatio: ShortAspectRatio;
  totalSeconds: number;
  segmentSeconds: number[];
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

function evenSegments(totalSeconds: number): number[] {
  const count = Math.ceil(totalSeconds / SEGMENT_MAX_SECONDS);
  const base = Math.floor(totalSeconds / count);
  const longer = totalSeconds % count;
  return Array.from({ length: count }, (_, index) => base + (index < longer ? 1 : 0));
}

export function shortTiming(brief: string): ShortTiming {
  const totalSeconds = briefSeconds(brief) ?? GOAL_SHORT_DEFAULTS.totalSeconds;
  if (totalSeconds < SHORT_MIN_SECONDS || totalSeconds > SHORT_MAX_SECONDS) {
    throw new Error(`A short runs ${SHORT_MIN_SECONDS} to ${SHORT_MAX_SECONDS} seconds; the brief asks for ${totalSeconds}.`);
  }
  return { aspectRatio: briefAspectRatio(brief), totalSeconds, segmentSeconds: evenSegments(totalSeconds) };
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

export function buildGoalShortPlan(input: {
  title: string;
  aspectRatio: ShortAspectRatio;
  character: { name: string; description: string; references: readonly ShortReferenceInput[] };
  framePrompt: string;
  beats: readonly string[];
  segmentSeconds: readonly number[];
  extraReferences: readonly ShortReferenceInput[];
}): GoalShortPlan {
  if (input.beats.length !== input.segmentSeconds.length) {
    throw new Error(`A short needs one beat per segment: ${input.segmentSeconds.length} segments, ${input.beats.length} beats.`);
  }
  const profile = LIGHTNING_WATERMARK_PROFILE;
  const characterCount = input.character.references.length;
  return goalShortPlanSchema.parse({
    version: 4,
    title: input.title,
    aspectRatio: input.aspectRatio,
    character: {
      name: input.character.name,
      description: input.character.description,
      silent: true,
      references: slotted(input.character.references, 0),
    },
    frame: {
      prompt: input.framePrompt,
      model: GOAL_SHORT_DEFAULTS.frame.model,
      imageSize: GOAL_SHORT_DEFAULTS.frame.imageSize[input.aspectRatio],
      quality: GOAL_SHORT_DEFAULTS.frame.quality,
      outputFormat: GOAL_SHORT_DEFAULTS.frame.outputFormat,
      references: slotted(input.extraReferences, characterCount),
    },
    segments: input.segmentSeconds.map((seconds, index) => ({ prompt: input.beats[index], seconds })),
    video: { ...GOAL_SHORT_DEFAULTS.video },
    rules: { ...SHORT_RULES },
    finish: {
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
    },
  });
}

export function refreshGoalShortPlan(plan: GoalShortPlan, document: NotebookDocument): GoalShortPlan {
  const live = (reference: GoalShortImageRef): GoalShortImageRef => {
    const cell = document.cells.find((candidate) => candidate.id === reference.cellId);
    return cell ? { ...reference, address: notebookGridTag(cell.slot) } : reference;
  };
  return {
    ...plan,
    character: { ...plan.character, references: plan.character.references.map(live) },
    frame: { ...plan.frame, references: plan.frame.references.map(live) },
  };
}

function phrase(text: string): string {
  return text.trim().replace(/[\s.]+$/u, "");
}

function slotNames(count: number): string {
  const slots = Array.from({ length: count }, (_, index) => `@image${index + 1}`);
  return slots.length > 1 ? `${slots.slice(0, -1).join(", ")} and ${slots.at(-1)}` : slots.join("");
}

function characterLine(plan: GoalShortPlan, who: string, instruction: string): string | null {
  const count = plan.character.references.length;
  if (count === 0) return null;
  return `${slotNames(count)} ${count > 1 ? "are" : "is"} ${who}: ${instruction}`;
}

function paragraphs(...parts: (string | null)[]): string {
  return parts.filter((part): part is string => part !== null).join("\n\n");
}

function addresses(references: readonly GoalShortImageRef[]): string[] {
  return references.map((reference) => reference.address);
}

export function compileShortFrameStep(plan: GoalShortPlan): ChainStep {
  const { character, frame } = plan;
  const placeLine = frame.references.length === 0
    ? null
    : `${character.references.length > 0 ? "The other images" : "The images"} are references for the place and props.`;
  const images = addresses([...character.references, ...frame.references]);
  return {
    id: "frame",
    tool: "generate_image",
    params: {
      model: frame.model,
      prompt: paragraphs(
        frame.prompt,
        characterLine(plan, `${phrase(character.name)} (${phrase(character.description)})`, "keep the face, hair, build and clothes exactly."),
        placeLine,
        plan.rules.frame,
      ),
      ...(images.length > 0 ? { refs: { image: images } } : {}),
      options: {
        image_size: frame.imageSize,
        quality: frame.quality,
        output_format: frame.outputFormat,
      },
    },
  };
}

export function compileShortClipStep(plan: GoalShortPlan, frameAddress: string): ChainStep {
  const characters = addresses(plan.character.references);
  const segment = plan.segments[0];
  return {
    id: "clip1",
    tool: "generate_video",
    params: {
      model: plan.video.model,
      prompt: paragraphs(
        segment.prompt,
        characterLine(plan, phrase(plan.character.name), "keep the same person in the same clothes."),
        plan.rules.video,
        plan.rules.silence,
      ),
      refs: { first_frame: [frameAddress], ...(characters.length > 0 ? { image: characters } : {}) },
      options: {
        duration: segment.seconds,
        resolution: plan.video.resolution,
        aspect_ratio: plan.aspectRatio,
        prompt_expansion_mode: plan.video.promptExpansion,
      },
    },
  };
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
    },
  };
}

export type ShortSheetCharacter = {
  description: string;
  references: readonly string[];
};

export function shortSheetStep(character: ShortSheetCharacter): ChainStep {
  const references = [...character.references];
  return {
    id: "sheet",
    tool: "generate_image",
    params: {
      model: references.length > 0 ? SHEET_EDIT_MODEL : SHEET_TEXT_MODEL,
      prompt: paragraphs(
        `Character reference sheet of ${phrase(character.description)}: the same person three times on a plain light grey background, a front view, a three-quarter view and a full-body view, neutral expression, mouth closed, even daylight.`,
        SHORT_RULES.frame,
      ),
      ...(references.length > 0 ? { refs: { image: references } } : {}),
      options: { image_size: "landscape_16_9", quality: "high" },
    },
  };
}
