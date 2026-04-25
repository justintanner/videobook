import type { ClipfirstFs } from "clipfirst-fs";
import { z, type ZodRawShape } from "zod";
import type { SchemaArgs, ToolDef, ToolResult } from "./tool-def.js";
import { generateNanoBananaProEditFalDef } from "./generate-nano-banana-pro-edit-fal.js";
import { generateQwenImageEditFalDef } from "./generate-qwen-image-edit-fal.js";
import { generateWan27ProEditFalDef } from "./generate-wan27-pro-edit-fal.js";
import { generateSeedreamV5LiteEditFalDef } from "./generate-seedream-v5-lite-edit-fal.js";
import { generateNanoBananaImageDef } from "./generate-nano-banana-image.js";
import { generateQwen2ImageEditDef } from "./generate-qwen2-image-edit.js";
import { generateGptImageDef } from "./generate-gpt-image.js";
import { generateWan27ImageProDef } from "./generate-wan27-image-pro.js";
import { generateSeedreamImageDef } from "./generate-seedream-image.js";
import { platformGuidance, type Platform } from "../platform-guidance.js";
import { uploadBytesToFal } from "../jobs/_fal-upload.js";
import { uploadBytesToKie } from "../jobs/_kie-upload.js";
import {
  describeImageBytes,
  mimeForImageFilename,
  ANALYSIS_FILENAME,
  type DescribeImageResult,
} from "../jobs/describe-image.js";
import { findImageFile } from "./_image-inputs.js";
import { CHARACTER_METADATA_KEY, type Character } from "../jobs/extract-character.js";

const CUSTOM_PROMPT_MAX = 500;
const POSE_DESCRIPTION_MAX = 1500;
const POSE_SHOT_MAX = 80;
const PLATFORMS = ["ig", "tiktok", "youtube"] as const;

// Negative-prompt fragments, scoped so each model picks what's applicable.
// Wan 2.7 Pro and Qwen Image Edit (on fal) expose a native `negative_prompt`
// field; on kie they bake the combined string into the main prompt via
// `avoidClause()`. Nano Banana Pro and Seedream V5 Lite get NO negative text
// (Nano Banana's L2 safety filter trips on "Avoid:"-style clauses; Seedream's
// official guide says *don't* use preemptive negatives). GPT Image 2 embeds
// exclusions inline in the Task clause rather than as a separate "Avoid:".
const ANATOMY_NEGATIVE =
  "deformed hands, malformed fingers, extra or missing fingers, fused fingers, " +
  "unnatural hand pose, extra limbs, missing limbs, unnatural arm angles, " +
  "twisted joints, bad anatomy, bad proportions, contorted pose";
const SKIN_NEGATIVE =
  "smooth plastic skin, airbrushed, doll-like, waxy, over-retouched";
const QUALITY_NEGATIVE =
  "low quality, blurry, jpeg artifacts, watermark, text, distorted face, uncanny eyes";

// Combined negative used for Wan + Qwen. Kept under Wan's 500-char cap so it
// can be passed as-is to the fal `negative_prompt` field.
export const WAN_QWEN_NEGATIVE =
  `${ANATOMY_NEGATIVE}, ${SKIN_NEGATIVE}, ${QUALITY_NEGATIVE}`;

// Positive anchors appended to every per-model prompt. Replaces the old
// "Avoid:" list approach — most models respond better to positive framing,
// and for the ones that need a negative we route it explicitly above.
const ANATOMY_ANCHOR =
  "Arms relaxed naturally, hands fully visible with five distinct fingers, " +
  "natural shoulder and wrist rotation, weight-shifted standing pose.";
const SKIN_ANCHOR =
  "Natural skin with visible pore texture and subtle subsurface scattering, " +
  "asymmetric micro-highlights, editorial magazine finish, no beauty filter.";
const IDENTITY_ANCHOR =
  "Preserve identity, body proportions and geometry from the subject reference.";

export const SUPPORTED_OUTFIT_MODELS = [
  "nano_banana_pro",
  "qwen_image_edit",
  "gpt_image_2",
  "wan27_pro",
  "seedream_v5_lite",
] as const;
export type OutfitModelKey = typeof SUPPORTED_OUTFIT_MODELS[number];

export const OUTFIT_PROVIDERS = ["kie", "fal"] as const;
export type OutfitProvider = typeof OUTFIT_PROVIDERS[number];

export const OUTFIT_ASPECT_RATIOS = ["9:16", "16:9", "1:1"] as const;
export type OutfitAspectRatio = typeof OUTFIT_ASPECT_RATIOS[number];

export const OUTFIT_POSE_COVERAGE = ["face", "upper", "full"] as const;
export type OutfitPoseCoverage = typeof OUTFIT_POSE_COVERAGE[number];

const IMAGE_SIZE_MAP: Record<OutfitAspectRatio, "portrait_16_9" | "landscape_16_9" | "square_hd"> = {
  "9:16": "portrait_16_9",
  "16:9": "landscape_16_9",
  "1:1": "square_hd",
};

function resolveSizeArgs(
  provider: OutfitProvider,
  model: OutfitModelKey,
  ratio: OutfitAspectRatio | undefined,
): Record<string, string> {
  if (!ratio) return {};
  if (provider === "kie" && model !== "qwen_image_edit") return { aspect_ratio: ratio };
  if (model === "qwen_image_edit") return { image_size: ratio };
  if (provider === "fal" && model === "nano_banana_pro") return { aspect_ratio: ratio };
  if (provider === "fal" && model === "wan27_pro") return { image_size: IMAGE_SIZE_MAP[ratio] };
  if (provider === "fal" && model === "seedream_v5_lite") return { image_size: IMAGE_SIZE_MAP[ratio] };
  return {};
}

const schema = {
  project_slug: z.string().describe("Project slug"),
  model_image_slug: z.string().describe("@img-* slug of the person/model photo (Image 1)"),
  garment_image_slug: z.string().describe("@img-* slug of the garment/clothing (Image 2)"),
  pose_image_slug: z
    .string()
    .optional()
    .describe("@img-* slug of the pose reference (Image 3). Provide this OR pose_image_data."),
  pose_image_data: z
    .string()
    .optional()
    .describe(
      "Base64-encoded bytes of the pose skeleton PNG. Ephemeral — uploaded once to the provider " +
      "and discarded, never persisted as a project asset. Provide this OR pose_image_slug.",
    ),
  pose_filename: z
    .string()
    .optional()
    .describe("Filename for the ephemeral pose bytes (extension determines content type). Required with pose_image_data."),
  pose_description: z
    .string()
    .max(POSE_DESCRIPTION_MAX)
    .optional()
    .describe(
      "Body-geometry pose description (weight, stance, hip/torso/shoulder/head rotation, limb " +
      "positions). Injected as the 'intended pose depicts' clause in each model's prompt so the " +
      "image model gets pose semantics the skeleton landmarks alone can't convey. Callers should " +
      "source this from the pose-source image's `.original.analysis.json` `pose` field.",
    ),
  pose_shot: z
    .string()
    .max(POSE_SHOT_MAX)
    .optional()
    .describe(
      "Shot size + camera angle of the pose source image in standard cinematography terms " +
      "(e.g. 'medium close-up, eye-level'). Sourced from the pose-source image's " +
      "`.original.analysis.json` `shot` field. Injected as the framing directive in each " +
      "model's prompt so output framing matches the pose reference.",
    ),
  backdrop_image_slug: z
    .string()
    .optional()
    .describe("@img-* slug of the backdrop/scene reference (Image 4, optional)"),
  models: z
    .array(z.enum(SUPPORTED_OUTFIT_MODELS))
    .min(1)
    .describe("Image edit models to run. One job enqueued per model."),
  provider: z
    .enum(OUTFIT_PROVIDERS)
    .optional()
    .describe("Image-edit provider (kie | fal). Defaults to kie."),
  custom_prompt: z
    .string()
    .max(CUSTOM_PROMPT_MAX)
    .optional()
    .describe("Optional free-form instruction appended to the outfit prompt"),
  platform: z
    .enum(PLATFORMS)
    .optional()
    .describe("Optional platform aesthetic preset (ig | tiktok | youtube)"),
  aspect_ratio: z
    .enum(OUTFIT_ASPECT_RATIOS)
    .optional()
    .describe("Output aspect ratio (9:16 | 16:9 | 1:1). Mapped per model."),
  pose_coverage: z
    .enum(OUTFIT_POSE_COVERAGE)
    .optional()
    .describe(
      "How much of the body the pose reference covers (face | upper | full). " +
      "Detected client-side from MediaPipe pose landmarks. When 'face' or 'upper', " +
      "the prompt swaps the 'align to pose reference' clause for an explicit textual " +
      "stance directive so the model doesn't freestyle the body. Defaults to 'full'.",
    ),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof schema>;

type ToolDefFactory = (fs: ClipfirstFs) => { handler: (args: Record<string, unknown>) => Promise<ToolResult> };

const DISPATCH: Record<OutfitProvider, Partial<Record<OutfitModelKey, ToolDefFactory>>> = {
  kie: {
    nano_banana_pro: generateNanoBananaImageDef,
    qwen_image_edit: generateQwen2ImageEditDef,
    gpt_image_2: generateGptImageDef,
    wan27_pro: generateWan27ImageProDef,
    seedream_v5_lite: generateSeedreamImageDef,
  },
  fal: {
    nano_banana_pro: generateNanoBananaProEditFalDef,
    qwen_image_edit: generateQwenImageEditFalDef,
    wan27_pro: generateWan27ProEditFalDef,
    seedream_v5_lite: generateSeedreamV5LiteEditFalDef,
  },
};

interface EnqueueOutcome {
  model: OutfitModelKey;
  provider: OutfitProvider;
  prompt: string;
  image_count: number;
  backdrop_mentioned?: boolean;
  img_asset_id?: string;
  job_id?: string;
  error?: string;
}

function extractEnqueueResult(res: ToolResult): { assetId?: string; jobId?: string; error?: string } {
  if (res.isError) {
    const content = res.content as Array<{ type: string; text: string }>;
    return { error: content[0]?.text ?? "enqueue failed" };
  }
  const content = res.content as Array<{ type: string; text: string }>;
  try {
    const parsed = JSON.parse(content[0].text) as { img_asset_id?: string; job_id?: string };
    return { assetId: parsed.img_asset_id, jobId: parsed.job_id };
  } catch {
    return { error: "could not parse enqueue response" };
  }
}

function withAt(slug: string): string {
  if (slug.startsWith("http://") || slug.startsWith("https://")) return slug;
  return slug.startsWith("@") ? slug : `@${slug}`;
}

function platformSection(platform: Platform | undefined): string {
  return platform
    ? `\n\n--- PLATFORM AESTHETIC ---\n${platformGuidance(platform)}\n--- END PLATFORM AESTHETIC ---`
    : "";
}

function customSection(custom: string | undefined): string {
  const t = custom?.trim();
  return t ? ` ${t}` : "";
}

// Appended only for models where a separate "Avoid:" clause is known to help:
// Wan 2.7 on kie and Qwen Image Edit on kie. On fal they use the native
// negative_prompt field. NBPro, Seedream and GPT Image 2 never receive this.
function kieAvoidClause(): string {
  return ` Avoid: ${WAN_QWEN_NEGATIVE}.`;
}

// Explicit textual stance directive for when the pose reference doesn't
// carry full-body structure. Without this the image model has no cue for
// the body below what the reference shows and produces awkward / lying /
// crouched stances when the reference is a headshot.
const CONTRAPPOSTO_STANCE =
  "a relaxed contrapposto standing pose: weight on the back leg, " +
  "arms falling naturally at the sides, shoulders squared to camera";

// Appended right after each model's pose clause when a vision description
// of the original pose photo is available. The image model only sees the
// skeleton — this sentence gives it the semantic intent of the pose
// (gesture, gaze, weight distribution) that pure landmark geometry loses.
function poseDescriptionSentence(description: string | undefined): string {
  if (!description) return "";
  return ` The intended pose depicts: ${description}`;
}

// Output framing directive — comes from the pose source's vision-extracted
// `shot` field (size + angle in cinematography terms, e.g. "medium close-up,
// eye-level"). Empty when no shot is available; placed at the end of each
// model's prompt in its own voice so it overrides the model's default
// editorial-fashion framing instead of competing with it.
function shotForModel(shot: string | undefined, model: OutfitModelKey): string {
  if (!shot) return "";
  switch (model) {
    case "nano_banana_pro": return ` Frame as a ${shot} shot.`;
    case "qwen_image_edit": return ` Frame the result as ${shot}.`;
    case "gpt_image_2":     return ` Framing: ${shot}.`;
    case "seedream_v5_lite": return ` Framed as ${shot}.`;
    case "wan27_pro":       return ` Framing: ${shot}.`;
  }
}

// Per-model pose clause, keyed by coverage + the label the model uses for
// the pose slot. Each model's surrounding prose is different enough that
// sharing full sentences would read stilted — we keep the builder-local
// voice and only swap the pose-reference clause.
function nbProPoseClause(coverage: OutfitPoseCoverage): string {
  switch (coverage) {
    case "full":
      return "Reference Image 3 is the pose — align limb angles, torso rotation and head tilt exactly.";
    case "upper":
      return "Reference Image 3 shows head, shoulders and torso — follow its head tilt, shoulder angle and torso rotation. For the legs and stance, use a relaxed standing pose with weight on the back leg.";
    case "face":
      return `Reference Image 3 is a head-and-shoulders pose reference — use it for head tilt, gaze and shoulder angle only. For the body, adopt ${CONTRAPPOSTO_STANCE}.`;
  }
}

function qwenPoseClause(coverage: OutfitPoseCoverage): string {
  switch (coverage) {
    case "full":
      return "adopts the exact pose shown in image 3";
    case "upper":
      return "takes head tilt, shoulder angle and torso rotation from image 3, with legs in a relaxed standing stance and weight on the back leg";
    case "face":
      return `takes head tilt, gaze and shoulder angle from the head-and-shoulders reference in image 3, with the body in ${CONTRAPPOSTO_STANCE}`;
  }
}

function qwenPoseAlignLine(coverage: OutfitPoseCoverage): string {
  switch (coverage) {
    case "full":
      return "Align limb angles, torso rotation and head tilt precisely to the pose in image 3.";
    case "upper":
      return "Match the head, shoulders and torso of image 3 precisely; keep the legs in a natural standing stance.";
    case "face":
      return "Match the head tilt, gaze and shoulder angle of image 3 precisely.";
  }
}

function gptPoseClause(coverage: OutfitPoseCoverage): string {
  switch (coverage) {
    case "full":
      return "pose them exactly as shown in Image 3";
    case "upper":
      return "pose the head, shoulders and torso exactly as shown in Image 3, with legs in a relaxed standing stance and weight on the back leg";
    case "face":
      return `take head tilt, gaze and shoulder angle from Image 3 (head and shoulders only), with the body in ${CONTRAPPOSTO_STANCE}`;
  }
}

function gptPoseAlignLine(coverage: OutfitPoseCoverage): string {
  switch (coverage) {
    case "full":
      return "Align limbs, torso and head to the pose in Image 3.";
    case "upper":
      return "Align head, shoulders and torso to Image 3.";
    case "face":
      return "Align head tilt, gaze and shoulder angle to Image 3.";
  }
}

function wanPoseClause(coverage: OutfitPoseCoverage): string {
  switch (coverage) {
    case "full":
      return "pose them to match the pose (Image 3)";
    case "upper":
      return "match their head, shoulders and torso to Image 3, with legs in a relaxed standing stance";
    case "face":
      return `take head tilt, gaze and shoulder angle from Image 3 (head and shoulders only), with the body in ${CONTRAPPOSTO_STANCE}`;
  }
}

function seedreamPoseClause(coverage: OutfitPoseCoverage): string {
  switch (coverage) {
    case "full":
      return "in the pose shown in the third reference — aligning limb angles, torso rotation and head tilt";
    case "upper":
      return "with head tilt, shoulder angle and torso rotation matching the third reference, and the legs in a relaxed standing stance with weight on the back leg";
    case "face":
      return `taking head tilt, gaze and shoulder angle from the third reference, with the body in ${CONTRAPPOSTO_STANCE}`;
  }
}

/**
 * Per-model prompt builders. Each model has its own preferred multi-image
 * reference convention and safety/quality quirks — see the research plan for
 * the sources behind each choice.
 */

// Nano Banana Pro — "professional fashion photography" framing bypasses most
// L2 safety-filter false positives on clothing swaps. Strips the tokens that
// trip the deepfake filter ("keep face", "change into", "change pose",
// "photorealistic"). No Avoid clause — that itself can trigger the filter.
function promptForNanoBananaPro(
  hasBackdrop: boolean,
  platform: Platform | undefined,
  custom: string | undefined,
  backdropDescription: string | undefined,
  poseDescription: string | undefined,
  coverage: OutfitPoseCoverage,
  shot: string | undefined,
): string {
  const backdropClause = backdropDescription
    ? `Place the subject in this location: ${backdropDescription} Match the lighting, depth and colour cast of that scene.`
    : hasBackdrop
    ? "Place the subject in the location described by the user's backdrop reference, matching its lighting, depth and colour cast."
    : "Use a tasteful background that suits the subject, rendered with natural lighting.";
  const base =
    "Professional fashion photography. " +
    "Reference Image 1 establishes the model's appearance, hair and skin. " +
    "Reference Image 2 is the outfit — match its cut, colour, pattern and silhouette. " +
    `${nbProPoseClause(coverage)}${poseDescriptionSentence(poseDescription)} ` +
    `${backdropClause} ` +
    `${ANATOMY_ANCHOR} ${SKIN_ANCHOR} ${IDENTITY_ANCHOR} ` +
    "85mm lens, soft natural lighting, fashion magazine style." +
    shotForModel(shot, "nano_banana_pro");
  return `${base}${platformSection(platform)}${customSection(custom)}`;
}

// Qwen Image Edit — lowercase "image 1 / image 2 / image 3", hard cap 3.
// Like every model in this dispatcher, it receives a vision-described
// backdrop in `backdropDescription` (the universal 3-image layout means no
// model ever sees the backdrop as an input slot). On fal the caller also
// sends WAN_QWEN_NEGATIVE via the native field; on kie the Avoid clause is
// baked in here.
function promptForQwenImageEdit(
  hasBackdrop: boolean,
  platform: Platform | undefined,
  custom: string | undefined,
  backdropDescription: string | undefined,
  poseDescription: string | undefined,
  provider: OutfitProvider,
  coverage: OutfitPoseCoverage,
  shot: string | undefined,
): string {
  const backdropClause = backdropDescription
    ? ` For the background, compose this scene: ${backdropDescription} Keep lighting and colour cast consistent with that setting.`
    : hasBackdrop
    ? " For the background, compose a scene that matches the user's backdrop description; keep lighting and colour cast consistent with that setting."
    : " Use a tasteful, editorial background with natural lighting.";
  const base =
    `The person in image 1 wears the garment from image 2 and ${qwenPoseClause(coverage)}. ` +
    "Match the cut, colour, pattern and silhouette of the garment in image 2. " +
    qwenPoseAlignLine(coverage) +
    poseDescriptionSentence(poseDescription) +
    backdropClause +
    ` ${ANATOMY_ANCHOR} ${SKIN_ANCHOR} ${IDENTITY_ANCHOR}` +
    shotForModel(shot, "qwen_image_edit");
  const tail = provider === "kie" ? kieAvoidClause() : "";
  return `${base}${tail}${platformSection(platform)}${customSection(custom)}`;
}

// GPT Image 2 — OpenAI-endorsed "Image N: role" labeling. Fix for the
// "deformed mutant body" complaint: concrete anatomy anchors + explicit
// `preserve identity, geometry, and body proportions`. Inline `no ...`
// exclusions rather than a separate Avoid line per the OpenAI cookbook.
function promptForGptImage2(
  hasBackdrop: boolean,
  platform: Platform | undefined,
  custom: string | undefined,
  backdropDescription: string | undefined,
  poseDescription: string | undefined,
  coverage: OutfitPoseCoverage,
  shot: string | undefined,
): string {
  const header = "Image 1: the person/model. Image 2: the garment. Image 3: the pose reference.";
  const sceneClause = backdropDescription
    ? `against this scene: ${backdropDescription} keep lighting and colour cast consistent with that setting`
    : hasBackdrop
    ? "against the scene described by the user's backdrop reference, with lighting and colour cast consistent with that setting"
    : "against an editorial background with natural lighting";
  const task = `Task: dress the person from Image 1 in the garment from Image 2, ${gptPoseClause(coverage)}, ${sceneClause}.`;
  const rules =
    "Preserve identity, geometry, and body proportions from Image 1. Match garment cut, colour and pattern from Image 2 precisely. " +
    `${gptPoseAlignLine(coverage)}${poseDescriptionSentence(poseDescription)} ` +
    `${ANATOMY_ANCHOR} ${SKIN_ANCHOR} ` +
    "Constraints: no watermark, no extra text, no logos, no logo drift, no extra limbs, no deformed hands." +
    shotForModel(shot, "gpt_image_2");
  const base = `${header} ${task} ${rules}`;
  return `${base}${platformSection(platform)}${customSection(custom)}`;
}

// Seedream V5 Lite — positional narrative references, NOT numbered "Figure N"
// labels. Observed failure mode: with "Figure 1 … Figure 2 … Figure 3 … Figure 4"
// the model interpreted the tokens as a render instruction and produced a
// 4-figure turnaround of the same person (front / side / side-back / back)
// instead of a single composited image. Using "the first reference / the
// second reference" etc. avoids the trigger. Negative prompts stay disabled
// (ByteDance guidance: "Don't use negative prompts preemptively").
function promptForSeedreamV5Lite(
  hasBackdrop: boolean,
  platform: Platform | undefined,
  custom: string | undefined,
  backdropDescription: string | undefined,
  poseDescription: string | undefined,
  coverage: OutfitPoseCoverage,
  shot: string | undefined,
): string {
  const backdropClause = backdropDescription
    ? `, in this location: ${backdropDescription}`
    : hasBackdrop
    ? ", in the location described by the user's backdrop reference"
    : ", against a tasteful background with natural lighting";
  const base =
    "Editorial fashion photograph composed from the reference inputs. " +
    `The subject shown in the first reference is wearing the outfit shown in the second reference, ${seedreamPoseClause(coverage)}${backdropClause}.${poseDescriptionSentence(poseDescription)} ` +
    `${ANATOMY_ANCHOR} ${SKIN_ANCHOR} ` +
    "Preserve the subject's face, hairstyle and body proportions from the first reference exactly. " +
    "Preserve the cut, colour and pattern of the outfit from the second reference exactly. " +
    "Render a single photograph of one person, not a multi-view turnaround or figure study." +
    shotForModel(shot, "seedream_v5_lite");
  return `${base}${platformSection(platform)}${customSection(custom)}`;
}

// Wan 2.7 Pro — keep the Change/Keep structure. Describe framing in prose
// (Wan 2.7 removed the shot_type parameter). Do NOT use the word
// "photorealistic" — it triggers 2.6 fallback logic and reduces realism.
// On fal the caller sends WAN_QWEN_NEGATIVE via the native field; on kie the
// Avoid clause is baked in here.
function promptForWan27Pro(
  hasBackdrop: boolean,
  platform: Platform | undefined,
  custom: string | undefined,
  backdropDescription: string | undefined,
  poseDescription: string | undefined,
  provider: OutfitProvider,
  coverage: OutfitPoseCoverage,
  shot: string | undefined,
): string {
  const changeBackdrop = backdropDescription
    ? ` Change the background to: ${backdropDescription} Match lighting and colour cast to that scene.`
    : hasBackdrop
    ? " Change the background to match the scene described by the user's backdrop reference."
    : " Change the background to an editorial fashion-photography setting with natural lighting.";
  const base =
    `Change: dress the person (Image 1) in the garment (Image 2) and ${wanPoseClause(coverage)}.${poseDescriptionSentence(poseDescription)} ` +
    "Keep: the face, hair and skin of the person from Image 1; the cut, colour and pattern of the garment from Image 2." +
    changeBackdrop +
    ` ${ANATOMY_ANCHOR} ${SKIN_ANCHOR} ${IDENTITY_ANCHOR} ` +
    "Editorial fashion photography, 85mm, f/2.8." +
    shotForModel(shot, "wan27_pro");
  const tail = provider === "kie" ? kieAvoidClause() : "";
  return `${base}${tail}${platformSection(platform)}${customSection(custom)}`;
}

function buildPromptForModel(
  model: OutfitModelKey,
  provider: OutfitProvider,
  hasBackdrop: boolean,
  platform: Platform | undefined,
  custom: string | undefined,
  backdropDescription: string | undefined,
  poseDescription: string | undefined,
  coverage: OutfitPoseCoverage,
  shot: string | undefined,
): string {
  switch (model) {
    case "nano_banana_pro":
      return promptForNanoBananaPro(hasBackdrop, platform, custom, backdropDescription, poseDescription, coverage, shot);
    case "qwen_image_edit":
      return promptForQwenImageEdit(hasBackdrop, platform, custom, backdropDescription, poseDescription, provider, coverage, shot);
    case "gpt_image_2":
      return promptForGptImage2(hasBackdrop, platform, custom, backdropDescription, poseDescription, coverage, shot);
    case "wan27_pro":
      return promptForWan27Pro(hasBackdrop, platform, custom, backdropDescription, poseDescription, provider, coverage, shot);
    case "seedream_v5_lite":
      return promptForSeedreamV5Lite(hasBackdrop, platform, custom, backdropDescription, poseDescription, coverage, shot);
  }
}

interface SlugInputs {
  model: string;
  garment: string;
  pose: string;
  backdrop?: string;
}

/**
 * Every model shares a 3-image layout: [model, garment, pose skeleton].
 * The backdrop is never passed as an image slot — when supplied it is
 * described in text via a single shared vision pass. This keeps dispatch
 * uniform and works around Qwen's hard 3-image cap without per-model
 * branching.
 */
function buildImageSlugs(
  _model: OutfitModelKey,
  _provider: OutfitProvider,
  slugs: SlugInputs,
): { image_slugs: string[]; backdropMentioned: boolean } {
  return {
    image_slugs: [slugs.model, slugs.garment, slugs.pose],
    backdropMentioned: !!slugs.backdrop,
  };
}

/** Returns the negative-prompt string for models that show it in the UI —
 * only Wan / Qwen actually consume it (native on fal, baked into prompt on
 * kie). When none of the selected models are Wan or Qwen, returns null so
 * the UI can hide the panel. */
function previewNegativePromptFor(models: readonly OutfitModelKey[]): string | null {
  const relevant = models.some((m) => m === "wan27_pro" || m === "qwen_image_edit");
  return relevant ? WAN_QWEN_NEGATIVE : null;
}

const previewSchema = {
  models: z
    .array(z.enum(SUPPORTED_OUTFIT_MODELS))
    .min(1)
    .describe("Image edit models to preview prompts for."),
  provider: z
    .enum(OUTFIT_PROVIDERS)
    .optional()
    .describe("Image-edit provider (kie | fal). Defaults to kie."),
  has_backdrop: z
    .boolean()
    .optional()
    .describe("Whether a backdrop/scene image is supplied."),
  pose_description: z
    .string()
    .max(POSE_DESCRIPTION_MAX)
    .optional()
    .describe(
      "Pose-source body-geometry text (same shape passed to generate_outfit). Inlined verbatim " +
      "into the preview prompt so the user can read what will actually be sent at generation " +
      "time. Omit when no pose source is selected.",
    ),
  pose_shot: z
    .string()
    .max(POSE_SHOT_MAX)
    .optional()
    .describe(
      "Pose-source shot size + camera angle (same shape passed to generate_outfit). " +
      "Injected as the framing directive in each model's preview prompt.",
    ),
  custom_prompt: z
    .string()
    .max(CUSTOM_PROMPT_MAX)
    .optional()
    .describe("Optional free-form instruction appended to the outfit prompt"),
  platform: z
    .enum(PLATFORMS)
    .optional()
    .describe("Optional platform aesthetic preset (ig | tiktok | youtube)"),
  pose_coverage: z
    .enum(OUTFIT_POSE_COVERAGE)
    .optional()
    .describe("How much of the body the pose reference covers (face | upper | full). Defaults to 'full'."),
} satisfies ZodRawShape;

type PreviewArgs = SchemaArgs<typeof previewSchema>;

interface PreviewEntry {
  model: OutfitModelKey;
  provider: OutfitProvider;
  prompt: string;
  image_count: number;
  backdrop_mentioned?: boolean;
}

export function previewOutfitPromptsDef(): ToolDef {
  return {
    name: "preview_outfit_prompts",
    description:
      "Preview the per-model prompts that would be sent by generate_outfit, without enqueueing any " +
      "jobs. Pure function over the inputs — no file I/O, no API calls.",
    schema: previewSchema,
    handler: async (args) => {
      const a = args as PreviewArgs;
      const provider: OutfitProvider = a.provider ?? "kie";
      const hasBackdrop = !!a.has_backdrop;
      // Dummy slugs — only needed so buildImageSlugs can return a length for image_count.
      const slugs: SlugInputs = {
        model: "@img-preview-model",
        garment: "@img-preview-garment",
        pose: "@img-preview-pose",
        ...(hasBackdrop ? { backdrop: "@img-preview-backdrop" } : {}),
      };
      const coverage: OutfitPoseCoverage = a.pose_coverage ?? "full";
      // The frontend passes the resolved pose text (read from the pose
      // source's cached `.original.analysis.json`) so the preview shows
      // exactly what generation will inject — no placeholder, no vision call.
      const previewPoseDescription = a.pose_description?.trim() || undefined;
      const previewShot = a.pose_shot?.trim() || undefined;
      const prompts: PreviewEntry[] = a.models.map((model) => {
        const { image_slugs, backdropMentioned } = buildImageSlugs(model, provider, slugs);
        const prompt = buildPromptForModel(
          model,
          provider,
          hasBackdrop,
          a.platform,
          a.custom_prompt,
          undefined,
          previewPoseDescription,
          coverage,
          previewShot,
        );
        const entry: PreviewEntry = {
          model,
          provider,
          prompt,
          image_count: image_slugs.length,
          ...(backdropMentioned ? { backdrop_mentioned: true } : {}),
        };
        return entry;
      });
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ prompts, negative_prompt: previewNegativePromptFor(a.models) }),
        }],
      };
    },
  };
}

async function readCachedAnalysis(
  fs: ClipfirstFs,
  assetId: string,
  projectSlug: string,
): Promise<DescribeImageResult | undefined> {
  const read = await fs.readFile(assetId, ANALYSIS_FILENAME, projectSlug);
  if (!read.ok) return undefined;
  const text = typeof read.value === "string"
    ? read.value
    : new TextDecoder().decode(read.value);
  try {
    const parsed = JSON.parse(text) as DescribeImageResult;
    if (typeof parsed?.prompt === "string") return parsed;
  } catch {
    // fall through and recompute
  }
  return undefined;
}

/**
 * Resolve an @img-* backdrop slug to a vision description. Reads the cached
 * `.original.analysis.json` written by describe_image when available;
 * otherwise runs vision on the bytes and writes the cache for next time.
 * Returns the full reproduction `prompt` field (scene, light, palette).
 * Pose descriptions are no longer derived here — callers pass the resolved
 * `pose_description` text directly so it's visible at the tool call site.
 */
async function describeBackdropAsset(
  fs: ClipfirstFs,
  projectSlug: string,
  rawSlug: string,
): Promise<string | undefined> {
  if (rawSlug.startsWith("http://") || rawSlug.startsWith("https://")) return undefined;
  const assetId = rawSlug.replace(/^@/, "");
  if (!assetId.startsWith("img-")) return undefined;

  const cached = await readCachedAnalysis(fs, assetId, projectSlug);
  if (cached) return cached.prompt?.trim() || undefined;

  const manifest = await fs.getManifest(assetId, projectSlug);
  if (!manifest.ok) return undefined;
  const imageFile = findImageFile(manifest.value.files);
  if (!imageFile) return undefined;
  const read = await fs.readFile(assetId, imageFile.name, projectSlug);
  if (!read.ok) return undefined;
  try {
    const result = await describeImageBytes(
      Buffer.from(read.value),
      mimeForImageFilename(imageFile.name),
    );
    const writeResult = await fs.writeFile(
      assetId,
      ANALYSIS_FILENAME,
      JSON.stringify(result, null, 2),
      projectSlug,
    );
    if (!writeResult.ok) {
      console.warn(
        `[generate_outfit] backdrop cache write failed for ${assetId}: ${writeResult.error.message}`,
      );
    }
    return result.prompt?.trim() || undefined;
  } catch (err) {
    console.warn(`[generate_outfit] backdrop describe failed for ${assetId}: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

export function generateOutfitDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "generate_outfit",
    description:
      "Virtual try-on: compose a model photo (Image 1), a garment (Image 2), a pose reference (Image 3), " +
      "and an optional backdrop/scene (Image 4) into a generated image. Dispatches to the selected " +
      "image-edit models through the chosen provider (kie | fal) using per-model prompts.",
    schema,
    handler: async (args) => {
      const a = args as Args;
      const provider: OutfitProvider = a.provider ?? "kie";
      const providerEnvKey = provider === "kie" ? "KIE_API_KEY" : "FAL_API_KEY";
      if (!process.env[providerEnvKey]) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `${providerEnvKey} environment variable is not set` }],
        };
      }

      const hasPoseSlug = !!a.pose_image_slug;
      const hasPoseData = !!a.pose_image_data;
      if (hasPoseSlug === hasPoseData) {
        return {
          isError: true as const,
          content: [{
            type: "text" as const,
            text: "Provide exactly one of pose_image_slug or pose_image_data",
          }],
        };
      }
      if (hasPoseData && !a.pose_filename) {
        return {
          isError: true as const,
          content: [{
            type: "text" as const,
            text: "pose_filename is required when providing pose_image_data",
          }],
        };
      }

      let poseRef: string;
      if (hasPoseSlug) {
        poseRef = withAt(a.pose_image_slug!);
      } else {
        const bytes = Buffer.from(a.pose_image_data!, "base64");
        const filename = a.pose_filename!;
        try {
          poseRef = provider === "kie"
            ? await uploadBytesToKie(bytes, filename)
            : await uploadBytesToFal(bytes, filename);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            isError: true as const,
            content: [{ type: "text" as const, text: `Ephemeral pose upload failed: ${msg}` }],
          };
        }
      }

      const slugs: SlugInputs = {
        model: withAt(a.model_image_slug),
        garment: withAt(a.garment_image_slug),
        pose: poseRef,
        ...(a.backdrop_image_slug ? { backdrop: withAt(a.backdrop_image_slug) } : {}),
      };
      const hasBackdrop = !!slugs.backdrop;

      // Backdrop is never passed as an image slot — all models share a
      // 3-image layout [model, garment, pose skeleton]. When a backdrop is
      // supplied, describe it once via vision and inject the text.
      // Pose semantics arrive pre-resolved as `pose_description`: the caller
      // (frontend or chat agent) reads the pose source's analysis JSON and
      // passes the body-geometry text directly, so the prompt is auditable
      // at the call site and the server makes no extra vision call.
      const backdropDescription = hasBackdrop
        ? await describeBackdropAsset(fs, a.project_slug, a.backdrop_image_slug!)
        : undefined;
      const poseDescription = a.pose_description?.trim() || undefined;
      const shot = a.pose_shot?.trim() || undefined;

      const coverage: OutfitPoseCoverage = a.pose_coverage ?? "full";
      const outcomes: EnqueueOutcome[] = [];
      for (const model of a.models) {
        const factory = DISPATCH[provider][model];
        const { image_slugs, backdropMentioned } = buildImageSlugs(model, provider, slugs);
        const prompt = buildPromptForModel(
          model,
          provider,
          hasBackdrop,
          a.platform,
          a.custom_prompt,
          backdropDescription,
          poseDescription,
          coverage,
          shot,
        );
        const outcome: EnqueueOutcome = {
          model,
          provider,
          prompt,
          image_count: image_slugs.length,
          ...(backdropMentioned ? { backdrop_mentioned: true } : {}),
        };
        if (!factory) {
          outcome.error = `model ${model} is not available via provider ${provider}`;
          outcomes.push(outcome);
          continue;
        }
        const def = factory(fs);
        // Only Wan and Qwen on fal consume the native negative_prompt field.
        // Their kie counterparts already carry the Avoid clause in `prompt`.
        // NBPro, Seedream and GPT Image 2 never receive a negative.
        const nativeNegative =
          provider === "fal" && (model === "qwen_image_edit" || model === "wan27_pro");
        // Seedream 5 Lite on Kie requires `quality` at the API level — pin
        // to "high" (4K) for outfit since try-on benefits from detail.
        const seedreamKieQuality =
          provider === "kie" && model === "seedream_v5_lite";
        const res = await def.handler({
          project_slug: a.project_slug,
          prompt,
          image_slugs,
          ...resolveSizeArgs(provider, model, a.aspect_ratio),
          ...(nativeNegative ? { negative_prompt: WAN_QWEN_NEGATIVE } : {}),
          ...(seedreamKieQuality ? { quality: "high" } : {}),
        } as unknown as Record<string, unknown>);
        const r = extractEnqueueResult(res);
        if (r.error) outcome.error = r.error;
        if (r.assetId) outcome.img_asset_id = r.assetId;
        if (r.jobId) outcome.job_id = r.jobId;
        outcomes.push(outcome);
      }

      // Auto-pin generated outfits to the source character's outfits[] when
      // the model image is a char-*. The asset IDs are known here even though
      // the image jobs are still running — failed renders surface as "failed"
      // status on the asset and the client can render them as such.
      const modelSlugStripped = a.model_image_slug.replace(/^@/, "");
      if (modelSlugStripped.startsWith("char-")) {
        const newAssetIds = outcomes
          .filter((o) => !!o.img_asset_id && !o.error)
          .map((o) => o.img_asset_id!);
        if (newAssetIds.length > 0) {
          const read = await fs.readMetadata<Character>(
            modelSlugStripped,
            CHARACTER_METADATA_KEY,
            a.project_slug,
          );
          if (read.ok) {
            const current = read.value.outfits ?? [];
            const merged = [...current];
            for (const id of newAssetIds) if (!merged.includes(id)) merged.push(id);
            const next: Character = { ...read.value, outfits: merged };
            const write = await fs.writeMetadata(
              modelSlugStripped,
              CHARACTER_METADATA_KEY,
              next,
              a.project_slug,
            );
            if (!write.ok) {
              console.warn(
                `[generate_outfit] auto-pin to ${modelSlugStripped} failed: ${write.error.message}`,
              );
            }
          } else {
            console.warn(
              `[generate_outfit] auto-pin skipped: could not read .character.json for ${modelSlugStripped}: ${read.error.message}`,
            );
          }
        }
      }

      const enqueued = outcomes.filter((o) => !o.error).length;
      const failed = outcomes.filter((o) => !!o.error).length;
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            status: enqueued > 0 ? "enqueued" : "failed",
            enqueued,
            failed,
            outcomes,
          }),
        }],
      };
    },
  };
}
