import type { VideocityFs } from "vc-engine";
import { z, type ZodRawShape } from "zod";
import { queue } from "../queue.js";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { slugify } from "./_fal-shared.js";
import { modelSlug } from "@apicity/cost";

const QWEN_IMAGE_SIZES = ["square_hd", "square", "portrait_4_3", "portrait_16_9", "landscape_4_3", "landscape_16_9"] as const;
const QWEN_OUTPUT_FORMATS = ["jpeg", "png"] as const;
const QWEN_ACCELERATION = ["none", "regular", "high"] as const;

const schema = {
  project_slug: z.string().describe("Project slug"),
  prompt: z.string().describe("Text prompt for image generation"),
  image_size: z.enum(QWEN_IMAGE_SIZES).optional().describe("Output size preset"),
  num_inference_steps: z.number().int().min(2).max(250).optional().describe("Inference steps (2-250)"),
  guidance_scale: z.number().min(0).max(20).optional().describe("Guidance scale (0-20)"),
  num_images: z.number().int().min(1).max(4).optional().describe("Number of images (1-4)"),
  output_format: z.enum(QWEN_OUTPUT_FORMATS).optional().describe("Output image format"),
  negative_prompt: z.string().optional().describe("Negative prompt"),
  acceleration: z.enum(QWEN_ACCELERATION).optional().describe("Acceleration level"),
  enable_safety_checker: z.boolean().optional().describe("Enable safety checker"),
  use_turbo: z.boolean().optional().describe("Use turbo mode"),
  seed: z.number().int().optional().describe("Seed for deterministic output"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof schema>;

export function generateQwenImageFalDef(fs: VideocityFs): ToolDef {
  return {
    name: "generate_qwen_image_fal",
    description: "Generate an image via fal.ai using Alibaba Qwen Image from a text prompt. Creates a new img- asset and enqueues a background job.",
    schema,
    handler: async (args) => {
      const { project_slug, prompt, image_size, num_inference_steps, guidance_scale, num_images, output_format, negative_prompt, acceleration, enable_safety_checker, use_turbo, seed } = args as Args;

      if (!process.env.FAL_API_KEY) {
        return { isError: true as const, content: [{ type: "text" as const, text: "FAL_API_KEY environment variable is not set" }] };
      }

      const assetResult = await fs.createAsset("img", `${modelSlug("kie", "qwen2/text-to-image")}-${slugify(prompt) || String(Date.now())}`, project_slug);
      if (!assetResult.ok) return { isError: true as const, content: [{ type: "text" as const, text: `Failed to create image asset: ${assetResult.error.message}` }] };

      const { assetId: imgAssetId, path: imgAssetDir } = assetResult.value;

      const jobId = `fal-${modelSlug("kie", "qwen2/text-to-image")}-${imgAssetId}-${Date.now()}`;
      await queue.enqueue(jobId, {
        type: "generate_qwen_image_fal",
        imgAssetId,
        imgAssetDir,
        projectSlug: project_slug,
        prompt,
        ...(image_size !== undefined ? { image_size } : {}),
        ...(num_inference_steps !== undefined ? { num_inference_steps } : {}),
        ...(guidance_scale !== undefined ? { guidance_scale } : {}),
        ...(num_images !== undefined ? { num_images } : {}),
        ...(output_format !== undefined ? { output_format } : {}),
        ...(negative_prompt !== undefined ? { negative_prompt } : {}),
        ...(acceleration !== undefined ? { acceleration } : {}),
        ...(enable_safety_checker !== undefined ? { enable_safety_checker } : {}),
        ...(use_turbo !== undefined ? { use_turbo } : {}),
        ...(seed !== undefined ? { seed } : {}),
      } as unknown as Record<string, unknown>);

      return { content: [{ type: "text" as const, text: JSON.stringify({ img_asset_id: imgAssetId, job_id: jobId, status: "enqueued" }) }] };
    },
  };
}
