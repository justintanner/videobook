import type { VideocityFs } from "videobook-engine";
import { z, type ZodRawShape } from "zod";
import { FalWanV2p7TextToImageRequestSchema } from "@apicity/fal/zod";
import { queue } from "../queue.js";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { slugify } from "./_fal-shared.js";
import { modelSlug } from "@apicity/cost";
import { apicityField, apicityStringField, apicityUnionEnumField } from "./schema-from-apicity.js";

const wan = FalWanV2p7TextToImageRequestSchema.shape;

const schema = {
  project_slug: z.string().describe("Project slug"),
  prompt: apicityStringField(wan.prompt, "Text prompt for image generation", { required: true }),
  negative_prompt: apicityStringField(wan.negative_prompt, "Negative prompt"),
  image_size: apicityUnionEnumField(wan.image_size, "Output size preset"),
  max_images: apicityField(wan.max_images, "Max images returned (1-5)"),
  seed: apicityField(wan.seed, "Seed for deterministic output"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof schema>;

export function generateWan27ProFalDef(fs: VideocityFs): ToolDef {
  return {
    name: "generate_fal_wan_2_7_pro_text_to_image",
    description: "Generate an image via fal.ai using Wan 2.7 Pro text-to-image (higher quality variant). Creates a new img- asset and enqueues a background job.",
    schema,
    handler: async (args) => {
      const { project_slug, prompt, negative_prompt, image_size, max_images, seed } = args as Args;

      if (!process.env.FAL_API_KEY) {
        return { isError: true as const, content: [{ type: "text" as const, text: "FAL_API_KEY environment variable is not set" }] };
      }

      const assetResult = await fs.createAsset("img", `${modelSlug("kie", "wan/2-7-image-pro")}-${slugify(prompt) || String(Date.now())}`, project_slug);
      if (!assetResult.ok) return { isError: true as const, content: [{ type: "text" as const, text: `Failed to create image asset: ${assetResult.error.message}` }] };

      const { assetId: imgAssetId, path: imgAssetDir } = assetResult.value;

      const jobId = `fal-${modelSlug("kie", "wan/2-7-image-pro")}-${imgAssetId}-${Date.now()}`;
      await queue.enqueue(jobId, {
        type: "generate_wan27_pro_fal",
        imgAssetId,
        imgAssetDir,
        projectSlug: project_slug,
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
