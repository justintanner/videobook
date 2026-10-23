import { z, type RefinementCtx, type ZodRawShape, type ZodType } from "zod";
import { MachGenGenerateRequestSchema } from "@apicity/machgen/zod";
import type { WireSpec } from "./types.js";

type TaskType = "T2V" | "I2V" | "R2V";
type ReferenceKind = "image" | "video" | "audio";

interface MachGenModelSpec {
  taskTypes: readonly TaskType[];
  resolutions: Readonly<Record<string, number>>;
  defaultResolution: string;
  durations: { min: number; max: number; smart: boolean };
  aspectRatios: readonly string[];
  framesFollowImage?: boolean;
  videoConfig?: Readonly<Record<string, unknown>>;
  audioToggle: boolean;
  seed: boolean;
  lastFrame: "none" | "with_first" | "alone";
  references: readonly ReferenceKind[];
  visualReference: boolean;
  promptRequiredFor: readonly TaskType[];
  maxPromptChars?: number;
  maxSecondsWithBothFrames?: number;
  maxSecondsAt?: Readonly<Record<string, number>>;
  smartEditNeedsAdaptive?: boolean;
}

const DEFAULT_DURATION_SECONDS = 5;
const SEEDANCE_ASPECT_RATIOS = ["adaptive", "21:9", "16:9", "9:16", "1:1", "4:3", "3:4"];
const ALL_REFERENCES: readonly ReferenceKind[] = ["image", "video", "audio"];

export const MACHGEN_MODELS: Readonly<Record<string, MachGenModelSpec>> = {
  "MiniMax-H3": {
    taskTypes: ["T2V", "I2V", "R2V"],
    resolutions: { "480p": 480, "768p": 768, "1440p": 1440 },
    defaultResolution: "768p",
    durations: { min: 1, max: 30, smart: false },
    aspectRatios: ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"],
    audioToggle: true,
    seed: true,
    lastFrame: "alone",
    references: ALL_REFERENCES,
    visualReference: false,
    promptRequiredFor: ["T2V", "I2V", "R2V"],
    maxPromptChars: 65535,
    maxSecondsWithBothFrames: 15,
    maxSecondsAt: { "1440p": 15 },
  },
  "Seedance-2.5": {
    taskTypes: ["T2V", "I2V", "R2V"],
    resolutions: { "480p": 480, "720p": 720, "1080p": 1080 },
    defaultResolution: "720p",
    durations: { min: 4, max: 30, smart: true },
    aspectRatios: SEEDANCE_ASPECT_RATIOS,
    audioToggle: true,
    seed: false,
    lastFrame: "with_first",
    references: ALL_REFERENCES,
    visualReference: false,
    promptRequiredFor: ["T2V", "R2V"],
    maxPromptChars: 25000,
    smartEditNeedsAdaptive: true,
  },
  "Seedance-2.0": {
    taskTypes: ["T2V", "I2V", "R2V"],
    resolutions: { "480p": 480, "720p": 720, "1080p": 1080, "2160p": 2160 },
    defaultResolution: "720p",
    durations: { min: 4, max: 15, smart: true },
    aspectRatios: SEEDANCE_ASPECT_RATIOS,
    audioToggle: true,
    seed: true,
    lastFrame: "with_first",
    references: ALL_REFERENCES,
    visualReference: true,
    promptRequiredFor: ["T2V"],
  },
  "Alibaba-Wan-3.0": {
    taskTypes: ["T2V", "I2V", "R2V"],
    resolutions: { "480p": 480, "720p": 720, "1080p": 1080 },
    defaultResolution: "720p",
    durations: { min: 2, max: 30, smart: true },
    aspectRatios: [],
    videoConfig: { aspect_ratio: "adaptive", fps: 30, audio: true },
    audioToggle: false,
    seed: true,
    lastFrame: "with_first",
    references: ALL_REFERENCES,
    visualReference: false,
    promptRequiredFor: ["T2V"],
  },
  "HappyHorse-1.1": {
    taskTypes: ["T2V", "I2V", "R2V"],
    resolutions: { "720p": 720, "1080p": 1080 },
    defaultResolution: "720p",
    durations: { min: 3, max: 15, smart: false },
    aspectRatios: ["16:9", "9:16", "1:1", "4:3", "21:9"],
    framesFollowImage: true,
    audioToggle: false,
    seed: true,
    lastFrame: "none",
    references: ["image"],
    visualReference: true,
    promptRequiredFor: ["T2V"],
  },
  "Grok-Imagine-Video-1.5": {
    taskTypes: ["I2V"],
    resolutions: { "480p": 480, "720p": 720, "1080p": 1080 },
    defaultResolution: "720p",
    durations: { min: 1, max: 15, smart: false },
    aspectRatios: [],
    audioToggle: false,
    seed: false,
    lastFrame: "none",
    references: [],
    visualReference: true,
    promptRequiredFor: [],
  },
};

const REFERENCE_FIELDS: Readonly<Record<ReferenceKind, string>> = {
  image: "reference_image_urls",
  video: "reference_video_urls",
  audio: "reference_audio_urls",
};

const SOURCE_FIELDS: Readonly<Record<ReferenceKind, "src_image_urls" | "src_video_urls" | "src_audio_urls">> = {
  image: "src_image_urls",
  video: "src_video_urls",
  audio: "src_audio_urls",
};

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function list(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => text(item) !== null) : [];
}

function referencesOf(spec: MachGenModelSpec, value: Record<string, unknown>): Record<ReferenceKind, string[]> {
  const found: Record<ReferenceKind, string[]> = { image: [], video: [], audio: [] };
  for (const kind of spec.references) found[kind] = list(value[REFERENCE_FIELDS[kind]]);
  return found;
}

function hasFrames(value: Record<string, unknown>): boolean {
  return text(value.first_frame_url) !== null || text(value.last_frame_url) !== null;
}

function taskTypeOf(spec: MachGenModelSpec, value: Record<string, unknown>): TaskType {
  if (hasFrames(value)) return "I2V";
  const references = referencesOf(spec, value);
  return ALL_REFERENCES.some((kind) => references[kind].length > 0) ? "R2V" : "T2V";
}

function promptField(spec: MachGenModelSpec): ZodType {
  const prompt = spec.maxPromptChars === undefined ? z.string() : z.string().max(spec.maxPromptChars);
  return spec.taskTypes.every((task) => spec.promptRequiredFor.includes(task)) ? prompt.min(1) : prompt.optional();
}

function durationField(spec: MachGenModelSpec): ZodType {
  const { min, max, smart } = spec.durations;
  const seconds = z.number().int().min(min).max(max);
  return (smart ? z.union([z.literal(-1), seconds]) : seconds)
    .default(DEFAULT_DURATION_SECONDS)
    .describe(smart ? `Seconds (${min}-${max}); -1 lets the model choose the length` : `Seconds (${min}-${max})`);
}

function frameFields(spec: MachGenModelSpec): ZodRawShape {
  if (!spec.taskTypes.includes("I2V")) return {};
  const first = z.string().min(1);
  return {
    first_frame_url: spec.taskTypes.length === 1 ? first : first.optional(),
    ...(spec.lastFrame === "none" ? {} : { last_frame_url: z.string().min(1).optional() }),
  };
}

function referenceFields(spec: MachGenModelSpec): ZodRawShape {
  const source = MachGenGenerateRequestSchema.shape;
  return Object.fromEntries(spec.references.map((kind) => [REFERENCE_FIELDS[kind], source[SOURCE_FIELDS[kind]]]));
}

function settingFields(spec: MachGenModelSpec): ZodRawShape {
  const [firstAspect, ...otherAspects] = spec.aspectRatios;
  return {
    duration: durationField(spec),
    resolution: z.enum(Object.keys(spec.resolutions) as [string, ...string[]])
      .default(spec.defaultResolution)
      .describe("Output resolution"),
    ...(firstAspect === undefined ? {} : {
      aspect_ratio: z.enum([firstAspect, ...otherAspects]).default(firstAspect).describe("Output aspect ratio"),
    }),
    ...(spec.audioToggle ? { generate_audio: z.boolean().default(true).describe("Generate a soundtrack with the video") } : {}),
    ...(spec.seed ? { seed: z.number().int().min(0).max(2_147_483_647).optional().describe("Seed for reproducible output") } : {}),
  };
}

function addIssue(ctx: RefinementCtx, path: string, message: string): void {
  ctx.addIssue({ code: "custom", message, path: path ? [path] : [] });
}

function checkFrames(spec: MachGenModelSpec, value: Record<string, unknown>, ctx: RefinementCtx): void {
  if (!hasFrames(value)) return;
  const references = referencesOf(spec, value);
  for (const kind of ALL_REFERENCES) {
    if (references[kind].length > 0) addIssue(ctx, REFERENCE_FIELDS[kind], "cannot be combined with first_frame_url or last_frame_url");
  }
  if (text(value.first_frame_url) === null && spec.lastFrame !== "alone") addIssue(ctx, "last_frame_url", "last_frame_url requires first_frame_url");
  const both = text(value.first_frame_url) !== null && text(value.last_frame_url) !== null;
  const limit = spec.maxSecondsWithBothFrames;
  if (both && limit !== undefined && typeof value.duration === "number" && value.duration > limit) {
    addIssue(ctx, "duration", `a first and last frame allow at most ${limit} seconds`);
  }
}

function checkReferences(spec: MachGenModelSpec, value: Record<string, unknown>, task: TaskType, ctx: RefinementCtx): void {
  if (task !== "R2V") return;
  const references = referencesOf(spec, value);
  if (spec.visualReference && references.image.length === 0 && references.video.length === 0) {
    addIssue(ctx, "", "reference-to-video needs at least one reference image or video");
  }
  if (spec.smartEditNeedsAdaptive && value.duration === -1 && references.video.length > 0 && value.aspect_ratio !== "adaptive") {
    addIssue(ctx, "aspect_ratio", "-1 duration with a reference video edits that video and needs the adaptive aspect ratio");
  }
}

function checkSettings(spec: MachGenModelSpec, value: Record<string, unknown>, task: TaskType, ctx: RefinementCtx): void {
  if (!spec.taskTypes.includes(task)) addIssue(ctx, "", `${task} is not supported; use ${spec.taskTypes.join(", ")}`);
  if (spec.promptRequiredFor.includes(task) && text(value.prompt) === null) addIssue(ctx, "prompt", "Required");
  const limit = typeof value.resolution === "string" ? spec.maxSecondsAt?.[value.resolution] : undefined;
  if (limit !== undefined && typeof value.duration === "number" && value.duration > limit) {
    addIssue(ctx, "duration", `${String(value.resolution)} allows at most ${limit} seconds`);
  }
}

function machgenInput(spec: MachGenModelSpec): WireSpec["input"] {
  return z.object({
    prompt: promptField(spec),
    ...frameFields(spec),
    ...referenceFields(spec),
    ...settingFields(spec),
  }).superRefine((value, ctx) => {
    const record = value as Record<string, unknown>;
    const task = taskTypeOf(spec, record);
    checkSettings(spec, record, task, ctx);
    checkFrames(spec, record, ctx);
    checkReferences(spec, record, task, ctx);
  });
}

function frameSources(value: Record<string, unknown>): Record<string, unknown> {
  const first = text(value.first_frame_url);
  const last = text(value.last_frame_url);
  if (first === null && last !== null) return { src_image_urls: [last], keyframe_indices: [-1] };
  return { src_image_urls: [first, last].filter((url): url is string => url !== null) };
}

function referenceSources(spec: MachGenModelSpec, value: Record<string, unknown>): Record<string, unknown> {
  const references = referencesOf(spec, value);
  return Object.fromEntries(ALL_REFERENCES
    .filter((kind) => references[kind].length > 0)
    .map((kind) => [SOURCE_FIELDS[kind], references[kind]]));
}

function videoConfig(spec: MachGenModelSpec, value: Record<string, unknown>, task: TaskType): Record<string, unknown> {
  const aspect = text(value.aspect_ratio);
  return {
    height: spec.resolutions[String(value.resolution)],
    duration_secs: value.duration,
    ...(aspect !== null && !(task === "I2V" && spec.framesFollowImage) ? { aspect_ratio: aspect } : {}),
    ...(typeof value.generate_audio === "boolean" ? { audio: value.generate_audio } : {}),
    ...spec.videoConfig,
  };
}

function machgenRequest(apiId: string, spec: MachGenModelSpec, value: Record<string, unknown>): Record<string, unknown> {
  const task = taskTypeOf(spec, value);
  return {
    model: apiId,
    task_type: task,
    prompt: typeof value.prompt === "string" ? value.prompt : "",
    video_config: videoConfig(spec, value, task),
    ...(typeof value.seed === "number" ? { seed: value.seed } : {}),
    ...(task === "I2V" ? frameSources(value) : {}),
    ...(task === "R2V" ? referenceSources(spec, value) : {}),
  };
}

export function machgenWire(apiId: string): WireSpec | null {
  const spec = MACHGEN_MODELS[apiId];
  if (!spec) return null;
  return {
    input: machgenInput(spec),
    fixed: {},
    wrap: (value) => machgenRequest(apiId, spec, value),
    request: MachGenGenerateRequestSchema,
  };
}
