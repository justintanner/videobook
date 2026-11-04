import { z, type RefinementCtx, type ZodRawShape, type ZodType } from "zod";
import {
  MACHGEN_I2I_MAX_IMAGES,
  MACHGEN_VIDEO_GRIDS,
  MACHGEN_VIDEO_MODEL_TASK_TYPES,
  MACHGEN_VIDEO_SHARPEN,
  MACHGEN_VIDEO_UPSCALE,
  MachGenGenerateRequestSchema,
  type MachGenVideoGrid,
} from "@apicity/machgen/zod";
import type { WireSpec } from "./types.js";

type TaskType = "T2V" | "I2V" | "R2V";
type ReferenceKind = "image" | "video" | "audio";
type LastFrame = "none" | "with_first" | "alone";

interface MachGenModelFacts {
  audioToggle: boolean;
  seed: boolean;
  promptRequiredFor: readonly TaskType[];
  maxPromptChars?: number;
  references?: readonly ReferenceKind[];
  visualReference?: boolean;
  privateHeights?: readonly number[];
  videoConfig?: Readonly<Record<string, unknown>>;
  maxSecondsWithBothFrames?: number;
  maxSecondsAtHeight?: Readonly<Record<number, number>>;
  smartEditNeedsAdaptive?: boolean;
  multiShot?: boolean;
}

interface MachGenModelSpec extends MachGenModelFacts {
  taskTypes: readonly TaskType[];
  grids: Readonly<Partial<Record<TaskType, MachGenVideoGrid>>>;
  heights: readonly number[];
  durations: readonly number[];
  aspectRatios: readonly string[];
  lastFrame: LastFrame;
  references: readonly ReferenceKind[];
  referenceCaps: Readonly<Partial<Record<ReferenceKind, number>>>;
  referenceTotal?: number;
  visualReference: boolean;
}

export interface MachGenUpscaleSpec {
  model: string;
  taskType: "UPSCALE" | "SHARPEN";
  action: string;
  height: number;
  sourceModel: string;
  sourceHeights: readonly number[];
  minSeconds: number;
  maxSeconds: number;
}

type ImageConfig = Readonly<Record<string, number | string>>;

interface MachGenImageSpec {
  resolutions: readonly string[];
  configs: Readonly<Record<string, Readonly<Record<string, ImageConfig>>>>;
  quality: boolean;
  seed: boolean;
}

const DEFAULT_DURATION_SECONDS = 5;
const MAX_REFERENCE_IMAGES = 9;
const MAX_SHOTS = 6;
const MAX_SHOT_PROMPT_CHARS = 512;
const ALL_TASKS: readonly TaskType[] = ["T2V", "I2V", "R2V"];
const TEXT_TASK: readonly TaskType[] = ["T2V"];
const ALL_REFERENCES: readonly ReferenceKind[] = ["image", "video", "audio"];
const SEED_FIELD = z.number().int().min(0).max(2_147_483_647).optional().describe("Seed for reproducible output");

const H3: MachGenModelFacts = { audioToggle: true, seed: true, promptRequiredFor: ALL_TASKS, maxPromptChars: 65535, privateHeights: [1080] };
const SEEDANCE_20_TIER: MachGenModelFacts = { audioToggle: true, seed: true, promptRequiredFor: ALL_TASKS };
const VIDU_Q3: MachGenModelFacts = { audioToggle: true, seed: true, promptRequiredFor: TEXT_TASK, maxPromptChars: 5000 };
const VEO: MachGenModelFacts = { audioToggle: false, seed: true, promptRequiredFor: TEXT_TASK };
const PIXVERSE: MachGenModelFacts = { audioToggle: true, seed: true, promptRequiredFor: TEXT_TASK, maxPromptChars: 2048 };
const HAPPYHORSE: MachGenModelFacts = { audioToggle: false, seed: true, promptRequiredFor: TEXT_TASK, references: ["image"] };

const MACHGEN_MODEL_FACTS: Readonly<Record<string, MachGenModelFacts>> = {
  "Wan2.2-A14B": { audioToggle: false, seed: true, promptRequiredFor: TEXT_TASK },
  "LTX-2.3-Pro": { audioToggle: true, seed: true, promptRequiredFor: TEXT_TASK },
  "Vidu-Q3-Turbo": VIDU_Q3,
  "Vidu-Q3-Pro": VIDU_Q3,
  "MiniMax-H3": { ...H3, maxSecondsWithBothFrames: 15, maxSecondsAtHeight: { 1440: 15 } },
  "MiniMax-H3-Turbo": H3,
  "MiniMax-H3-Omni": { audioToggle: true, seed: true, promptRequiredFor: ALL_TASKS, maxPromptChars: 65535 },
  "Seedance-2.5": { audioToggle: true, seed: false, promptRequiredFor: ["T2V", "R2V"], maxPromptChars: 25000, smartEditNeedsAdaptive: true },
  "Seedance-2.0": { audioToggle: true, seed: true, promptRequiredFor: TEXT_TASK },
  "Seedance-2.0-Fast": SEEDANCE_20_TIER,
  "Seedance-2.0-Mini": SEEDANCE_20_TIER,
  "Kling-v3": { audioToggle: true, seed: false, promptRequiredFor: TEXT_TASK, maxPromptChars: 2500 },
  "Kling-o3": { audioToggle: true, seed: false, promptRequiredFor: TEXT_TASK, maxPromptChars: 2500, multiShot: true },
  "Vidu-Q3": { ...VIDU_Q3, promptRequiredFor: [] },
  "Vidu-Q4-Preview": { audioToggle: true, seed: true, promptRequiredFor: ["R2V"], maxPromptChars: 20000, visualReference: true },
  "Vidu-Q3-Pro-Fast": { ...VIDU_Q3, promptRequiredFor: [] },
  "Alibaba-Wan-3.0": { audioToggle: false, seed: true, promptRequiredFor: TEXT_TASK, videoConfig: { aspect_ratio: "adaptive", fps: 30, audio: true } },
  "Veo-3.1": VEO,
  "Veo-3.1-Fast": VEO,
  "Pixverse-V6": PIXVERSE,
  "Pixverse-C1": PIXVERSE,
  "HappyHorse-1.1": HAPPYHORSE,
  "HappyHorse-1.0": HAPPYHORSE,
  "Grok-Imagine-Video": { audioToggle: false, seed: false, promptRequiredFor: TEXT_TASK },
  "Grok-Imagine-Video-1.5": { audioToggle: false, seed: false, promptRequiredFor: [] },
};

const TASK_NAMES: Readonly<Record<TaskType, string>> = {
  T2V: "Text to video",
  I2V: "Image to video",
  R2V: "Reference to video",
};

const CAP_KEYS: Readonly<Record<ReferenceKind, "images" | "videos" | "audios">> = {
  image: "images",
  video: "videos",
  audio: "audios",
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

function publishedTasks(apiId: string): TaskType[] {
  const published: Readonly<Record<string, readonly string[]>> = MACHGEN_VIDEO_MODEL_TASK_TYPES;
  const tasks = published[apiId] ?? [];
  return ALL_TASKS.filter((task) => tasks.includes(task));
}

function publishedGrids(apiId: string, tasks: readonly TaskType[]): Partial<Record<TaskType, MachGenVideoGrid>> {
  const grids = MACHGEN_VIDEO_GRIDS[apiId] ?? {};
  return Object.fromEntries(tasks.flatMap((task) => {
    const grid = grids[task];
    return grid ? [[task, grid]] : [];
  }));
}

function sortedUnion(lists: readonly (readonly number[])[]): number[] {
  return [...new Set(lists.flat())].sort((left, right) => left - right);
}

function offeredAspectRatios(grids: Partial<Record<TaskType, MachGenVideoGrid>>, facts: MachGenModelFacts): readonly string[] {
  if (facts.videoConfig?.aspect_ratio !== undefined) return [];
  return [grids.T2V, grids.R2V, grids.I2V]
    .map((grid) => grid?.aspectRatios ?? [])
    .find((ratios) => ratios.length > 0) ?? [];
}

function lastFrameOf(grid: MachGenVideoGrid | undefined): LastFrame {
  if (grid?.loneEndFrame) return "alone";
  return grid?.endFrame ? "with_first" : "none";
}

function acceptedReferences(grid: MachGenVideoGrid | undefined, facts: MachGenModelFacts): readonly ReferenceKind[] {
  if (!grid) return [];
  return facts.references ?? ALL_REFERENCES.filter((kind) => grid.references?.[CAP_KEYS[kind]] !== 0);
}

function referenceCaps(grid: MachGenVideoGrid | undefined): Partial<Record<ReferenceKind, number>> {
  return Object.fromEntries(ALL_REFERENCES.flatMap((kind) => {
    const cap = grid?.references?.[CAP_KEYS[kind]];
    return cap === undefined ? [] : [[kind, cap]];
  }));
}

function machgenSpec(apiId: string, facts: MachGenModelFacts): MachGenModelSpec {
  const taskTypes = publishedTasks(apiId);
  const grids = publishedGrids(apiId, taskTypes);
  const all = Object.values(grids);
  const total = grids.R2V?.references?.total;
  return {
    ...facts,
    taskTypes,
    grids,
    heights: sortedUnion(all.map((grid) => grid.heights)).filter((height) => !facts.privateHeights?.includes(height)),
    durations: sortedUnion(all.map((grid) => grid.durations)),
    aspectRatios: offeredAspectRatios(grids, facts),
    lastFrame: lastFrameOf(grids.I2V),
    references: acceptedReferences(grids.R2V, facts),
    referenceCaps: referenceCaps(grids.R2V),
    ...(total === undefined ? {} : { referenceTotal: total }),
    visualReference: facts.visualReference ?? grids.R2V?.visualReference ?? false,
  };
}

export const MACHGEN_MODELS: Readonly<Record<string, MachGenModelSpec>> = Object.fromEntries(
  Object.entries(MACHGEN_MODEL_FACTS).map(([apiId, facts]) => [apiId, machgenSpec(apiId, facts)]),
);

const GPT_IMAGE_TIERS: readonly string[] = ["1024p", "1080p", "2048p", "4096p"];

const GPT_IMAGE_SIZES: Readonly<Record<string, Readonly<Record<string, readonly [number, number]>>>> = {
  "1:1": { "1024p": [1280, 1280], "2048p": [2048, 2048] },
  "16:9": { "1024p": [1280, 720], "1080p": [1920, 1088], "2048p": [2048, 1152], "4096p": [3840, 2160] },
  "21:9": { "1024p": [1280, 544], "1080p": [1920, 816], "2048p": [2048, 880], "4096p": [3840, 1648] },
  "9:16": { "1024p": [720, 1280], "1080p": [1088, 1920], "2048p": [1152, 2048], "4096p": [2160, 3840] },
  "4:3": { "1024p": [1280, 960], "2048p": [2048, 1536] },
  "3:4": { "1024p": [960, 1280], "2048p": [1536, 2048] },
  "3:2": { "1024p": [1280, 848], "2048p": [2048, 1360] },
  "2:3": { "1024p": [848, 1280], "2048p": [1360, 2048] },
};

const NANO_BANANA_HEIGHTS: Readonly<Record<string, number>> = { "1K": 1024, "2K": 2048, "4K": 4096 };
const NANO_BANANA_ASPECT_RATIOS: readonly string[] = ["16:9", "21:9", "3:2", "4:3", "1:1", "4:5", "3:4", "2:3", "9:16"];

function sizeConfigs(): MachGenImageSpec["configs"] {
  return Object.fromEntries(Object.entries(GPT_IMAGE_SIZES).map(([aspect, tiers]) => [aspect, Object.fromEntries(
    Object.entries(tiers).map(([tier, [width, height]]) => [tier, { width, height }]),
  )]));
}

function heightConfigs(): MachGenImageSpec["configs"] {
  return Object.fromEntries(NANO_BANANA_ASPECT_RATIOS.map((aspect) => [aspect, Object.fromEntries(
    Object.entries(NANO_BANANA_HEIGHTS).map(([tier, height]) => [tier, { height, aspect_ratio: aspect }]),
  )]));
}

const GPT_IMAGE: MachGenImageSpec = { resolutions: GPT_IMAGE_TIERS, configs: sizeConfigs(), quality: false, seed: false };
const NANO_BANANA: MachGenImageSpec = { resolutions: Object.keys(NANO_BANANA_HEIGHTS), configs: heightConfigs(), quality: false, seed: false };

export const MACHGEN_IMAGE_SPECS: Readonly<Record<string, MachGenImageSpec>> = {
  "GPT-Image-2": { ...GPT_IMAGE, quality: true },
  "GPT-Image-2.5-Sunburst": GPT_IMAGE,
  "GPT-Image-2.5-Flare": GPT_IMAGE,
  "Nano-Banana-2": { ...NANO_BANANA, seed: true },
  "Nano-Banana-2.1": NANO_BANANA,
};

const OPTIMIZATION_LEVELS: Readonly<Record<string, string>> = { high: "STANDARD", low: "EXPRESS" };

const MACHGEN_UPSCALES: Readonly<Record<string, MachGenUpscaleSpec>> = {
  "MiniMax-H3/upscale": {
    model: "MiniMax-H3",
    taskType: "UPSCALE",
    action: "re-renders",
    height: MACHGEN_VIDEO_UPSCALE["MiniMax-H3"]?.heights[0] ?? 1440,
    sourceModel: "MiniMax-H3",
    sourceHeights: [768],
    minSeconds: 5,
    maxSeconds: 15,
  },
  "MiniMax-H3/sharpen": {
    model: "MiniMax-H3",
    taskType: "SHARPEN",
    action: "sharpens",
    height: 0,
    sourceModel: "MiniMax-H3",
    sourceHeights: MACHGEN_VIDEO_SHARPEN["MiniMax-H3"]?.heights ?? [480, 768],
    minSeconds: 1,
    maxSeconds: 30,
  },
};

const MACHGEN_TASK_URL = /^https:\/\/api\.machgen\.ai\/api\/v0\/assets\/([^/?#]+)#t=0,(\d+)$/u;

export function machgenUpscale(apiId: string): MachGenUpscaleSpec | null {
  return MACHGEN_UPSCALES[apiId] ?? null;
}

export function machgenTaskUrl(taskId: string, seconds: number): string {
  return `https://api.machgen.ai/api/v0/assets/${encodeURIComponent(taskId)}#t=0,${seconds}`;
}

function parseTaskUrl(value: unknown): { taskId: string; seconds: number } | null {
  const match = typeof value === "string" ? MACHGEN_TASK_URL.exec(value) : null;
  return match ? { taskId: decodeURIComponent(match[1]!), seconds: Number(match[2]) } : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function list(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => text(item) !== null) : [];
}

function resolutionLabel(height: number): string {
  return `${height}p`;
}

function heightOf(value: Record<string, unknown>): number | undefined {
  const match = typeof value.resolution === "string" ? /^(\d+)p$/u.exec(value.resolution) : null;
  return match ? Number(match[1]) : undefined;
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

function gridAspect(grid: MachGenVideoGrid | undefined, aspect: string): string | null | undefined {
  const allowed = grid?.aspectRatios;
  if (allowed === undefined || allowed.includes(aspect)) return aspect;
  if (allowed.length === 0) return null;
  return allowed.includes("adaptive") ? "adaptive" : undefined;
}

function secondsList(durations: readonly number[]): string {
  return durations.map((seconds) => seconds === -1 ? "-1" : String(seconds)).join(", ");
}

function promptField(spec: MachGenModelSpec): ZodType {
  const prompt = spec.maxPromptChars === undefined ? z.string() : z.string().max(spec.maxPromptChars);
  return spec.taskTypes.every((task) => spec.promptRequiredFor.includes(task)) ? prompt.min(1) : prompt.optional();
}

function secondsField(seconds: readonly number[]): ZodType {
  const first = seconds[0]!;
  const last = seconds[seconds.length - 1]!;
  if (seconds.length > 1 && last - first + 1 === seconds.length) return z.number().int().min(first).max(last);
  const [only, second, ...rest] = seconds.map((value) => z.literal(value));
  return second === undefined ? only! : z.union([only!, second, ...rest]);
}

function durationDescription(seconds: readonly number[], smart: boolean): string {
  const first = seconds[0]!;
  const last = seconds[seconds.length - 1]!;
  const range = last - first + 1 === seconds.length ? `${first}-${last}` : seconds.join(", ");
  return smart ? `Seconds (${range}); -1 lets the model choose the length` : `Seconds (${range})`;
}

function durationField(spec: MachGenModelSpec): ZodType {
  const seconds = spec.durations.filter((value) => value > 0);
  const smart = spec.durations.includes(-1);
  const field = smart ? z.union([z.literal(-1), secondsField(seconds)]) : secondsField(seconds);
  const fallback = seconds.includes(DEFAULT_DURATION_SECONDS) ? DEFAULT_DURATION_SECONDS : seconds[0]!;
  return field.default(fallback).describe(durationDescription(seconds, smart));
}

function frameFields(spec: MachGenModelSpec): ZodRawShape {
  if (!spec.taskTypes.includes("I2V")) return {};
  const first = z.string().min(1);
  return {
    first_frame_url: spec.taskTypes.length === 1 ? first : first.optional(),
    ...(spec.lastFrame === "none" ? {} : { last_frame_url: z.string().min(1).optional() }),
  };
}

function referenceField(spec: MachGenModelSpec, kind: ReferenceKind): ZodType {
  const cap = spec.referenceCaps[kind] ?? (kind === "image" ? MAX_REFERENCE_IMAGES : undefined);
  return cap === undefined ? MachGenGenerateRequestSchema.shape[SOURCE_FIELDS[kind]] : z.array(z.string()).max(cap).optional();
}

function referenceFields(spec: MachGenModelSpec): ZodRawShape {
  return Object.fromEntries(spec.references.map((kind) => [REFERENCE_FIELDS[kind], referenceField(spec, kind)]));
}

function settingFields(spec: MachGenModelSpec): ZodRawShape {
  const labels = spec.heights.map(resolutionLabel);
  const [firstAspect, ...otherAspects] = spec.aspectRatios;
  return {
    duration: durationField(spec),
    resolution: z.enum(labels as [string, ...string[]]).default(labels[labels.length - 1]!).describe("Output resolution"),
    ...(firstAspect === undefined ? {} : {
      aspect_ratio: z.enum([firstAspect, ...otherAspects]).default(firstAspect).describe("Output aspect ratio"),
    }),
    ...(spec.audioToggle ? { generate_audio: z.boolean().default(true).describe("Generate a soundtrack with the video") } : {}),
    ...(spec.seed ? { seed: SEED_FIELD } : {}),
  };
}

function videoOperationFields(spec: MachGenModelSpec): ZodRawShape {
  const [first, ...rest] = spec.grids.R2V?.operations ?? [];
  if (first === undefined || rest.length === 0) return {};
  return {
    reference_video_operation: z.enum([first, ...rest]).optional()
      .describe("What to do with the reference video: reference it, edit it, or extend it"),
  };
}

function shotFields(spec: MachGenModelSpec): ZodRawShape {
  if (!spec.multiShot) return {};
  return {
    shot_type: z.enum(["intelligence", "customize"]).optional()
      .describe("Multi-shot video: intelligence lets the model plan the shots; customize takes multi_prompt and shot_durations"),
    multi_prompt: z.array(z.string().min(1).max(MAX_SHOT_PROMPT_CHARS)).min(1).max(MAX_SHOTS).optional()
      .describe(`Customize: one prompt per shot, in order (up to ${MAX_SHOTS} shots of ${MAX_SHOT_PROMPT_CHARS} characters)`),
    shot_durations: z.array(z.number().int().min(1)).min(1).max(MAX_SHOTS).optional()
      .describe("Customize: seconds per shot, adding up to duration"),
  };
}

function addIssue(ctx: RefinementCtx, path: string, message: string): void {
  ctx.addIssue({ code: "custom", message, path: path ? [path] : [] });
}

function checkSettings(spec: MachGenModelSpec, value: Record<string, unknown>, task: TaskType, ctx: RefinementCtx): void {
  if (!spec.taskTypes.includes(task)) addIssue(ctx, "", `${task} is not supported; use ${spec.taskTypes.join(", ")}`);
  if (spec.promptRequiredFor.includes(task) && text(value.prompt) === null) addIssue(ctx, "prompt", "Required");
  const height = heightOf(value);
  const limit = height === undefined ? undefined : spec.maxSecondsAtHeight?.[height];
  if (limit !== undefined && typeof value.duration === "number" && value.duration > limit) {
    addIssue(ctx, "duration", `${String(value.resolution)} allows at most ${limit} seconds`);
  }
}

function checkGrid(spec: MachGenModelSpec, value: Record<string, unknown>, task: TaskType, ctx: RefinementCtx): void {
  const grid = spec.grids[task];
  if (!grid) return;
  const height = heightOf(value);
  if (height !== undefined && !grid.heights.includes(height)) {
    const offered = grid.heights.filter((allowed) => spec.heights.includes(allowed)).map(resolutionLabel);
    addIssue(ctx, "resolution", `${TASK_NAMES[task]} offers ${offered.join(", ")}`);
  }
  if (typeof value.duration === "number" && !grid.durations.includes(value.duration)) {
    addIssue(ctx, "duration", `${TASK_NAMES[task]} offers ${secondsList(grid.durations)} seconds`);
  }
  const aspect = text(value.aspect_ratio);
  if (aspect !== null && gridAspect(grid, aspect) === undefined) {
    addIssue(ctx, "aspect_ratio", `${TASK_NAMES[task]} offers ${(grid.aspectRatios ?? []).join(", ")}`);
  }
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

function visualKinds(spec: MachGenModelSpec): ReferenceKind[] {
  return spec.references.filter((kind) => kind !== "audio");
}

function checkReferences(spec: MachGenModelSpec, value: Record<string, unknown>, task: TaskType, ctx: RefinementCtx): void {
  if (task !== "R2V") return;
  const references = referencesOf(spec, value);
  if (spec.visualReference && visualKinds(spec).every((kind) => references[kind].length === 0)) {
    addIssue(ctx, "", `reference-to-video needs at least one reference ${visualKinds(spec).join(" or ")}`);
  }
  const total = ALL_REFERENCES.reduce((sum, kind) => sum + references[kind].length, 0);
  if (spec.referenceTotal !== undefined && total > spec.referenceTotal) {
    addIssue(ctx, "", `reference-to-video takes at most ${spec.referenceTotal} references in all`);
  }
  if (spec.smartEditNeedsAdaptive && value.duration === -1 && references.video.length > 0 && value.aspect_ratio !== "adaptive") {
    addIssue(ctx, "aspect_ratio", "-1 duration with a reference video edits that video and needs the adaptive aspect ratio");
  }
}

function checkShots(spec: MachGenModelSpec, value: Record<string, unknown>, ctx: RefinementCtx): void {
  if (!spec.multiShot) return;
  const prompts = Array.isArray(value.multi_prompt) ? value.multi_prompt : null;
  const durations = Array.isArray(value.shot_durations) ? value.shot_durations as number[] : null;
  if (value.shot_type !== "customize") {
    if (prompts || durations) addIssue(ctx, "shot_type", "multi_prompt and shot_durations need shot_type customize");
    return;
  }
  if (!prompts) addIssue(ctx, "multi_prompt", "Required with shot_type customize");
  if (!durations) addIssue(ctx, "shot_durations", "Required with shot_type customize");
  if (!prompts || !durations) return;
  if (durations.length !== prompts.length) addIssue(ctx, "shot_durations", `needs one entry for each of the ${prompts.length} shots`);
  const sum = durations.reduce((total, seconds) => total + seconds, 0);
  if (sum !== value.duration) addIssue(ctx, "shot_durations", `add up to ${sum} seconds; set duration to ${sum}`);
}

function machgenInput(spec: MachGenModelSpec): WireSpec["input"] {
  return z.object({
    prompt: promptField(spec),
    ...frameFields(spec),
    ...referenceFields(spec),
    ...settingFields(spec),
    ...shotFields(spec),
    ...videoOperationFields(spec),
  }).superRefine((value, ctx) => {
    const record = value as Record<string, unknown>;
    const task = taskTypeOf(spec, record);
    checkSettings(spec, record, task, ctx);
    checkGrid(spec, record, task, ctx);
    checkFrames(spec, record, ctx);
    checkReferences(spec, record, task, ctx);
    checkShots(spec, record, ctx);
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
  const operation = text(value.reference_video_operation);
  return {
    ...Object.fromEntries(ALL_REFERENCES
      .filter((kind) => references[kind].length > 0)
      .map((kind) => [SOURCE_FIELDS[kind], references[kind]])),
    ...(operation && references.video.length > 0 ? { reference_video_operation: operation } : {}),
  };
}

function shotConfig(value: Record<string, unknown>): Record<string, unknown> {
  if (value.shot_type === "intelligence") return { shot_type: "intelligence" };
  if (value.shot_type !== "customize") return {};
  return { shot_type: "customize", multi_prompt: value.multi_prompt, shot_durations: value.shot_durations };
}

function videoConfig(spec: MachGenModelSpec, value: Record<string, unknown>, task: TaskType): Record<string, unknown> {
  const aspect = text(value.aspect_ratio);
  const sent = aspect === null ? null : gridAspect(spec.grids[task], aspect);
  return {
    height: heightOf(value),
    duration_secs: value.duration,
    ...(sent ? { aspect_ratio: sent } : {}),
    ...(typeof value.generate_audio === "boolean" ? { audio: value.generate_audio } : {}),
    ...shotConfig(value),
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

function imageConfig(spec: MachGenImageSpec, value: Record<string, unknown>): ImageConfig | undefined {
  return spec.configs[String(value.aspect_ratio)]?.[String(value.resolution)];
}

function imageInput(apiId: string, spec: MachGenImageSpec): WireSpec["input"] {
  const [firstAspect, ...otherAspects] = Object.keys(spec.configs) as [string, ...string[]];
  const [firstResolution, ...otherResolutions] = spec.resolutions as [string, ...string[]];
  return z.object({
    prompt: z.string().min(1),
    image_urls: MachGenGenerateRequestSchema.shape.src_image_urls.unwrap().max(MACHGEN_I2I_MAX_IMAGES[apiId]!).optional(),
    aspect_ratio: z.enum([firstAspect, ...otherAspects]).default("1:1").describe("Output aspect ratio"),
    resolution: z.enum([firstResolution, ...otherResolutions]).default(firstResolution).describe("Output resolution"),
    ...(spec.quality ? { quality: z.enum(["high", "low"]).default("high").describe("Image quality: high is MachGen's STANDARD level, low its far cheaper EXPRESS level") } : {}),
    ...(spec.seed ? { seed: SEED_FIELD } : {}),
  }).superRefine((value, ctx) => {
    if (imageConfig(spec, value)) return;
    const offered = spec.resolutions.filter((resolution) => spec.configs[value.aspect_ratio]?.[resolution]);
    addIssue(ctx, "resolution", `${value.aspect_ratio} offers ${offered.join(", ")}`);
  });
}

function imageRequest(apiId: string, spec: MachGenImageSpec, value: Record<string, unknown>): Record<string, unknown> {
  const sources = list(value.image_urls);
  const level = typeof value.quality === "string" ? OPTIMIZATION_LEVELS[value.quality] : undefined;
  return {
    model: apiId,
    task_type: sources.length > 0 ? "I2I" : "T2I",
    prompt: typeof value.prompt === "string" ? value.prompt : "",
    image_config: imageConfig(spec, value),
    ...(level ? { optimization_level: level } : {}),
    ...(typeof value.seed === "number" ? { seed: value.seed } : {}),
    ...(sources.length > 0 ? { src_image_urls: sources } : {}),
  };
}

export function machgenUpscaleRequirement(upscale: MachGenUpscaleSpec): string {
  const heights = upscale.sourceHeights.map(resolutionLabel).join(" or ");
  return `MachGen ${upscale.action} only its own ${upscale.sourceModel} ${heights} videos of ${upscale.minSeconds}-${upscale.maxSeconds} s`;
}

function upscaleVideoField(upscale: MachGenUpscaleSpec): z.ZodString {
  const target = upscale.taskType === "SHARPEN" ? "sharpen at its own length and height" : `re-render at ${resolutionLabel(upscale.height)}`;
  return z.string().min(1).describe(`The ${upscale.sourceModel} video to ${target}`);
}

function sourceHeightField(upscale: MachGenUpscaleSpec): ZodRawShape {
  if (upscale.taskType !== "SHARPEN") return {};
  return { source_height: z.number().int().positive().optional().describe("Height of the source video; filled from the connected book video") };
}

function upscaleInput(upscale: MachGenUpscaleSpec): WireSpec["input"] {
  return z.object({
    video_url: upscaleVideoField(upscale),
    ...sourceHeightField(upscale),
  }).superRefine((value, ctx) => {
    const source = parseTaskUrl(value.video_url);
    if (!source) addIssue(ctx, "video_url", `connect a video from this book; ${machgenUpscaleRequirement(upscale)}`);
    else if (source.seconds < upscale.minSeconds || source.seconds > upscale.maxSeconds) {
      addIssue(ctx, "video_url", `the source is ${source.seconds} s; ${machgenUpscaleRequirement(upscale)}`);
    }
  });
}

function upscaleHeight(upscale: MachGenUpscaleSpec, value: Record<string, unknown>): unknown {
  return upscale.taskType === "SHARPEN" ? value.source_height : upscale.height;
}

function upscaleRequest(upscale: MachGenUpscaleSpec, value: Record<string, unknown>): Record<string, unknown> {
  const source = parseTaskUrl(value.video_url);
  return {
    model: upscale.model,
    task_type: upscale.taskType,
    prompt: "",
    video_config: { height: upscaleHeight(upscale, value), duration_secs: source?.seconds },
    src_task_ids: [source?.taskId ?? String(value.video_url)],
  };
}

export const MACHGEN_TOPAZ_MODELS: readonly string[] = Object.keys(MACHGEN_VIDEO_UPSCALE).filter((apiId) => apiId.startsWith("Topaz-"));

export function machgenTopaz(apiId: string): boolean {
  return MACHGEN_TOPAZ_MODELS.includes(apiId);
}


function topazInput(apiId: string): WireSpec["input"] {
  const upscale = MACHGEN_VIDEO_UPSCALE[apiId]!;
  const labels = upscale.heights.map(resolutionLabel) as [string, ...string[]];
  const fallback = labels.includes("2160p") ? "2160p" : labels[labels.length - 1]!;
  const engines = upscale.engines as [string, ...string[]] | undefined;
  return z.object({
    video_url: z.string().min(1).describe("A completed MachGen video from this book"),
    resolution: z.enum(labels).default(fallback).describe("Target short-edge resolution; must exceed the source's short edge"),
    ...(engines?.length ? { engine: z.enum(engines).optional().describe("Topaz enhancement model") } : {}),
    source_seconds: z.number().int().positive().optional().describe("Whole seconds of the source video; filled from the connected book video"),
  }).superRefine((value, ctx) => {
    if (!parseTaskUrl(value.video_url)) addIssue(ctx, "video_url", "connect a completed MachGen video from this book; use Topaz Video Precision via fal for other videos");
    if (value.source_seconds === undefined) addIssue(ctx, "video_url", "connect a video from this book so its length is known");
  });
}

function topazRequest(apiId: string, value: Record<string, unknown>): Record<string, unknown> {
  const engine = text(value.engine);
  const source = parseTaskUrl(value.video_url);
  return {
    model: apiId,
    task_type: "UPSCALE",
    prompt: "",
    video_config: { height: heightOf(value), duration_secs: value.source_seconds },
    src_task_ids: [source?.taskId ?? String(value.video_url)],
    ...(engine ? { upscale_config: { engine } } : {}),
  };
}

export function machgenWire(apiId: string): WireSpec | null {
  if (machgenTopaz(apiId)) {
    return { input: topazInput(apiId), fixed: {}, wrap: (value) => topazRequest(apiId, value), request: MachGenGenerateRequestSchema };
  }
  const upscale = MACHGEN_UPSCALES[apiId];
  if (upscale) {
    return { input: upscaleInput(upscale), fixed: {}, wrap: (value) => upscaleRequest(upscale, value), request: MachGenGenerateRequestSchema };
  }
  const image = MACHGEN_IMAGE_SPECS[apiId];
  if (image) {
    return { input: imageInput(apiId, image), fixed: {}, wrap: (value) => imageRequest(apiId, image, value), request: MachGenGenerateRequestSchema };
  }
  const spec = MACHGEN_MODELS[apiId];
  if (!spec) return null;
  return {
    input: machgenInput(spec),
    fixed: {},
    wrap: (value) => machgenRequest(apiId, spec, value),
    request: MachGenGenerateRequestSchema,
  };
}
