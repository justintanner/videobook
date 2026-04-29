import type { ClipfirstFs } from "clipfirst-engine";
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
import {
  CHARACTER_METADATA_KEY,
  isAnimalCharacterSubjectKind,
  isMaleCharacterSex,
  normalizeCharacterSubjectKind,
  normalizeCharacterSex,
  type Character,
} from "../jobs/extract-character.js";

const CUSTOM_PROMPT_MAX = 500;
const POSE_DESCRIPTION_MAX = 1500;
const POSE_SHOT_MAX = 80;
const PLATFORMS = ["ig", "tiktok", "youtube"] as const;

// Negative prompt for Wan + Qwen — short and readable. Wan/Qwen on fal pass
// it via the native `negative_prompt` field; on kie it's baked into the main
// prompt as an Avoid clause. Nano Banana Pro and Seedream get nothing
// (Nano's L2 filter trips on negatives; Seedream's guide warns against them).
// GPT Image 2 embeds short inline exclusions instead.
export const WAN_QWEN_NEGATIVE =
  "deformed hands, extra fingers, contorted pose, plastic skin, watermark, text";

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
      "positions). Injected as the **authoritative** pose clause in each model's prompt — image 3 " +
      "(the rendered skeleton) is demoted to a secondary visual reference. Callers should source " +
      "this from the pose-source image's `.original.analysis.json` `pose` field.",
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

// Explicit textual stance directive for when the pose reference doesn't
// carry full-body structure. Without this the image model has no cue for
// the body below what the reference shows and produces awkward / lying /
// crouched stances when the reference is a headshot.
const CONTRAPPOSTO_STANCE =
  "a relaxed contrapposto standing pose: weight on the back leg, " +
  "arms falling naturally at the sides, shoulders squared to camera";

// Trim a long descriptor to its essential first phrase. Vision-extracted
// fields like `bust` or `face` often arrive as full sentences ("oval face
// with high cheekbones, defined jawline, straight nose, and full lips.") —
// keep the head clause so the prompt stays dense without dropping coverage.
function trimDescriptor(value: string): string {
  const head = value.split(/[,;.]/)[0] ?? value;
  return head.trim().replace(/\s+/g, " ");
}

function compressCharacterProfile(c: Character | undefined): string {
  if (!c) return "";
  const parts: string[] = [];
  const subjectKind = normalizeCharacterSubjectKind(c.subject_kind);
  if (isAnimalCharacterSubjectKind(subjectKind)) {
    parts.push(["animal", c.age, c.ethnicity].filter(Boolean).join(" "));
    const body = [c.height, c.build && `${c.build} build`].filter(Boolean).join(", ");
    if (body) parts.push(body);
    const measurements = [
      c.bust && `chest/torso ${trimDescriptor(c.bust)}`,
      c.waist && `midsection ${trimDescriptor(c.waist)}`,
      c.hips && `hindquarters ${trimDescriptor(c.hips)}`,
      c.glutes && `rear/tail base ${trimDescriptor(c.glutes)}`,
    ].filter(Boolean).join(", ");
    if (measurements) parts.push(measurements);
    if (c.face) parts.push(`head ${trimDescriptor(c.face)}`);
    if (c.hair) parts.push(`coat/fur ${trimDescriptor(c.hair)}`);
    if (c.eyes) parts.push(`eyes ${trimDescriptor(c.eyes)}`);
    if (c.skin) parts.push(`coat texture ${trimDescriptor(c.skin)}`);
    if (c.distinguishing_features) parts.push(`features ${trimDescriptor(c.distinguishing_features)}`);
    return parts.join("; ");
  }
  const sex = normalizeCharacterSex(c.sex || c.gender_presentation || "");
  const identity = [c.age, sex, c.ethnicity].filter(Boolean).join(" ");
  if (identity) parts.push(identity);
  const body = [c.height, c.build && `${c.build} build`].filter(Boolean).join(", ");
  if (body) parts.push(body);
  const chestLabel = isMaleCharacterSex(sex) ? "chest" : "bust";
  const measurements = [
    c.bust && `${chestLabel} ${trimDescriptor(c.bust)}`,
    c.waist && `waist ${trimDescriptor(c.waist)}`,
    c.hips && `hips ${trimDescriptor(c.hips)}`,
    c.glutes && `glutes ${trimDescriptor(c.glutes)}`,
  ].filter(Boolean).join(", ");
  if (measurements) parts.push(measurements);
  if (c.face) parts.push(`face ${trimDescriptor(c.face)}`);
  if (c.hair) parts.push(`hair ${trimDescriptor(c.hair)}`);
  if (c.eyes) parts.push(`eyes ${trimDescriptor(c.eyes)}`);
  if (c.skin) parts.push(`skin ${trimDescriptor(c.skin)}`);
  if (c.distinguishing_features) parts.push(`features ${trimDescriptor(c.distinguishing_features)}`);
  return parts.join("; ");
}

// Provider-specific image-reference jargon. Numbered models use "Image N";
// Qwen uses lowercase "image N" (and never receives Image 4 — its hard 3-image
// cap means the backdrop is always text-described). Seedream uses native
// "Figure N" — that's the syntax the official Wavespeed/fal docs prescribe.
// (An earlier multi-figure turnaround bug came from the colon-prefixed legend
// "Figure 1: subject; Figure 2: outfit", not the Figure-N syntax itself.)
function refFor(model: OutfitModelKey, n: 1 | 2 | 3 | 4): string {
  if (model === "qwen_image_edit") return `image ${n}`;
  if (model === "seedream_v5_lite") return `Figure ${n}`;
  return `Image ${n}`;
}

// Coverage tail — fills in the body parts the pose source didn't show.
// Empty for "full" because the pose-description text already covers the
// whole body.
function coverageTail(coverage: OutfitPoseCoverage): string {
  switch (coverage) {
    case "full":
      return "";
    case "upper":
      return "Legs and stance: relaxed standing, weight on the back leg.";
    case "face":
      return `Body: ${CONTRAPPOSTO_STANCE}.`;
  }
}

/**
 * Compact unified prompt builder.
 *
 * Order: Outfit → Pose → Backdrop → Subject. Clothes/pose/backdrop are the
 * directives the user is changing; identity is the constant the model already
 * sees in Image 1, so it's last.
 *
 * Per-model differences are reduced to:
 *  - image-reference jargon (`refFor`)
 *  - whether backdrop is passed as Image 4 (every model except Qwen)
 *  - per-model anti-failure tails (Seedream multi-view guard, GPT constraints,
 *    kie Avoid clause for Wan/Qwen)
 */
function buildPromptCompact(
  model: OutfitModelKey,
  provider: OutfitProvider,
  hasBackdropImage: boolean,
  backdropDescription: string | undefined,
  poseDescription: string | undefined,
  coverage: OutfitPoseCoverage,
  shot: string | undefined,
  character: Character | undefined,
  platform: Platform | undefined,
  custom: string | undefined,
): string {
  if (model === "seedream_v5_lite") {
    return buildPromptSeedream(
      hasBackdropImage,
      backdropDescription,
      poseDescription,
      coverage,
      platform,
      custom,
    );
  }

  const ref = (n: 1 | 2 | 3 | 4) => refFor(model, n);
  const lines: string[] = [];

  // Image legend — declare what each input is in the model's preferred jargon.
  const legend: string[] = [
    `${ref(1)}: subject`,
    `${ref(2)}: outfit`,
    `${ref(3)}: pose skeleton`,
  ];
  if (hasBackdropImage) legend.push(`${ref(4)}: backdrop`);
  lines.push(legend.join("; ") + ".");

  // Outfit directive.
  lines.push(`Outfit: dress the subject in ${ref(2)} — match cut, colour, pattern, silhouette.`);

  // Pose directive — text from the analysis is authoritative; the rendered
  // skeleton in Image 3 is a corroborating reference only.
  if (poseDescription) {
    const tail = coverageTail(coverage);
    const tailPart = tail ? ` ${tail}` : "";
    lines.push(
      `Pose (authoritative): ${poseDescription}. ${ref(3)} is a corroborating skeleton; defer to the text if they disagree.${tailPart}`,
    );
  } else {
    const tail = coverageTail(coverage);
    const tailPart = tail ? ` ${tail}` : "";
    lines.push(`Pose: match ${ref(3)}.${tailPart}`);
  }

  // Backdrop — passed as Image 4 when supported, otherwise text-described.
  if (hasBackdropImage) {
    lines.push(
      `Backdrop: place the subject in the location shown in ${ref(4)} — match its lighting, colour cast, and depth.`,
    );
  } else if (backdropDescription) {
    lines.push(`Backdrop: ${backdropDescription} Match its lighting and colour cast.`);
  } else {
    lines.push("Backdrop: tasteful editorial setting with natural lighting.");
  }

  // Subject identity — last, because it's the constant Image 1 already encodes.
  const compressed = compressCharacterProfile(character);
  const subject = compressed
    ? `Subject (from ${ref(1)}): ${compressed}.`
    : `Subject: preserve identity from ${ref(1)}.`;
  lines.push(`${subject} Preserve identity, geometry, proportions; hands fully visible with five distinct fingers.`);

  // Framing.
  if (shot) lines.push(`Framing: ${shot}.`);

  // Per-model anti-failure tails.
  if (model === "gpt_image_2") {
    lines.push("Constraints: no watermark, no text, no logos, no extra limbs, no deformed hands.");
  }
  if (provider === "kie" && (model === "wan27_pro" || model === "qwen_image_edit")) {
    lines.push(`Avoid: ${WAN_QWEN_NEGATIVE}.`);
  }

  let prompt = lines.join(" ");
  prompt += platformSection(platform);
  prompt += customSection(custom);
  return prompt;
}

/**
 * Seedream 5 Lite gets a different builder because the official Wavespeed/fal
 * docs prescribe a specific shape: the **Edit Preservation Template** —
 * "Replace [X] with [Y], while keeping [Z] unchanged" — using native "Figure N"
 * refs. End-state phrasing only (the docs warn against procedural verbs like
 * "do not redraw" or "remove gradually"). No legend block, no body-measurement
 * descriptors (Seedream sees the body in Figure 1 and reads the text as a
 * generation cue, which is what produced the alien-face outputs).
 */
function buildPromptSeedream(
  hasBackdropImage: boolean,
  backdropDescription: string | undefined,
  poseDescription: string | undefined,
  coverage: OutfitPoseCoverage,
  platform: Platform | undefined,
  custom: string | undefined,
): string {
  const ref = (n: 1 | 2 | 3 | 4) => refFor("seedream_v5_lite", n);
  const sentences: string[] = [];

  sentences.push(
    `Replace the outfit on the person in ${ref(1)} with the outfit shown in ${ref(2)} — match its cut, colour, pattern, and silhouette.`,
  );

  if (poseDescription) {
    const tail = coverageTail(coverage);
    const tailPart = tail ? ` ${tail}` : "";
    sentences.push(`Pose the body to match ${ref(3)}: ${poseDescription}.${tailPart}`);
  } else {
    const tail = coverageTail(coverage);
    const tailPart = tail ? ` ${tail}` : "";
    sentences.push(`Pose the body to match ${ref(3)}.${tailPart}`);
  }

  if (hasBackdropImage) {
    sentences.push(
      `Place the subject in the location shown in ${ref(4)} — match its lighting, colour cast, and depth of field.`,
    );
  } else if (backdropDescription) {
    sentences.push(`Place the subject in this setting: ${backdropDescription}`);
  }

  // Single end-state preservation clause — the official template form.
  sentences.push(
    `Keep ${ref(1)}'s face, hair, skin tone, body proportions, and identity exactly the same.`,
  );

  // The single safety guard the multi-figure bug taught us — phrased as
  // end-state, not as a procedural "do not".
  sentences.push("Output: a single photograph of one person.");

  let prompt = sentences.join(" ");
  prompt += platformSection(platform);
  prompt += customSection(custom);
  return prompt;
}

interface SlugInputs {
  model: string;
  garment: string;
  pose: string;
  backdrop?: string;
}

/**
 * Image layout: every model gets [model, garment, pose skeleton]. When a
 * backdrop is supplied AND the model isn't Qwen (hard 3-image cap), we also
 * pass the backdrop as Image 4. Qwen falls back to a text-described backdrop.
 */
function buildImageSlugs(
  model: OutfitModelKey,
  slugs: SlugInputs,
): { image_slugs: string[]; backdropAsImage: boolean } {
  const base = [slugs.model, slugs.garment, slugs.pose];
  if (slugs.backdrop && model !== "qwen_image_edit") {
    return { image_slugs: [...base, slugs.backdrop], backdropAsImage: true };
  }
  return { image_slugs: base, backdropAsImage: false };
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
  project_slug: z
    .string()
    .optional()
    .describe("Project slug. Required when model_image_slug points at a char-* so the server can load .character.json."),
  model_image_slug: z
    .string()
    .optional()
    .describe(
      "@img-* or char-* slug of the subject. When a char-* is provided the server loads " +
      ".character.json and prepends a compressed identity sentence to the preview prompts so " +
      "what the user sees matches what generate_outfit will send.",
    ),
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

async function loadCharacterIfChar(
  fs: ClipfirstFs,
  projectSlug: string | undefined,
  modelImageSlug: string | undefined,
): Promise<Character | undefined> {
  if (!projectSlug || !modelImageSlug) return undefined;
  const stripped = modelImageSlug.replace(/^@/, "");
  if (!stripped.startsWith("char-")) return undefined;
  const read = await fs.readMetadata<Character>(stripped, CHARACTER_METADATA_KEY, projectSlug);
  return read.ok ? read.value : undefined;
}

export function previewOutfitPromptsDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "preview_outfit_prompts",
    description:
      "Preview the per-model prompts that would be sent by generate_outfit, without enqueueing any " +
      "jobs. When model_image_slug points at a char-*, loads .character.json so the preview " +
      "includes the same compressed identity sentence the real call would send.",
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
      const character = await loadCharacterIfChar(fs, a.project_slug, a.model_image_slug);
      // Preview shows a placeholder string for the text-described backdrop
      // (Qwen path), since no actual backdrop slug is being analysed here.
      const previewBackdropDescription = hasBackdrop
        ? "[backdrop scene from your reference image]"
        : undefined;
      const prompts: PreviewEntry[] = a.models.map((model) => {
        const { image_slugs, backdropAsImage } = buildImageSlugs(model, slugs);
        const prompt = buildPromptCompact(
          model,
          provider,
          backdropAsImage,
          backdropAsImage ? undefined : previewBackdropDescription,
          previewPoseDescription,
          coverage,
          previewShot,
          character,
          a.platform,
          a.custom_prompt,
        );
        const entry: PreviewEntry = {
          model,
          provider,
          prompt,
          image_count: image_slugs.length,
          ...(hasBackdrop ? { backdrop_mentioned: true } : {}),
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
 *
 * Fallback chain on vision failure (e.g. XAI 400 from oversized originals):
 *   1. Retry on the cropped `square.jpg` variant (1080² is well within limits).
 *   2. Fall back to a slug-derived hint so Qwen still references the backdrop.
 */
async function tryDescribe(
  fs: ClipfirstFs,
  assetId: string,
  filename: string,
  projectSlug: string,
): Promise<string | undefined> {
  const read = await fs.readFile(assetId, filename, projectSlug);
  if (!read.ok) return undefined;
  try {
    const result = await describeImageBytes(
      Buffer.from(read.value),
      mimeForImageFilename(filename),
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
    console.warn(
      `[generate_outfit] backdrop describe failed for ${assetId} via ${filename}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}

function slugFallbackHint(assetId: string): string {
  const stem = assetId.replace(/^img-/, "").replace(/-\d+$/, "");
  const words = stem.replace(/-/g, " ").trim();
  return words
    ? `the supplied backdrop reference (${words}) — match its mood and lighting`
    : "the supplied backdrop reference — match its mood and lighting";
}

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

  const primary = await tryDescribe(fs, assetId, imageFile.name, projectSlug);
  if (primary) return primary;

  const cropped = manifest.value.files.find((f) => f.name === "square.jpg");
  if (cropped && cropped.name !== imageFile.name) {
    const secondary = await tryDescribe(fs, assetId, cropped.name, projectSlug);
    if (secondary) return secondary;
  }

  const hint = slugFallbackHint(assetId);
  console.warn(`[generate_outfit] backdrop describe falling back to slug hint for ${assetId}: "${hint}"`);
  return hint;
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

      // Pose semantics arrive pre-resolved as `pose_description`: the caller
      // (frontend or chat agent) reads the pose source's analysis JSON and
      // passes the body-geometry text directly, so the prompt is auditable
      // at the call site and the server makes no extra vision call.
      // The backdrop is now passed as Image 4 for every model except Qwen
      // (3-image cap). We only run the vision describe when at least one
      // selected model is Qwen with a backdrop set.
      const qwenWithBackdrop = hasBackdrop && a.models.includes("qwen_image_edit");
      const backdropDescription = qwenWithBackdrop
        ? await describeBackdropAsset(fs, a.project_slug, a.backdrop_image_slug!)
        : undefined;
      const poseDescription = a.pose_description?.trim() || undefined;
      const shot = a.pose_shot?.trim() || undefined;

      const coverage: OutfitPoseCoverage = a.pose_coverage ?? "full";
      const character = await loadCharacterIfChar(fs, a.project_slug, a.model_image_slug);
      const outcomes: EnqueueOutcome[] = [];
      for (const model of a.models) {
        const factory = DISPATCH[provider][model];
        const { image_slugs, backdropAsImage } = buildImageSlugs(model, slugs);
        const prompt = buildPromptCompact(
          model,
          provider,
          backdropAsImage,
          backdropAsImage ? undefined : backdropDescription,
          poseDescription,
          coverage,
          shot,
          character,
          a.platform,
          a.custom_prompt,
        );
        const outcome: EnqueueOutcome = {
          model,
          provider,
          prompt,
          image_count: image_slugs.length,
          ...(hasBackdrop ? { backdrop_mentioned: true } : {}),
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
