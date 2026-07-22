import type { VideocityFs } from "videocity-engine";
import { z, type ZodRawShape } from "zod";
import { FalQwenImageRequestSchema } from "@apicity/fal/zod";
import { queue } from "../queue.js";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { slugify } from "./_fal-shared.js";
import { modelSlug } from "@apicity/cost";
import {
  apicityField,
  apicityStringField,
  apicityUnionEnumField,
} from "./schema-from-apicity.js";

const qwen = FalQwenImageRequestSchema.shape;

const schema = {
  project_slug: z.string().describe("Project slug"),
  prompt: apicityStringField(qwen.prompt, "Text prompt for image generation", { required: true }),
  image_size: apicityUnionEnumField(qwen.image_size, "Output size preset"),
  num_inference_steps: apicityField(qwen.num_inference_steps, "Inference steps (2-250)"),
  guidance_scale: apicityField(qwen.guidance_scale, "Guidance scale (0-20)"),
  num_images: apicityField(qwen.num_images, "Number of images (1-4)"),
  output_format: apicityField(qwen.output_format, "Output image format"),
  negative_prompt: apicityStringField(qwen.negative_prompt, "Negative prompt"),
  acceleration: apicityField(qwen.acceleration, "Acceleration level"),
  enable_safety_checker: apicityField(qwen.enable_safety_checker, "Enable safety checker"),
  use_turbo: apicityField(qwen.use_turbo, "Use turbo mode"),
  seed: apicityField(qwen.seed, "Seed for deterministic output"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof schema>;

export function generateQwenImageFalDef(fs: VideocityFs): ToolDef {
  return {
    name: "generate_fal_qwen_2_0_text_to_image",
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
