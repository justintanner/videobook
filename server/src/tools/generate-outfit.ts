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
  // Tools that accept ratio strings directly as `aspect_ratio`.
  if (provider === "kie" && model !== "qwen_image_edit") return { aspect_ratio: ratio };
  // Tools that accept ratio strings via `image_size` (kie qwen2 image-edit, fal qwen-edit).
  if (model === "qwen_image_edit") return { image_size: ratio };
  if (provider === "fal" && model === "nano_banana_pro") return { aspect_ratio: ratio };
  // fal wan27_pro only accepts FAL-style enum presets via `image_size`.
  if (provider === "fal" && model === "wan27_pro") return { image_size: IMAGE_SIZE_MAP[ratio] };
  // fal grok-imagine has no aspect/size control.
  return {};
}

const schema = {
  project_slug: z.string().describe("Project slug"),
  model_image_slug: z.string().describe("@img-* slug of the person/model photo (Image 1)"),
  garment_image_slug: z.string().describe("@img-* slug of the garment/clothing (Image 2)"),
  pose_image_slug: z.string().describe("@img-* slug of the MediaPipe Holistic skeleton overlay (Image 3)"),
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
  return slug.startsWith("@") ? slug : `@${slug}`;
}

function buildOutfitPrompt(customPrompt: string | undefined, platform: Platform | undefined): string {
  const base =
    "The person in Image 1 wears the garment from Image 2 and adopts the exact pose shown by the " +
    "skeleton in Image 3. Preserve the identity, face, hair and skin of the person in Image 1. " +
    "Match the cut, color, pattern and silhouette of the garment in Image 2 as closely as possible. " +
    "Align limb angles, torso rotation and head tilt to the Image 3 skeleton. " +
    "Render a photorealistic result with natural lighting and a tasteful background.";
  const platformSection = platform
    ? `\n\n--- PLATFORM AESTHETIC ---\n${platformGuidance(platform)}\n--- END PLATFORM AESTHETIC ---`
    : "";
  const extra = customPrompt?.trim();
  return `${base}${platformSection}${extra ? ` ${extra}` : ""}`;
}

export function generateOutfitDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "generate_outfit",
    description:
      "Virtual try-on: compose a model photo (Image 1), a garment (Image 2), and a MediaPipe Holistic skeleton " +
      "overlay (Image 3) into a generated image. Dispatches to the selected image-edit models through " +
      "the chosen provider (kie | fal).",
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

      const prompt = buildOutfitPrompt(a.custom_prompt, a.platform);
      const image_slugs = [
        withAt(a.model_image_slug),
        withAt(a.garment_image_slug),
        withAt(a.pose_image_slug),
      ];

      const outcomes: EnqueueOutcome[] = [];
      for (const model of a.models) {
        const factory = DISPATCH[provider][model];
        const outcome: EnqueueOutcome = { model, provider, prompt };
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
