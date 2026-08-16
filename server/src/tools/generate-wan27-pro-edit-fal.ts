import type { Engine } from "videobook-engine";
import { modelSlug } from "@apicity/cost";
import { z, type ZodRawShape } from "zod";
import { FalWanV2p7EditRequestSchema } from "@apicity/fal/zod";
import { queue } from "../queue.js";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { resolveImageRefs } from "./_fal-shared.js";
import {
  apicityField,
  apicityStringArrayField,
  apicityStringField,
  apicityUnionEnumField,
} from "./schema-from-apicity.js";
import { generationLabel } from "../artifact-label.js";

const wan = FalWanV2p7EditRequestSchema.shape;

const schema = {
  book_id: z.string().describe("Book id"),
  prompt: apicityStringField(wan.prompt, "Edit instruction", { required: true }),
  image_refs: apicityStringArrayField(wan.image_urls, "1-4 image artifact ids for reference images", { required: true }),
  negative_prompt: apicityStringField(wan.negative_prompt, "Negative prompt"),
  image_size: apicityUnionEnumField(wan.image_size, "Output size preset"),
  num_images: apicityField(wan.num_images, "Number of images to generate (1-4)"),
  seed: apicityField(wan.seed, "Seed for deterministic output"),

} satisfies ZodRawShape;

type Args = SchemaArgs<typeof schema>;

export function generateWan27ProEditFalDef(fs: Engine): ToolDef {
  return {
    name: "generate_fal_wan_2_7_pro_edit_image",
    description: "Edit images via fal.ai using Wan 2.7 Pro edit (higher quality image-to-image) with 1-4 image artifact reference inputs. Creates a new image artifact and enqueues a background job.",
    schema,
    handler: async (args) => {
      const { book_id, prompt, image_refs, negative_prompt, image_size, num_images, seed } = args as Args;
      const prefix = "img";

      if (!process.env.FAL_API_KEY) {
        return { isError: true as const, content: [{ type: "text" as const, text: "FAL_API_KEY environment variable is not set" }] };
      }

      const resolved = await resolveImageRefs(fs, image_refs);
      if (!resolved.ok) return { isError: true as const, content: [{ type: "text" as const, text: resolved.error }] };

      const assetResult = await fs.artifacts.create(prefix, generationLabel(modelSlug("kie", "wan/2-7-image-pro"), prompt));
      if (!assetResult.ok) return { isError: true as const, content: [{ type: "text" as const, text: `Failed to create image asset: ${assetResult.error.message}` }] };

      const { artifactId: imgAssetId, path: imgAssetDir } = assetResult.value;

      const jobId = `fal-${modelSlug("kie", "wan/2-7-image-pro")}-edit-${imgAssetId}-${Date.now()}`;
      await queue.enqueue(jobId, {
        type: "generate_wan27_pro_edit_fal",
        imgAssetId,
        imgAssetDir,
        bookId: book_id,
        prompt,
        imageInputs: resolved.inputs,
        sourceImageIds: resolved.sourceImageIds,
        ...(negative_prompt !== undefined ? { negative_prompt } : {}),
        ...(image_size !== undefined ? { image_size } : {}),
        ...(num_images !== undefined ? { num_images } : {}),
        ...(seed !== undefined ? { seed } : {}),
      } as unknown as Record<string, unknown>);

      return { content: [{ type: "text" as const, text: JSON.stringify({ img_asset_id: imgAssetId, source_images: resolved.sourceImageIds, job_id: jobId, status: "enqueued" }) }] };
    },
  };
}
