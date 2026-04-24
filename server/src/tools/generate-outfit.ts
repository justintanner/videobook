import type { ClipfirstFs } from "clipfirst-fs";
import { z, type ZodRawShape } from "zod";
import type { SchemaArgs, ToolDef, ToolResult } from "./tool-def.js";
import { generateNanoBananaProEditFalDef } from "./generate-nano-banana-pro-edit-fal.js";
import { generateQwenImageEditFalDef } from "./generate-qwen-image-edit-fal.js";
import { generateWan27ProEditFalDef } from "./generate-wan27-pro-edit-fal.js";
import { generateGrokImagineImageEditFalDef } from "./generate-grok-imagine-image-edit-fal.js";
import { generateNanoBananaImageDef } from "./generate-nano-banana-image.js";
import { generateQwen2ImageEditDef } from "./generate-qwen2-image-edit.js";
import { generateGptImageDef } from "./generate-gpt-image.js";
import { generateWan27ImageProDef } from "./generate-wan27-image-pro.js";
import { generateGrokImagineImageDef } from "./generate-grok-imagine-image.js";
import { platformGuidance, type Platform } from "../platform-guidance.js";
import { uploadBytesToFal } from "../jobs/_fal-upload.js";
import { uploadBytesToKie } from "../jobs/_kie-upload.js";
import { describeImageBytes, mimeForImageFilename } from "../jobs/describe-image.js";
import { findImageFile } from "./_image-inputs.js";

const CUSTOM_PROMPT_MAX = 500;
const PLATFORMS = ["ig", "tiktok", "youtube"] as const;

export const SUPPORTED_OUTFIT_MODELS = [
  "nano_banana_pro",
  "qwen_image_edit",
  "gpt_image_2",
  "wan27_pro",
  "grok_imagine",
] as const;
export type OutfitModelKey = typeof SUPPORTED_OUTFIT_MODELS[number];

export const OUTFIT_PROVIDERS = ["kie", "fal"] as const;
export type OutfitProvider = typeof OUTFIT_PROVIDERS[number];

export const OUTFIT_ASPECT_RATIOS = ["9:16", "16:9", "1:1"] as const;
export type OutfitAspectRatio = typeof OUTFIT_ASPECT_RATIOS[number];

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
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof schema>;

type ToolDefFactory = (fs: ClipfirstFs) => { handler: (args: Record<string, unknown>) => Promise<ToolResult> };

const DISPATCH: Record<OutfitProvider, Partial<Record<OutfitModelKey, ToolDefFactory>>> = {
  kie: {
    nano_banana_pro: generateNanoBananaImageDef,
    qwen_image_edit: generateQwen2ImageEditDef,
    gpt_image_2: generateGptImageDef,
    wan27_pro: generateWan27ImageProDef,
    grok_imagine: generateGrokImagineImageDef,
  },
  fal: {
    nano_banana_pro: generateNanoBananaProEditFalDef,
    qwen_image_edit: generateQwenImageEditFalDef,
    wan27_pro: generateWan27ProEditFalDef,
    grok_imagine: generateGrokImagineImageEditFalDef,
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

/**
 * Per-model prompt builders. Each model has its own preferred multi-image
 * reference convention — passing the right one measurably improves adherence.
 * See plan notes for sources.
 */

// Nano Banana Pro — role-based "Reference Image N (the role)" phrasing.
function promptForNanoBananaPro(hasBackdrop: boolean, platform: Platform | undefined, custom: string | undefined): string {
  const backdropClause = hasBackdrop
    ? " Reference Image 4 is the backdrop/scene — place the subject in that location, matching its lighting, depth and colour cast."
    : " Render a tasteful, photorealistic background that suits the subject.";
  const base =
    "Using Reference Image 1 (the person/model), Reference Image 2 (the garment), " +
    "and Reference Image 3 (the pose reference), generate a photorealistic image " +
    "of the person from Image 1 wearing the garment from Image 2 and adopting the exact " +
    "pose shown in Image 3. Preserve the identity, face, hair and skin from Image 1. " +
    "Match the cut, colour, pattern and silhouette of the garment in Image 2. " +
    "Align limb angles, torso rotation and head tilt precisely to the pose in Image 3." +
    backdropClause;
  return `${base}${platformSection(platform)}${customSection(custom)}`;
}

// Qwen Image Edit — lowercase "image 1 / image 2 / image 3", hard cap 3.
// Never receives the backdrop as an image; describes it in text only. When a
// backdrop slug is supplied, the caller pre-analyzes the image with vision and
// passes the resulting description in `backdropDescription`.
function promptForQwenImageEdit(
  hasBackdrop: boolean,
  platform: Platform | undefined,
  custom: string | undefined,
  backdropDescription: string | undefined,
): string {
  const backdropClause = backdropDescription
    ? ` For the background, compose this scene: ${backdropDescription} Keep lighting and colour cast consistent with that setting.`
    : hasBackdrop
    ? " For the background, compose a scene that matches the user's backdrop description; keep lighting and colour cast consistent with that setting."
    : " Use a tasteful, photorealistic background.";
  const base =
    "The person in image 1 wears the garment from image 2 and adopts the exact pose " +
    "shown in image 3. Preserve the identity, face, hair and skin from image 1. " +
    "Match the cut, colour, pattern and silhouette of the garment in image 2. " +
    "Align limb angles, torso rotation and head tilt precisely to the pose in image 3. " +
    "Render a photorealistic result with natural lighting." +
    backdropClause;
  return `${base}${platformSection(platform)}${customSection(custom)}`;
}

// GPT Image 2 — labeled "Image N: <role>" prefix format.
function promptForGptImage2(hasBackdrop: boolean, platform: Platform | undefined, custom: string | undefined): string {
  const header = hasBackdrop
    ? "Image 1: the person/model. Image 2: the garment. Image 3: the pose reference. Image 4: the backdrop/scene."
    : "Image 1: the person/model. Image 2: the garment. Image 3: the pose reference.";
  const task = hasBackdrop
    ? "Task: dress the person from Image 1 in the garment from Image 2, pose them exactly as shown in Image 3, and place them in the scene shown in Image 4."
    : "Task: dress the person from Image 1 in the garment from Image 2, pose them exactly as shown in Image 3, and render a tasteful photorealistic background.";
  const rules =
    "Preserve face and identity from Image 1. Match garment cut, colour and pattern from Image 2 precisely. " +
    "Align limbs, torso and head to the pose in Image 3.";
  const base = `${header} ${task} ${rules}`;
  return `${base}${platformSection(platform)}${customSection(custom)}`;
}

// Wan 2.7 — "Change / Keep" two-part framing; images addressed by role.
function promptForWan27Pro(hasBackdrop: boolean, platform: Platform | undefined, custom: string | undefined): string {
  const changeBackdrop = hasBackdrop
    ? " Change the background to match the backdrop reference (Image 4)."
    : " Render a tasteful, photorealistic background.";
  const base =
    "Change: dress the person (Image 1) in the garment (Image 2) and pose them to match the pose (Image 3). " +
    "Keep: the face, hair and skin of the person from Image 1; the cut, colour and pattern of the garment from Image 2." +
    changeBackdrop;
  return `${base}${platformSection(platform)}${customSection(custom)}`;
}

// Grok Imagine — single-image focused, plain-language narrative.
// Even when up to 3 slugs are passed (fal), treat the prompt as describing the
// transformation. Grok never receives the backdrop as an image slot, so when
// supplied the caller pre-analyzes it with vision and passes the text.
function promptForGrokImagine(
  hasBackdrop: boolean,
  platform: Platform | undefined,
  custom: string | undefined,
  backdropDescription: string | undefined,
): string {
  const backdropClause = backdropDescription
    ? ` Place the subject in this backdrop scene: ${backdropDescription} Match its lighting, depth and colour cast.`
    : hasBackdrop
    ? " Place the subject in the backdrop scene provided; match its lighting, depth and colour cast."
    : " Render a tasteful photorealistic background.";
  const base =
    "Edit this photo so the person wears the supplied garment and adopts the supplied pose. " +
    "Keep the person's identity, face, hair and skin unchanged. " +
    "Match the garment's cut, colour, pattern and silhouette. " +
    "Align limbs, torso and head precisely to the supplied pose reference." +
    backdropClause;
  return `${base}${platformSection(platform)}${customSection(custom)}`;
}

function buildPromptForModel(
  model: OutfitModelKey,
  hasBackdrop: boolean,
  platform: Platform | undefined,
  custom: string | undefined,
  backdropDescription: string | undefined,
): string {
  switch (model) {
    case "nano_banana_pro":
      return promptForNanoBananaPro(hasBackdrop, platform, custom);
    case "qwen_image_edit":
      return promptForQwenImageEdit(hasBackdrop, platform, custom, backdropDescription);
    case "gpt_image_2":
      return promptForGptImage2(hasBackdrop, platform, custom);
    case "wan27_pro":
      return promptForWan27Pro(hasBackdrop, platform, custom);
    case "grok_imagine":
      return promptForGrokImagine(hasBackdrop, platform, custom, backdropDescription);
  }
}

interface SlugInputs {
  model: string;
  garment: string;
  pose: string;
  backdrop?: string;
}

/**
 * Build the image_slugs array for a given model, respecting its cap:
 * - qwen_image_edit: 3 images (drops backdrop)
 * - grok_imagine on kie: effectively 1 image (only first is consumed downstream)
 * - grok_imagine on fal: 3 images (drops backdrop)
 * - nano_banana_pro / gpt_image_2 / wan27_pro: 4 images when backdrop supplied
 */
function buildImageSlugs(
  model: OutfitModelKey,
  provider: OutfitProvider,
  slugs: SlugInputs,
): { image_slugs: string[]; backdropMentioned: boolean } {
  const hasBackdrop = !!slugs.backdrop;
  const four = hasBackdrop
    ? [slugs.model, slugs.garment, slugs.pose, slugs.backdrop!]
    : [slugs.model, slugs.garment, slugs.pose];
  const three = [slugs.model, slugs.garment, slugs.pose];

  if (model === "qwen_image_edit") {
    return { image_slugs: three, backdropMentioned: hasBackdrop };
  }
  if (model === "grok_imagine" && provider === "kie") {
    return { image_slugs: [slugs.model], backdropMentioned: hasBackdrop };
  }
  if (model === "grok_imagine" && provider === "fal") {
    return { image_slugs: three, backdropMentioned: hasBackdrop };
  }
  return { image_slugs: four, backdropMentioned: false };
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
  custom_prompt: z
    .string()
    .max(CUSTOM_PROMPT_MAX)
    .optional()
    .describe("Optional free-form instruction appended to the outfit prompt"),
  platform: z
    .enum(PLATFORMS)
    .optional()
    .describe("Optional platform aesthetic preset (ig | tiktok | youtube)"),
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
      const prompts: PreviewEntry[] = a.models.map((model) => {
        const { image_slugs, backdropMentioned } = buildImageSlugs(model, provider, slugs);
        const prompt = buildPromptForModel(model, hasBackdrop, a.platform, a.custom_prompt, undefined);
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
        content: [{ type: "text" as const, text: JSON.stringify({ prompts }) }],
      };
    },
  };
}

/**
 * Resolve a backdrop slug to its image bytes and run the vision describer.
 * Returns the reproduction-ready `prompt` field from describe-image, which
 * we inject into prompts for models that cannot accept the backdrop as an
 * image slot (qwen, grok). Returns undefined on failure — callers fall back
 * to the generic "user's backdrop description" placeholder clause.
 */
async function describeBackdropImage(
  fs: ClipfirstFs,
  projectSlug: string,
  rawSlug: string,
): Promise<string | undefined> {
  if (rawSlug.startsWith("http://") || rawSlug.startsWith("https://")) return undefined;
  const assetId = rawSlug.replace(/^@/, "");
  if (!assetId.startsWith("img-")) return undefined;
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
    return result.prompt.trim();
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

      // If any selected model/provider combo cannot accept the backdrop as an
      // image slot (qwen, grok), describe the backdrop image once via vision
      // and inject the text into those prompts. One vision call per call,
      // shared across models. No-op when no backdrop is supplied or when all
      // selected models carry the backdrop as image 4.
      const needsBackdropText =
        hasBackdrop &&
        a.models.some((m) => buildImageSlugs(m, provider, slugs).backdropMentioned);
      const backdropDescription = needsBackdropText
        ? await describeBackdropImage(fs, a.project_slug, a.backdrop_image_slug!)
        : undefined;

      const outcomes: EnqueueOutcome[] = [];
      for (const model of a.models) {
        const factory = DISPATCH[provider][model];
        const { image_slugs, backdropMentioned } = buildImageSlugs(model, provider, slugs);
        const prompt = buildPromptForModel(
          model,
          hasBackdrop,
          a.platform,
          a.custom_prompt,
          backdropMentioned ? backdropDescription : undefined,
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
        const res = await def.handler({
          project_slug: a.project_slug,
          prompt,
          image_slugs,
          ...resolveSizeArgs(provider, model, a.aspect_ratio),
        } as unknown as Record<string, unknown>);
        const r = extractEnqueueResult(res);
        if (r.error) outcome.error = r.error;
        if (r.assetId) outcome.img_asset_id = r.assetId;
        if (r.jobId) outcome.job_id = r.jobId;
        outcomes.push(outcome);
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
