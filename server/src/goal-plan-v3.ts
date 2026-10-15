import { z } from "zod";
import type { NotebookDocument } from "videobook-engine";
import { notebookGridTag } from "videobook-engine/notebook-grid";
import type { ChainStep } from "./chain-plan.js";
import { goalPromptWords } from "./goal-prompt-budget.js";
import {
  LIGHTNING_COLD_OPEN_SECONDS,
  LIGHTNING_SCENE_ASPECT_RATIO,
  LIGHTNING_SCENE_MODEL_KEY,
  LIGHTNING_SCENE_OUTPUT_FORMAT,
  LIGHTNING_SCENE_PROMPT_WORDS,
  LIGHTNING_SCENE_RESOLUTION,
  LIGHTNING_SCENE_TOOL,
  LIGHTNING_VIDEO_ASPECT_RATIO,
  LIGHTNING_VIDEO_DURATION_SECONDS,
  LIGHTNING_VIDEO_GENERATE_AUDIO,
  LIGHTNING_VIDEO_OUTPUT_FORMAT,
  LIGHTNING_VIDEO_PROMPT_WORDS,
  LIGHTNING_VIDEO_RESOLUTION,
  LIGHTNING_VIDEO_TOOL,
  LIGHTNING_WATERMARK_PROFILE,
  preservedPrompt,
} from "./lightning-defaults.js";

const IMAGE_LIMIT = 30;
const VIDEO_LIMIT = 10;

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
    tool: z.literal(LIGHTNING_SCENE_TOOL),
    model: z.literal(LIGHTNING_SCENE_MODEL_KEY),
    aspectRatio: z.enum(["16:9", "9:16", "1:1"]),
    resolution: z.literal(LIGHTNING_SCENE_RESOLUTION),
    outputFormat: z.literal(LIGHTNING_SCENE_OUTPUT_FORMAT),
    imageRefs: z.array(goalMediaRefSchema).max(IMAGE_LIMIT),
  }).strict(),
  video: z.object({
    prompt: z.string().trim().min(1).max(4000),
    tool: z.literal(LIGHTNING_VIDEO_TOOL),
    aspectRatio: z.enum(["16:9", "9:16", "1:1", "adaptive"]),
    resolution: z.literal(LIGHTNING_VIDEO_RESOLUTION),
    durationSeconds: z.number().int().min(4).max(30),
    generateAudio: z.literal(true),
    outputFormat: z.literal(LIGHTNING_VIDEO_OUTPUT_FORMAT),
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

export type GoalPlanV3 = z.infer<typeof goalPlanV3Schema>;

export function isGoalPlanV3(plan: { version?: unknown } | null | undefined): plan is GoalPlanV3 {
  return plan?.version === 3;
}

export function goalV3Timing(brief: string): { aspectRatio: GoalPlanV3["aspectRatio"]; durationSeconds: number } {
  const aspectRatio = /\b(?:9:16|portrait|vertical)\b/iu.test(brief) ? "9:16"
    : /\b(?:1:1|square)\b/iu.test(brief) ? "1:1"
      : LIGHTNING_SCENE_ASPECT_RATIO;
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
  sampledFrames: GoalPlanV3["sampledFrames"];
}): GoalPlanV3 {
  const references = assignSlots(input.references);
  const images = references.filter(reference => reference.kind === "image");
  const videos = references.filter(reference => reference.kind === "video");
  const timing = goalV3Timing(input.brief);
  const copy = authoredCopy(input.brief);
  const prose = briefProse(input.brief);
  const sceneBody = copy.scene ?? prose;
  const videoBody = copy.video ?? prose;
  const sceneSlots = images.slice(0, IMAGE_LIMIT).map(reference => reference.slot);
  const videoSlots = [...images.slice(0, IMAGE_LIMIT), ...videos.slice(0, VIDEO_LIMIT)].map(reference => reference.slot);
  const scenePrompt = promptWithSlots(sceneBody, sceneSlots, LIGHTNING_SCENE_PROMPT_WORDS, copy.scene !== null);
  const videoPrompt = promptWithSlots(videoBody, videoSlots, LIGHTNING_VIDEO_PROMPT_WORDS, copy.video !== null);
  const profile = LIGHTNING_WATERMARK_PROFILE;
  return goalPlanV3Schema.parse({
    version: 3,
    title: titleFrom(sceneBody || videoBody),
    aspectRatio: timing.aspectRatio,
    scene: {
      prompt: scenePrompt,
      tool: LIGHTNING_SCENE_TOOL,
      model: LIGHTNING_SCENE_MODEL_KEY,
      aspectRatio: timing.aspectRatio,
      resolution: LIGHTNING_SCENE_RESOLUTION,
      outputFormat: LIGHTNING_SCENE_OUTPUT_FORMAT,
      imageRefs: images.slice(0, IMAGE_LIMIT),
    },
    video: {
      prompt: videoPrompt,
      tool: LIGHTNING_VIDEO_TOOL,
      aspectRatio: timing.aspectRatio === LIGHTNING_VIDEO_ASPECT_RATIO ? LIGHTNING_VIDEO_ASPECT_RATIO : timing.aspectRatio,
      resolution: LIGHTNING_VIDEO_RESOLUTION,
      durationSeconds: timing.durationSeconds,
      generateAudio: LIGHTNING_VIDEO_GENERATE_AUDIO,
      outputFormat: LIGHTNING_VIDEO_OUTPUT_FORMAT,
      imageRefs: images.slice(0, IMAGE_LIMIT),
      videoRefs: videos.slice(0, VIDEO_LIMIT),
    },
    references,
    sampledFrames: input.sampledFrames,
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

function omitEmptyRefs(params: Record<string, unknown>): Record<string, unknown> {
  const next = { ...params };
  for (const key of ["image_refs", "video_refs"]) {
    if (Array.isArray(next[key]) && next[key].length === 0) delete next[key];
  }
  return next;
}

export function compileGoalV3Approval(plan: GoalPlanV3, stage: "frame" | "videos", sceneAddress?: string): ChainStep {
  const [scene, video] = compileGoalV3Steps(plan);
  if (stage === "frame") return { ...scene!, params: omitEmptyRefs(scene!.params) };
  const imageRefs = [
    ...(sceneAddress ? [sceneAddress] : []),
    ...((Array.isArray(video!.params.image_refs) ? video!.params.image_refs : []) as string[]),
  ];
  return {
    ...video!,
    params: omitEmptyRefs({
      ...video!.params,
      ...(imageRefs.length > 0 ? { image_refs: [...new Set(imageRefs)] } : {}),
    }),
  };
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
        prompt: plan.scene.prompt,
        image_refs: sceneRefs.map(reference => reference.address),
        aspect_ratio: plan.scene.aspectRatio,
        resolution: plan.scene.resolution,
        output_format: plan.scene.outputFormat,
      },
    },
    {
      id: "video",
      tool: plan.video.tool,
      params: {
        prompt: plan.video.prompt,
        image_refs: videoImages.map(reference => reference.address),
        video_refs: videoRefs.map(reference => reference.address),
        aspect_ratio: plan.video.aspectRatio,
        resolution: plan.video.resolution,
        duration: String(plan.video.durationSeconds),
        generate_audio: plan.video.generateAudio,
        output_format: plan.video.outputFormat,
      },
    },
  ];
}
