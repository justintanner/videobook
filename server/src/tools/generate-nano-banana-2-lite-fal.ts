import type { Engine } from "videobook-engine";
import { z, type ZodRawShape } from "zod";
import { FalNanoBanana2LiteTextToImageRequestSchema } from "@apicity/fal/zod";
import { queue } from "../queue.js";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { slugify } from "./_fal-shared.js";
import { apicityField, apicityStringField } from "./schema-from-apicity.js";

const base = FalNanoBanana2LiteTextToImageRequestSchema.shape;

const schema = {
  project_slug: z.string().describe("Project slug"),
  prompt: apicityStringField(base.prompt, "Text prompt for image generation", { required: true }),
  num_images: apicityField(base.num_images, "Number of images to generate"),
  aspect_ratio: apicityField(base.aspect_ratio, "Aspect ratio"),
  output_format: apicityField(base.output_format, "Output image format"),
  safety_tolerance: apicityField(base.safety_tolerance, "Safety tolerance 1-6"),
  thinking_level: apicityField(base.thinking_level, "Thinking level (minimal/high)"),
  seed: apicityField(base.seed, "Seed for deterministic output"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof schema>;

export function generateNanoBanana2LiteFalDef(fs: Engine): ToolDef {
  return {
    name: "generate_fal_nano_banana_2_lite_text_to_image",
    description: "Generate an image via fal.ai using Google Nano Banana 2 Lite from a text prompt. Creates a new img- asset and enqueues a background job.",
    schema,
    handler: async (args) => {
      const { project_slug, prompt, num_images, aspect_ratio, output_format, safety_tolerance, thinking_level, seed } = args as Args;

      if (!process.env.FAL_API_KEY) {
        return { isError: true as const, content: [{ type: "text" as const, text: "FAL_API_KEY environment variable is not set" }] };
      }

      const assetResult = await fs.artifacts.create("img", `nano-banana-2-lite-${slugify(prompt) || String(Date.now())}`, project_slug);
      if (!assetResult.ok) return { isError: true as const, content: [{ type: "text" as const, text: `Failed to create image asset: ${assetResult.error.message}` }] };

      const { slug: imgAssetId, path: imgAssetDir } = assetResult.value;

      const jobId = `fal-nano-banana-2-lite-${imgAssetId}-${Date.now()}`;
      await queue.enqueue(jobId, {
        type: "generate_nano_banana_2_lite_fal",
        imgAssetId,
        imgAssetDir,
        projectSlug: project_slug,
        prompt,
        ...(num_images !== undefined ? { num_images } : {}),
        ...(aspect_ratio !== undefined ? { aspect_ratio } : {}),
        ...(output_format !== undefined ? { output_format } : {}),
        ...(safety_tolerance !== undefined ? { safety_tolerance } : {}),
        ...(thinking_level !== undefined ? { thinking_level } : {}),
        ...(seed !== undefined ? { seed } : {}),
      } as unknown as Record<string, unknown>);

      return { content: [{ type: "text" as const, text: JSON.stringify({ img_asset_id: imgAssetId, job_id: jobId, status: "enqueued" }) }] };
    },
  };
}
