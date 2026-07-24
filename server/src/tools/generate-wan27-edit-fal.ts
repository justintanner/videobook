import type { Engine } from "videobook-engine";
import { modelSlug } from "@apicity/cost";
import { z, type ZodRawShape } from "zod";
import { FalWanV2p7EditRequestSchema } from "@apicity/fal/zod";
import { queue } from "../queue.js";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { resolveImageSlugs, slugify } from "./_fal-shared.js";
import {
  apicityField,
  apicityStringArrayField,
  apicityStringField,
  apicityUnionEnumField,
} from "./schema-from-apicity.js";

const wan = FalWanV2p7EditRequestSchema.shape;

const schema = {
  book_id: z.string().describe("Project slug"),
  prompt: apicityStringField(wan.prompt, "Edit instruction", { required: true }),
  image_slugs: apicityStringArrayField(wan.image_urls, "1-4 @img-* slugs for reference images", { required: true }),
  negative_prompt: apicityStringField(wan.negative_prompt, "Negative prompt"),
  image_size: apicityUnionEnumField(wan.image_size, "Output size preset"),
  num_images: apicityField(wan.num_images, "Number of images to generate (1-4)"),
  seed: apicityField(wan.seed, "Seed for deterministic output"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof schema>;

export function generateWan27EditFalDef(fs: Engine): ToolDef {
  return {
    name: "generate_fal_wan_2_7_edit_image",
    description: "Edit images via fal.ai using Wan 2.7 edit (image-to-image) with 1-4 @img-* reference inputs. Creates a new img- asset and enqueues a background job.",
    schema,
    handler: async (args) => {
      const { book_id, prompt, image_slugs, negative_prompt, image_size, num_images, seed } = args as Args;

      if (!process.env.FAL_API_KEY) {
        return { isError: true as const, content: [{ type: "text" as const, text: "FAL_API_KEY environment variable is not set" }] };
      }

      const resolved = await resolveImageSlugs(fs, image_slugs, book_id);
      if (!resolved.ok) return { isError: true as const, content: [{ type: "text" as const, text: resolved.error }] };

      const assetResult = await fs.artifacts.create("img", `${modelSlug("kie", "wan/2-7-image")}-${slugify(prompt) || String(Date.now())}`);
      if (!assetResult.ok) return { isError: true as const, content: [{ type: "text" as const, text: `Failed to create image asset: ${assetResult.error.message}` }] };

      const { slug: imgAssetId, path: imgAssetDir } = assetResult.value;

      const jobId = `fal-${modelSlug("kie", "wan/2-7-image")}-edit-${imgAssetId}-${Date.now()}`;
      await queue.enqueue(jobId, {
        type: "generate_wan27_edit_fal",
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
