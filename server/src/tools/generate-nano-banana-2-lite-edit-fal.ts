import type { VideocityFs } from "videocity-engine";
import { z, type ZodRawShape } from "zod";
import { FalNanoBanana2LiteEditRequestSchema } from "@apicity/fal/zod";
import { queue } from "../queue.js";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { resolveImageSlugs, slugify } from "./_fal-shared.js";
import { apicityField } from "./schema-from-apicity.js";

const base = FalNanoBanana2LiteEditRequestSchema.shape;

const schema = {
  project_slug: z.string().describe("Project slug"),
  prompt: z.string().describe("Edit instruction"),
  image_slugs: z.array(z.string()).min(1).describe("1 or more @img-* slugs for reference images"),
  num_images: z.number().int().optional().describe("Number of images to generate"),
  aspect_ratio: apicityField(base.aspect_ratio, "Aspect ratio"),
  output_format: apicityField(base.output_format, "Output image format"),
  safety_tolerance: apicityField(base.safety_tolerance, "Safety tolerance 1-6"),
  thinking_level: apicityField(base.thinking_level, "Thinking level (minimal/high)"),
  seed: z.number().optional().describe("Seed for deterministic output"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof schema>;

export function generateNanoBanana2LiteEditFalDef(fs: VideocityFs): ToolDef {
  return {
    name: "generate_nano_banana_2_lite_edit_fal",
    description: "Edit images via fal.ai using Google Nano Banana 2 Lite with one or more @img-* reference inputs. Creates a new img- asset and enqueues a background job.",
    schema,
    handler: async (args) => {
      const { project_slug, prompt, image_slugs, num_images, aspect_ratio, output_format, safety_tolerance, thinking_level, seed } = args as Args;

      if (!process.env.FAL_API_KEY) {
        return { isError: true as const, content: [{ type: "text" as const, text: "FAL_API_KEY environment variable is not set" }] };
      }

      const resolved = await resolveImageSlugs(fs, image_slugs, project_slug);
      if (!resolved.ok) return { isError: true as const, content: [{ type: "text" as const, text: resolved.error }] };

      const assetResult = await fs.createAsset("img", `nano-banana-2-lite-edit-${slugify(prompt) || String(Date.now())}`, project_slug);
      if (!assetResult.ok) return { isError: true as const, content: [{ type: "text" as const, text: `Failed to create image asset: ${assetResult.error.message}` }] };

      const { assetId: imgAssetId, path: imgAssetDir } = assetResult.value;

      const jobId = `fal-nano-banana-2-lite-edit-${imgAssetId}-${Date.now()}`;
      await queue.enqueue(jobId, {
        type: "generate_nano_banana_2_lite_edit_fal",
        imgAssetId,
        imgAssetDir,
        projectSlug: project_slug,
        prompt,
        imageInputs: resolved.inputs,
        sourceImageIds: resolved.sourceImageIds,
        ...(num_images !== undefined ? { num_images } : {}),
        ...(aspect_ratio !== undefined ? { aspect_ratio } : {}),
        ...(output_format !== undefined ? { output_format } : {}),
        ...(safety_tolerance !== undefined ? { safety_tolerance } : {}),
        ...(thinking_level !== undefined ? { thinking_level } : {}),
        ...(seed !== undefined ? { seed } : {}),
      } as unknown as Record<string, unknown>);

      return { content: [{ type: "text" as const, text: JSON.stringify({ img_asset_id: imgAssetId, source_images: resolved.sourceImageIds, job_id: jobId, status: "enqueued" }) }] };
    },
  };
}
