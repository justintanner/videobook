import type { Engine } from "videobook-engine";
import { z, type ZodRawShape } from "zod";
import { FalWanV2p7TextToImageRequestSchema } from "@apicity/fal/zod";
import { queue } from "../queue.js";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { modelSlug } from "@apicity/cost";
import { apicityField, apicityStringField, apicityUnionEnumField } from "./schema-from-apicity.js";
import { generationLabel } from "../artifact-label.js";

const wan = FalWanV2p7TextToImageRequestSchema.shape;

const schema = {
  book_id: z.string().describe("Book id"),
  prompt: apicityStringField(wan.prompt, "Text prompt for image generation", { required: true }),
  negative_prompt: apicityStringField(wan.negative_prompt, "Negative prompt"),
  image_size: apicityUnionEnumField(wan.image_size, "Output size preset"),
  max_images: apicityField(wan.max_images, "Max images returned (1-5)"),
  seed: apicityField(wan.seed, "Seed for deterministic output"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof schema>;

export function generateWan27FalDef(fs: Engine): ToolDef {
  return {
    name: "generate_fal_wan_2_7_text_to_image",
    description: "Generate an image via fal.ai using Wan 2.7 text-to-image. Creates a new image artifact and enqueues a background job.",
    schema,
    handler: async (args) => {
      const { book_id, prompt, negative_prompt, image_size, max_images, seed } = args as Args;

      if (!process.env.FAL_API_KEY) {
        return { isError: true as const, content: [{ type: "text" as const, text: "FAL_API_KEY environment variable is not set" }] };
      }

      const assetResult = await fs.artifacts.create("img", generationLabel(modelSlug("kie", "wan/2-7-image"), prompt));
      if (!assetResult.ok) return { isError: true as const, content: [{ type: "text" as const, text: `Failed to create image asset: ${assetResult.error.message}` }] };

      const { artifactId: imgAssetId, path: imgAssetDir } = assetResult.value;

      const jobId = `fal-${modelSlug("kie", "wan/2-7-image")}-${imgAssetId}-${Date.now()}`;
      await queue.enqueue(jobId, {
        type: "generate_wan27_fal",
        imgAssetId,
        imgAssetDir,
        bookId: book_id,
        prompt,
        ...(negative_prompt !== undefined ? { negative_prompt } : {}),
        ...(image_size !== undefined ? { image_size } : {}),
        ...(max_images !== undefined ? { max_images } : {}),
        ...(seed !== undefined ? { seed } : {}),
      } as unknown as Record<string, unknown>);

      return { content: [{ type: "text" as const, text: JSON.stringify({ img_asset_id: imgAssetId, job_id: jobId, status: "enqueued" }) }] };
    },
  };
}
