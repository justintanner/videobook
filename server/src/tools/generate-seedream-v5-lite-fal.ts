import type { Engine } from "videobook-engine";
import { z, type ZodRawShape } from "zod";
import { FalSeedreamV5LiteTextToImageRequestSchema } from "@apicity/fal/zod";
import { queue } from "../queue.js";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { modelSlug } from "@apicity/cost";
import { apicityField, apicityStringField } from "./schema-from-apicity.js";
import { generationLabel } from "../artifact-label.js";

const seedream = FalSeedreamV5LiteTextToImageRequestSchema.shape;

const schema = {
  book_id: z.string().describe("Book id"),
  prompt: apicityStringField(seedream.prompt, "Text prompt for image generation", { required: true }),
  image_size: apicityField(seedream.image_size, "Output size preset (auto_4K selects 4K)"),
  num_images: apicityField(seedream.num_images, "Number of images to generate"),
  max_images: apicityField(seedream.max_images, "Max images returned"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof schema>;

export function generateSeedreamV5LiteFalDef(engine: Engine): ToolDef {
  return {
    name: "generate_fal_seedream_v5_lite_text_to_image",
    description: "Generate an image via fal.ai using ByteDance Seedream V5 Lite from a text prompt. Creates a new image artifact and enqueues a background job.",
    schema,
    handler: async (args) => {
      const { book_id, prompt, image_size, num_images, max_images } = args as Args;

      if (!process.env.FAL_API_KEY) {
        return { isError: true as const, content: [{ type: "text" as const, text: "FAL_API_KEY environment variable is not set" }] };
      }

      const assetResult = await engine.artifacts.create("img", generationLabel(modelSlug("kie", "seedream/5-lite-text-to-image"), prompt));
      if (!assetResult.ok) return { isError: true as const, content: [{ type: "text" as const, text: `Failed to create image asset: ${assetResult.error.message}` }] };

      const { artifactId: imgAssetId, path: imgAssetDir } = assetResult.value;

      const jobId = `fal-${modelSlug("kie", "seedream/5-lite-text-to-image")}-${imgAssetId}-${Date.now()}`;
      await queue.enqueue(jobId, {
        type: "generate_seedream_v5_lite_fal",
        imgAssetId,
        imgAssetDir,
        bookId: book_id,
        prompt,
        ...(image_size !== undefined ? { image_size } : {}),
        ...(num_images !== undefined ? { num_images } : {}),
        ...(max_images !== undefined ? { max_images } : {}),
      } as unknown as Record<string, unknown>);

      return { content: [{ type: "text" as const, text: JSON.stringify({ img_asset_id: imgAssetId, job_id: jobId, status: "enqueued" }) }] };
    },
  };
}
