import type { VideocityFs } from "videocity-engine";
import { z, type ZodRawShape } from "zod";
import { FalSeedreamV5LiteTextToImageRequestSchema } from "@apicity/fal/zod";
import { queue } from "../queue.js";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { slugify } from "./_fal-shared.js";
import { modelSlug } from "@apicity/cost";
import { apicityField, apicityStringField } from "./schema-from-apicity.js";

const seedream = FalSeedreamV5LiteTextToImageRequestSchema.shape;

const schema = {
  project_slug: z.string().describe("Project slug"),
  prompt: apicityStringField(seedream.prompt, "Text prompt for image generation", { required: true }),
  image_size: apicityField(seedream.image_size, "Output size preset"),
  auto_4K: apicityField(seedream.auto_4K, "Upscale output to 4K"),
  num_images: apicityField(seedream.num_images, "Number of images to generate"),
  max_images: apicityField(seedream.max_images, "Max images returned"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof schema>;

export function generateSeedreamV5LiteFalDef(fs: VideocityFs): ToolDef {
  return {
    name: "generate_seedream_v5_lite_fal",
    description: "Generate an image via fal.ai using ByteDance Seedream V5 Lite from a text prompt. Creates a new img- asset and enqueues a background job.",
    schema,
    handler: async (args) => {
      const { project_slug, prompt, image_size, auto_4K, num_images, max_images } = args as Args;

      if (!process.env.FAL_API_KEY) {
        return { isError: true as const, content: [{ type: "text" as const, text: "FAL_API_KEY environment variable is not set" }] };
      }

      const assetResult = await fs.createAsset("img", `${modelSlug("kie", "seedream/5-lite-text-to-image")}-${slugify(prompt) || String(Date.now())}`, project_slug);
      if (!assetResult.ok) return { isError: true as const, content: [{ type: "text" as const, text: `Failed to create image asset: ${assetResult.error.message}` }] };

      const { assetId: imgAssetId, path: imgAssetDir } = assetResult.value;

      const jobId = `fal-${modelSlug("kie", "seedream/5-lite-text-to-image")}-${imgAssetId}-${Date.now()}`;
      await queue.enqueue(jobId, {
        type: "generate_seedream_v5_lite_fal",
        imgAssetId,
        imgAssetDir,
        projectSlug: project_slug,
        prompt,
        ...(image_size !== undefined ? { image_size } : {}),
        ...(auto_4K !== undefined ? { auto_4K } : {}),
        ...(num_images !== undefined ? { num_images } : {}),
        ...(max_images !== undefined ? { max_images } : {}),
      } as unknown as Record<string, unknown>);

      return { content: [{ type: "text" as const, text: JSON.stringify({ img_asset_id: imgAssetId, job_id: jobId, status: "enqueued" }) }] };
    },
  };
}
