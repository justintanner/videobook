import { z } from "zod";
import type { NotebookDocument } from "videobook-engine";
import { notebookGridTag } from "videobook-engine/notebook-grid";
import type { ChainStep } from "./chain-plan.js";
import { goalPromptWords } from "./goal-prompt-budget.js";
import {
  LIGHTNING_COLD_OPEN_SECONDS,
  LIGHTNING_SCENE_ASPECT_RATIO,
  LIGHTNING_SCENE_MODEL,
  LIGHTNING_SCENE_OUTPUT_FORMAT,
  LIGHTNING_SCENE_PROMPT_WORDS,
  LIGHTNING_SCENE_RESOLUTION,
  LIGHTNING_VIDEO_DURATION_SECONDS,
  LIGHTNING_VIDEO_GENERATE_AUDIO,
  LIGHTNING_VIDEO_OUTPUT_FORMAT,
  LIGHTNING_VIDEO_PROMPT_WORDS,
  LIGHTNING_VIDEO_RESOLUTION,
  LIGHTNING_VIDEO_MODEL,
  LIGHTNING_WATERMARK_PROFILE,
  preservedPrompt,
} from "./lightning-defaults.js";

const IMAGE_LIMIT = 30;
const VIDEO_LIMIT = 10;
const LEGACY_SCENE_RESOLUTION = "2K";
const SCENE_MODELS = ["kie:nano-banana-2-1"] as const;
const SCENE_RESOLUTIONS = [LEGACY_SCENE_RESOLUTION, "4K"] as const;
const SCENE_OUTPUT_FORMATS = ["jpg"] as const;
const VIDEO_MODELS = ["kie:bytedance/seedance-2-5"] as const;
const VIDEO_RESOLUTIONS = ["1080p"] as const;
const VIDEO_OUTPUT_FORMATS = ["mp4"] as const;

export const goalMediaRefSchema = z.object({
  kind: z.enum(["image", "video"]),
  artifactId: z.string().min(1),
  cellId: z.string().min(1),
  address: z.string().min(1),
  label: z.string(),
  objectHash: z.string().min(1),
  slot: z.string().regex(/^@(?:image|video)\d+$/u),
}).strict();

export type GoalMediaRef = z.infer<typeof goalMediaRefSchema>;

export const goalPlanV3Schema = z.object({
  version: z.literal(3),
  title: z.string().trim().min(1).max(120),
  aspectRatio: z.enum(["16:9", "9:16", "1:1"]),
  scene: z.object({
    prompt: z.string().trim().min(1).max(4000),
    tool: z.literal("generate_image"),
    model: z.enum(SCENE_MODELS),
    aspectRatio: z.enum(["16:9", "9:16", "1:1"]),
    resolution: z.enum(SCENE_RESOLUTIONS),
    outputFormat: z.enum(SCENE_OUTPUT_FORMATS),
    imageRefs: z.array(goalMediaRefSchema).max(IMAGE_LIMIT),
  }).strict(),
  video: z.object({
    prompt: z.string().trim().min(1).max(4000),
    tool: z.literal("generate_video"),
    model: z.enum(VIDEO_MODELS),
    aspectRatio: z.enum(["16:9", "9:16", "1:1", "adaptive"]),
    resolution: z.enum(VIDEO_RESOLUTIONS),
    durationSeconds: z.number().int().min(4).max(30),
    generateAudio: z.literal(true),
    outputFormat: z.enum(VIDEO_OUTPUT_FORMATS),
    imageRefs: z.array(goalMediaRefSchema).max(IMAGE_LIMIT),
    videoRefs: z.array(goalMediaRefSchema).max(VIDEO_LIMIT),
  }).strict(),
  references: z.array(goalMediaRefSchema).min(1),
  sampledFrames: z.array(z.object({
    artifactId: z.string().min(1),
    objectHash: z.string().min(1),
    seconds: z.number().nonnegative(),
  }).strict()),
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
}).strict();

function withLegacySceneResolution(plan: unknown): unknown {
  if (typeof plan !== "object" || plan === null || !("version" in plan) || plan.version !== 3) return plan;
  if (!("scene" in plan) || typeof plan.scene !== "object" || plan.scene === null || "resolution" in plan.scene) return plan;
  return { ...plan, scene: { ...plan.scene, resolution: LEGACY_SCENE_RESOLUTION } };
}

export const savedGoalPlanV3Schema = z.preprocess(withLegacySceneResolution, goalPlanV3Schema);

export type GoalPlanV3 = z.infer<typeof goalPlanV3Schema>;

export function isGoalPlanV3(plan: { version?: unknown } | null | undefined): plan is GoalPlanV3 {
  return plan?.version === 3;
}

export type GoalAspectRatio = GoalPlanV3["aspectRatio"];

export type GoalSceneFrame = {
  reference: Omit<GoalMediaRef, "slot">;
  seconds: number;
  aspectRatio: GoalAspectRatio;
};

export function closestGoalAspectRatio(width: number, height: number): GoalAspectRatio {
  const ratio = Math.log(width / height);
  const candidates: [GoalAspectRatio, number][] = [["16:9", 16 / 9], ["9:16", 9 / 16], ["1:1", 1]];
  return candidates.reduce((best, candidate) =>
    Math.abs(ratio - Math.log(candidate[1])) < Math.abs(ratio - Math.log(best[1])) ? candidate : best)[0];
}

function goalV3Timing(brief: string, fallbackAspectRatio: GoalAspectRatio = LIGHTNING_SCENE_ASPECT_RATIO): { aspectRatio: GoalAspectRatio; durationSeconds: number } {
  const aspectRatio = /\b(?:9:16|portrait|vertical)\b/iu.test(brief) ? "9:16"
    : /\b(?:1:1|square)\b/iu.test(brief) ? "1:1"
      : /\b(?:16:9|landscape|horizontal)\b/iu.test(brief) ? "16:9"
        : fallbackAspectRatio;
  const match = /(?:^|\s)(\d+)[ -]*(?:s|secs?|seconds?)\b/iu.exec(brief);
  const parsed = match ? Number(match[1]) : Number.NaN;
  const durationSeconds = Number.isInteger(parsed) && parsed >= 4 && parsed <= 30
    ? parsed
    : LIGHTNING_VIDEO_DURATION_SECONDS;
  return { aspectRatio, durationSeconds };
}

function briefProse(brief: string): string {
  return brief.replace(/@[a-z0-9]+/giu, " ").replace(/\s+/gu, " ").trim();
}

function quoted(brief: string, label: string): string | null {
  const specific = new RegExp(`(?:^|\\s)${label}\\s*:\\s*["“]([^"”]+)["”]`, "iu").exec(brief);
  return specific?.[1]?.trim() || null;
}

function authoredCopy(brief: string): { scene: string | null; video: string | null } {
  const generic = /["“]([^"”]+)["”]/u.exec(brief)?.[1]?.trim() || null;
  return {
    scene: quoted(brief, "scene") ?? quoted(brief, "image") ?? generic,
    video: quoted(brief, "video") ?? quoted(brief, "clip") ?? generic,
  };
}

function limitedWords(value: string, maxWords: number, authored: boolean): string {
  if (authored) return preservedPrompt(value, maxWords, true);
  if (maxWords < 1) return "";
  return preservedPrompt(value, maxWords, false);
}

function promptWithSlots(body: string, slots: readonly string[], maxWords: number, authored: boolean): string {
  const kept = limitedWords(body, authored ? maxWords : Math.max(0, maxWords - slots.length), authored);
  const prompt = [kept, ...slots].filter(part => part.length > 0).join(" ").trim();
  if (!authored && goalPromptWords(prompt) > maxWords) {
    return [...slots].join(" ");
  }
  return prompt.length > 0 ? prompt : slots.join(" ");
}

function framePrompt(body: string, characterSlots: readonly string[], authored: boolean): string {
  const instruction = characterSlots.length > 0
    ? `Place ${characterSlots.join(" and ")} into @image1, keeping its framing, setting and light.`
    : "Edit @image1, keeping its framing, setting and light.";
  const kept = limitedWords(body, LIGHTNING_SCENE_PROMPT_WORDS - goalPromptWords(instruction), authored);
  return [instruction, kept].filter(part => part.length > 0).join(" ");
}

function sceneImageRefs(images: readonly GoalMediaRef[], frame: GoalSceneFrame | null): GoalMediaRef[] {
  if (!frame) return images.slice(0, IMAGE_LIMIT);
  return [frame.reference, ...images].slice(0, IMAGE_LIMIT).map((reference, index) => ({ ...reference, slot: `@image${index + 1}` }));
}

function titleFrom(body: string): string {
  const title = body.split(/\s+/u).filter(Boolean).slice(0, 6).join(" ").slice(0, 80).trim();
  return title.length > 0 ? title : "Video";
}

function assignSlots(references: readonly Omit<GoalMediaRef, "slot">[]): GoalMediaRef[] {
  let images = 0;
  let videos = 0;
  return references.map(reference => {
    const slot = reference.kind === "video" ? `@video${++videos}` : `@image${++images}`;
    return { ...reference, slot };
  });
}

export function buildGoalPlanV3(input: {
  brief: string;
  references: readonly Omit<GoalMediaRef, "slot">[];
  frame: GoalSceneFrame | null;
}): GoalPlanV3 {
  const references = assignSlots(input.references);
  const images = references.filter(reference => reference.kind === "image");
  const videos = references.filter(reference => reference.kind === "video");
  const timing = goalV3Timing(input.brief, input.frame?.aspectRatio);
  const copy = authoredCopy(input.brief);
  const prose = briefProse(input.brief);
  const sceneBody = copy.scene ?? prose;
  const videoBody = copy.video ?? prose;
  const sceneRefs = sceneImageRefs(images, input.frame);
  const videoSlots = [...images.slice(0, IMAGE_LIMIT), ...videos.slice(0, VIDEO_LIMIT)].map(reference => reference.slot);
  const scenePrompt = input.frame
    ? framePrompt(sceneBody, sceneRefs.slice(1).map(reference => reference.slot), copy.scene !== null)
    : promptWithSlots(sceneBody, sceneRefs.map(reference => reference.slot), LIGHTNING_SCENE_PROMPT_WORDS, copy.scene !== null);
  const videoPrompt = promptWithSlots(videoBody, videoSlots, LIGHTNING_VIDEO_PROMPT_WORDS, copy.video !== null);
  const profile = LIGHTNING_WATERMARK_PROFILE;
  return goalPlanV3Schema.parse({
    version: 3,
    title: titleFrom(sceneBody || videoBody),
    aspectRatio: timing.aspectRatio,
    scene: {
      prompt: scenePrompt,
      tool: "generate_image",
      model: LIGHTNING_SCENE_MODEL,
      aspectRatio: timing.aspectRatio,
      resolution: LIGHTNING_SCENE_RESOLUTION,
      outputFormat: LIGHTNING_SCENE_OUTPUT_FORMAT,
      imageRefs: sceneRefs,
    },
    video: {
      prompt: videoPrompt,
      tool: "generate_video",
      model: LIGHTNING_VIDEO_MODEL,
      aspectRatio: timing.aspectRatio,
      resolution: LIGHTNING_VIDEO_RESOLUTION,
      durationSeconds: timing.durationSeconds,
      generateAudio: LIGHTNING_VIDEO_GENERATE_AUDIO,
      outputFormat: LIGHTNING_VIDEO_OUTPUT_FORMAT,
      imageRefs: images.slice(0, IMAGE_LIMIT),
      videoRefs: videos.slice(0, VIDEO_LIMIT),
    },
    references,
    sampledFrames: input.frame
      ? [{ artifactId: input.frame.reference.artifactId, objectHash: input.frame.reference.objectHash, seconds: input.frame.seconds }]
      : [],
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

function liveAddress(document: NotebookDocument, reference: GoalMediaRef): GoalMediaRef {
  const cell = document.cells.find(candidate => candidate.id === reference.cellId);
  return cell ? { ...reference, address: notebookGridTag(cell.slot) } : reference;
}

export function refreshGoalPlanV3(plan: GoalPlanV3, document: NotebookDocument): GoalPlanV3 {
  const map = (reference: GoalMediaRef) => liveAddress(document, reference);
  return {
    ...plan,
    references: plan.references.map(map),
    scene: { ...plan.scene, imageRefs: plan.scene.imageRefs.map(map) },
    video: {
      ...plan.video,
      imageRefs: plan.video.imageRefs.map(map),
      videoRefs: plan.video.videoRefs.map(map),
    },
  };
}

function refList(params: Record<string, unknown>, role: "image" | "video"): string[] {
  const refs = params.refs as Record<string, unknown> | undefined;
  const list = refs?.[role];
  return Array.isArray(list) ? list.filter((entry): entry is string => typeof entry === "string") : [];
}

function withRefs(params: Record<string, unknown>, images: readonly string[], videos: readonly string[]): Record<string, unknown> {
  const refs = {
    ...(images.length > 0 ? { image: [...images] } : {}),
    ...(videos.length > 0 ? { video: [...videos] } : {}),
  };
  const { refs: _previous, mode: _mode, ...rest } = params;
  return Object.keys(refs).length > 0 ? { ...rest, refs, ...(params.mode ? { mode: params.mode } : {}) } : rest;
}

export function compileGoalV3Approval(plan: GoalPlanV3, stage: "frame" | "videos", sceneAddress?: string): ChainStep {
  const [scene, video] = compileGoalV3Steps(plan);
  if (stage === "frame") return { ...scene!, params: withRefs(scene!.params, refList(scene!.params, "image"), []) };
  const imageRefs = [...new Set([...(sceneAddress ? [sceneAddress] : []), ...refList(video!.params, "image")])];
  return { ...video!, params: withRefs(video!.params, imageRefs, refList(video!.params, "video")) };
}

export function compileGoalV3Steps(plan: GoalPlanV3): ChainStep[] {
  const sceneRefs = plan.scene.imageRefs.slice(0, IMAGE_LIMIT);
  const videoImages = plan.video.imageRefs.slice(0, IMAGE_LIMIT);
  const videoRefs = plan.video.videoRefs.slice(0, VIDEO_LIMIT);
  return [
    {
      id: "scene",
      tool: plan.scene.tool,
      params: {
        model: plan.scene.model,
        prompt: plan.scene.prompt,
        refs: { image: sceneRefs.map(reference => reference.address) },
        options: {
          aspect_ratio: plan.scene.aspectRatio,
          resolution: plan.scene.resolution,
          output_format: plan.scene.outputFormat,
        },
      },
    },
    {
      id: "video",
      tool: plan.video.tool,
      params: {
        model: plan.video.model,
        prompt: plan.video.prompt,
        refs: {
          image: videoImages.map(reference => reference.address),
          video: videoRefs.map(reference => reference.address),
        },
        ...(videoImages.length + videoRefs.length > 0 ? { mode: "r2v" } : {}),
        options: {
          aspect_ratio: plan.video.aspectRatio,
          resolution: plan.video.resolution,
          duration: plan.video.durationSeconds,
          generate_audio: plan.video.generateAudio,
          output_format: plan.video.outputFormat,
        },
      },
    },
  ];
}
