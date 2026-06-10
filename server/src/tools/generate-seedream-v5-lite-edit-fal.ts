import type { VideocityFs } from "videocity-engine";
import { modelSlug } from "@apicity/cost";
import { z, type ZodRawShape } from "zod";
import { queue } from "../queue.js";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { resolveImageSlugs, slugify } from "./_fal-shared.js";

const schema = {
  project_slug: z.string().describe("Project slug"),
  prompt: z.string().describe("Edit instruction"),
  image_slugs: z.array(z.string()).min(1).describe("1 or more @img-* slugs for reference images"),
  image_size: z
    .enum([
      "square_hd",
      "square",
      "portrait_4_3",
      "portrait_16_9",
      "landscape_4_3",
      "landscape_16_9",
      "auto_2K",
      "auto_3K",
    ])
    .optional()
    .describe("Output size preset"),
  num_images: z.number().int().optional().describe("Number of images to generate"),
  max_images: z.number().int().optional().describe("Max images returned"),
  seed: z.number().optional().describe("Seed for deterministic output"),
  output_prefix: z.enum(["img", "char"]).optional().describe("Asset prefix for the output (default: img). Use 'char' to bundle into a character asset."),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof schema>;

export function generateSeedreamV5LiteEditFalDef(fs: VideocityFs): ToolDef {
  return {
    name: "generate_seedream_v5_lite_edit_fal",
    description: "Edit or compose images via fal.ai using ByteDance Seedream V5 Lite with one or more @img-* reference inputs. Creates a new img- asset and enqueues a background job.",
    schema,
    handler: async (args) => {
      const { project_slug, prompt, image_slugs, image_size, num_images, max_images, seed, output_prefix } = args as Args;
      const prefix = output_prefix ?? "img";

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
        ...(seed !== undefined ? { seed } : {}),
      } as unknown as Record<string, unknown>);

      return { content: [{ type: "text" as const, text: JSON.stringify({ img_asset_id: imgAssetId, source_images: resolved.sourceImageIds, job_id: jobId, status: "enqueued" }) }] };
    },
  };
}
