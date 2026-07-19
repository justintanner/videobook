import type { VideocityFs } from "videocity-engine";
import { modelSlug } from "@apicity/cost";
import { z, type ZodRawShape } from "zod";
import { FalSeedreamV5LiteEditRequestSchema } from "@apicity/fal/zod";
import { queue } from "../queue.js";
import { zodUnionEnumOptions } from "../zod-slots.js";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { resolveImageSlugs, slugify } from "./_fal-shared.js";
import { apicityStringArrayField, apicityStringField } from "./schema-from-apicity.js";

const seedream = FalSeedreamV5LiteEditRequestSchema.shape;
const publishedImageSizes = zodUnionEnumOptions(seedream.image_size);
if (!publishedImageSizes) throw new Error("FalSeedreamV5LiteEditRequestSchema.image_size changed shape");
const IMAGE_SIZES = [...publishedImageSizes, "auto_4K"] as [string, ...string[]];

const schema = {
  project_slug: z.string().describe("Project slug"),
  prompt: apicityStringField(seedream.prompt, "Edit instruction", { required: true }),
  image_slugs: apicityStringArrayField(seedream.image_urls, "1-10 @img-* slugs for reference images", { required: true }),
  image_size: z.enum(IMAGE_SIZES).optional().describe("Output size preset"),
  num_images: z.number().int().optional().describe("Number of images to generate"),
  max_images: z.number().int().optional().describe("Max images returned"),

} satisfies ZodRawShape;

type Args = SchemaArgs<typeof schema>;

export function generateSeedreamV5LiteEditFalDef(fs: VideocityFs): ToolDef {
  return {
    name: "generate_seedream_v5_lite_edit_fal",
    description: "Edit or compose images via fal.ai using ByteDance Seedream V5 Lite with one or more @img-* reference inputs. Creates a new img- asset and enqueues a background job.",
    schema,
    handler: async (args) => {
      const { project_slug, prompt, image_slugs, image_size, num_images, max_images } = args as Args;
      const prefix = "img";

      if (!process.env.FAL_API_KEY) {
        return { isError: true as const, content: [{ type: "text" as const, text: "FAL_API_KEY environment variable is not set" }] };
      }

      const resolved = await resolveImageSlugs(fs, image_slugs, project_slug);
      if (!resolved.ok) return { isError: true as const, content: [{ type: "text" as const, text: resolved.error }] };

      const assetResult = await fs.createAsset(prefix, `${modelSlug("kie", "seedream/5-lite-image-to-image")}-${slugify(prompt) || String(Date.now())}`, project_slug);
      if (!assetResult.ok) return { isError: true as const, content: [{ type: "text" as const, text: `Failed to create image asset: ${assetResult.error.message}` }] };

      const { assetId: imgAssetId, path: imgAssetDir } = assetResult.value;

      const jobId = `fal-${modelSlug("kie", "seedream/5-lite-image-to-image")}-edit-${imgAssetId}-${Date.now()}`;
      await queue.enqueue(jobId, {
        type: "generate_seedream_v5_lite_edit_fal",
        imgAssetId,
        imgAssetDir,
        projectSlug: project_slug,
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
