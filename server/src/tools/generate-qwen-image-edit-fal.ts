import type { ClipfirstFs } from "clipfirst-fs";
import { z, type ZodRawShape } from "zod";
import { FalQwenImageEditRequestSchema } from "@apicity/fal/zod";
import { queue } from "../queue.js";
import { writePendingTask, QUEUED_TASK_ID } from "../jobs/pending-task.js";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { resolveImageSlugs, slugify } from "./_fal-shared.js";

const base = FalQwenImageEditRequestSchema.shape;

// `image_size` upstream is a union of (enum | {width,height}). Only the enum branch is
// exposed here; custom width/height isn't wired through the UI.
const falImageSizeEnum = (base.image_size.unwrap().options as readonly z.ZodTypeAny[])
  .find((opt): opt is z.ZodEnum<[string, ...string[]]> => opt instanceof z.ZodEnum);
if (!falImageSizeEnum) throw new Error("FalQwenImageEditRequestSchema.image_size changed shape");
const falImageSizeOptions = falImageSizeEnum.options as readonly [string, ...string[]];
type FalImageSize = typeof falImageSizeOptions[number];

const outputFormatOptions = base.output_format.unwrap().options as readonly [string, ...string[]];
const accelerationOptions = base.acceleration.unwrap().options as readonly [string, ...string[]];

// The UI sends the Kie-canonical aspect-ratio strings (matching Qwen2ImageEditRequestSchema
// on Kie). Accept either those or the Fal enum, then normalize to the Fal enum for the job.
const KIE_ASPECT_RATIOS = ["1:1", "2:3", "3:2", "3:4", "4:3", "9:16", "16:9", "21:9"] as const;
const ACCEPTED_IMAGE_SIZES = [...falImageSizeOptions, ...KIE_ASPECT_RATIOS] as [string, ...string[]];

const KIE_TO_FAL_IMAGE_SIZE: Record<typeof KIE_ASPECT_RATIOS[number], FalImageSize> = {
  "1:1": "square_hd",
  "2:3": "portrait_4_3",
  "3:2": "landscape_4_3",
  "3:4": "portrait_4_3",
  "4:3": "landscape_4_3",
  "9:16": "portrait_16_9",
  "16:9": "landscape_16_9",
  "21:9": "landscape_16_9",
};

function normalizeImageSize(value: string | undefined): FalImageSize | undefined {
  if (!value) return undefined;
  if ((falImageSizeOptions as readonly string[]).includes(value)) return value as FalImageSize;
  return KIE_TO_FAL_IMAGE_SIZE[value as typeof KIE_ASPECT_RATIOS[number]];
}

const schema = {
  project_slug: z.string().describe("Project slug"),
  prompt: z.string().describe("Edit instruction"),
  image_slugs: z.array(z.string()).min(1).describe("@img-* slug for the reference image (first entry is used; Qwen edit takes one image)"),
  image_size: z.enum(ACCEPTED_IMAGE_SIZES).optional().describe("Output size — Fal enum (square_hd, landscape_16_9, ...) or aspect-ratio shorthand (1:1, 16:9, 9:16, 4:3, 3:4, ...)"),
  num_inference_steps: z.number().int().min(2).max(50).optional().describe("Inference steps (2-50)"),
  guidance_scale: z.number().min(0).max(20).optional().describe("Guidance scale (0-20)"),
  num_images: z.number().int().min(1).max(4).optional().describe("Number of images (1-4)"),
  output_format: z.enum(outputFormatOptions).optional().describe("Output image format"),
  negative_prompt: z.string().optional().describe("Negative prompt"),
  acceleration: z.enum(accelerationOptions).optional().describe("Acceleration level"),
  enable_safety_checker: z.boolean().optional().describe("Enable safety checker"),
  seed: z.number().int().optional().describe("Seed for deterministic output"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof schema>;

export function generateQwenImageEditFalDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "generate_qwen_image_edit_fal",
    description: "Edit an image via fal.ai using Alibaba Qwen Image edit with one @img-* reference input. Creates a new img- asset and enqueues a background job.",
    schema,
    handler: async (args) => {
      const { project_slug, prompt, image_slugs, image_size, num_inference_steps, guidance_scale, num_images, output_format, negative_prompt, acceleration, enable_safety_checker, seed } = args as Args;

      if (!process.env.FAL_API_KEY) {
        return { isError: true as const, content: [{ type: "text" as const, text: "FAL_API_KEY environment variable is not set" }] };
      }

      const [firstSlug] = image_slugs;
      const resolved = await resolveImageSlugs(fs, [firstSlug], project_slug);
      if (!resolved.ok) return { isError: true as const, content: [{ type: "text" as const, text: resolved.error }] };

      const [refImage] = resolved.inputs;
      const normalizedSize = normalizeImageSize(image_size);

      const assetResult = await fs.createAsset("img", `qwen-image-edit-${slugify(prompt) || String(Date.now())}`, project_slug);
      if (!assetResult.ok) return { isError: true as const, content: [{ type: "text" as const, text: `Failed to create image asset: ${assetResult.error.message}` }] };

      const { assetId: imgAssetId, path: imgAssetDir } = assetResult.value;

      await writePendingTask(fs, imgAssetId, project_slug, {
        taskId: QUEUED_TASK_ID,
        taskType: "fal_qwen_image_edit",
        assetId: imgAssetId,
        assetDir: imgAssetDir,
        projectSlug: project_slug,
        createdAt: new Date().toISOString(),
        meta: { prompt, sourceImageIds: resolved.sourceImageIds },
      });

      const jobId = `fal-qwen-image-edit-${imgAssetId}-${Date.now()}`;
      await queue.enqueue(jobId, {
        type: "generate_qwen_image_edit_fal",
        imgAssetId,
        imgAssetDir,
        projectSlug: project_slug,
        prompt,
        refImage,
        sourceImageIds: resolved.sourceImageIds,
        ...(normalizedSize !== undefined ? { image_size: normalizedSize } : {}),
        ...(num_inference_steps !== undefined ? { num_inference_steps } : {}),
        ...(guidance_scale !== undefined ? { guidance_scale } : {}),
        ...(num_images !== undefined ? { num_images } : {}),
        ...(output_format !== undefined ? { output_format } : {}),
        ...(negative_prompt !== undefined ? { negative_prompt } : {}),
        ...(acceleration !== undefined ? { acceleration } : {}),
        ...(enable_safety_checker !== undefined ? { enable_safety_checker } : {}),
        ...(seed !== undefined ? { seed } : {}),
      } as unknown as Record<string, unknown>);

      return { content: [{ type: "text" as const, text: JSON.stringify({ img_asset_id: imgAssetId, source_images: resolved.sourceImageIds, job_id: jobId, status: "enqueued" }) }] };
    },
  };
}
