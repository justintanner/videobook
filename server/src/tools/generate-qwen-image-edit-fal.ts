import type { ClipfirstFs } from "clipfirst-fs";
import { z, type ZodRawShape } from "zod";
import { queue } from "../queue.js";
import { writePendingTask, QUEUED_TASK_ID } from "../jobs/pending-task.js";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { resolveImageSlugs, slugify } from "./_fal-shared.js";

const QWEN_IMAGE_SIZES = ["square_hd", "square", "portrait_4_3", "portrait_16_9", "landscape_4_3", "landscape_16_9"] as const;
const QWEN_OUTPUT_FORMATS = ["jpeg", "png"] as const;
const QWEN_ACCELERATION = ["none", "regular", "high"] as const;

const schema = {
  project_slug: z.string().describe("Project slug"),
  prompt: z.string().describe("Edit instruction"),
  image_slug: z.string().describe("Single @img-* slug for the reference image"),
  image_size: z.enum(QWEN_IMAGE_SIZES).optional().describe("Output size preset"),
  num_inference_steps: z.number().int().min(2).max(50).optional().describe("Inference steps (2-50)"),
  guidance_scale: z.number().min(0).max(20).optional().describe("Guidance scale (0-20)"),
  num_images: z.number().int().min(1).max(4).optional().describe("Number of images (1-4)"),
  output_format: z.enum(QWEN_OUTPUT_FORMATS).optional().describe("Output image format"),
  negative_prompt: z.string().optional().describe("Negative prompt"),
  acceleration: z.enum(QWEN_ACCELERATION).optional().describe("Acceleration level"),
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
      const { project_slug, prompt, image_slug, image_size, num_inference_steps, guidance_scale, num_images, output_format, negative_prompt, acceleration, enable_safety_checker, seed } = args as Args;

      if (!process.env.FAL_API_KEY) {
        return { isError: true as const, content: [{ type: "text" as const, text: "FAL_API_KEY environment variable is not set" }] };
      }

      const resolved = await resolveImageSlugs(fs, [image_slug], project_slug);
      if (!resolved.ok) return { isError: true as const, content: [{ type: "text" as const, text: resolved.error }] };

      const [refImage] = resolved.inputs;
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
        ...(image_size !== undefined ? { image_size } : {}),
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
