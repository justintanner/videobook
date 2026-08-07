import type { Engine } from "videobook-engine";
import { modelSlug } from "@apicity/cost";
import { z, type ZodRawShape } from "zod";
import { FalSeedreamV5LiteEditRequestSchema } from "@apicity/fal/zod";
import { queue } from "../queue.js";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { resolveImageRefs } from "./_fal-shared.js";
import { apicityField, apicityStringArrayField, apicityStringField } from "./schema-from-apicity.js";
import { generationLabel } from "../artifact-label.js";

const seedream = FalSeedreamV5LiteEditRequestSchema.shape;

const schema = {
  book_id: z.string().describe("Book id"),
  prompt: apicityStringField(seedream.prompt, "Edit instruction", { required: true }),
  image_refs: apicityStringArrayField(seedream.image_urls, "1-10 image artifact ids for reference images", { required: true }),
  image_size: apicityField(seedream.image_size, "Output size preset (auto_4K selects 4K)"),
  num_images: apicityField(seedream.num_images, "Number of images to generate"),
  max_images: apicityField(seedream.max_images, "Max images returned"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof schema>;

export function generateSeedreamV5LiteEditFalDef(fs: Engine): ToolDef {
  return {
    name: "generate_fal_seedream_v5_lite_edit_image",
    description: "Edit or compose images via fal.ai using ByteDance Seedream V5 Lite with one or more image artifact reference inputs. Creates a new image artifact and enqueues a background job.",
    schema,
    handler: async (args) => {
      const { book_id, prompt, image_refs, image_size, num_images, max_images } = args as Args;
      const prefix = "img";

      if (!process.env.FAL_API_KEY) {
        return { isError: true as const, content: [{ type: "text" as const, text: "FAL_API_KEY environment variable is not set" }] };
      }

      const resolved = await resolveImageRefs(fs, image_refs, book_id);
      if (!resolved.ok) return { isError: true as const, content: [{ type: "text" as const, text: resolved.error }] };

      const assetResult = await fs.artifacts.create(prefix, generationLabel(modelSlug("kie", "seedream/5-lite-image-to-image"), prompt));
      if (!assetResult.ok) return { isError: true as const, content: [{ type: "text" as const, text: `Failed to create image asset: ${assetResult.error.message}` }] };

      const { artifactId: imgAssetId, path: imgAssetDir } = assetResult.value;

      const jobId = `fal-${modelSlug("kie", "seedream/5-lite-image-to-image")}-edit-${imgAssetId}-${Date.now()}`;
      await queue.enqueue(jobId, {
        type: "generate_seedream_v5_lite_edit_fal",
        imgAssetId,
        imgAssetDir,
        bookId: book_id,
        prompt,
        imageInputs: resolved.inputs,
        sourceImageIds: resolved.sourceImageIds,
        ...(image_size !== undefined ? { image_size } : {}),
        ...(num_images !== undefined ? { num_images } : {}),
        ...(max_images !== undefined ? { max_images } : {}),
      } as unknown as Record<string, unknown>);

      return { content: [{ type: "text" as const, text: JSON.stringify({ img_asset_id: imgAssetId, source_images: resolved.sourceImageIds, job_id: jobId, status: "enqueued" }) }] };
    },
  };
}
