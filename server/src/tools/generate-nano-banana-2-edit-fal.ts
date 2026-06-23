import type { VideocityFs } from "videocity-engine";
import { modelSlug } from "@apicity/cost";
import { z, type ZodRawShape } from "zod";
import { FalNanoBanana2EditRequestSchema } from "@apicity/fal/zod";
import { queue } from "../queue.js";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { resolveImageSlugs, slugify } from "./_fal-shared.js";
import { apicityField } from "./schema-from-apicity.js";

const base = FalNanoBanana2EditRequestSchema.shape;

const schema = {
  project_slug: z.string().describe("Project slug"),
  prompt: z.string().describe("Edit instruction"),
  image_slugs: z.array(z.string()).min(1).describe("1 or more @img-* slugs for reference images"),
  num_images: z.number().int().optional().describe("Number of images to generate"),
  aspect_ratio: apicityField(base.aspect_ratio, "Aspect ratio"),
  resolution: apicityField(base.resolution, "Output resolution"),
  output_format: apicityField(base.output_format, "Output image format"),
  safety_tolerance: apicityField(base.safety_tolerance, "Safety tolerance 1-6"),
  thinking_level: apicityField(base.thinking_level, "Thinking level (minimal/high)"),
  enable_web_search: z.boolean().optional().describe("Enable web search grounding"),
  seed: z.number().optional().describe("Seed for deterministic output"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof schema>;

export function generateNanoBanana2EditFalDef(fs: VideocityFs): ToolDef {
  return {
    name: "generate_nano_banana_2_edit_fal",
    description: "Edit images via fal.ai using Google Nano Banana 2 with one or more @img-* reference inputs. Creates a new img- asset and enqueues a background job.",
    schema,
    handler: async (args) => {
      const { project_slug, prompt, image_slugs, num_images, aspect_ratio, resolution, output_format, safety_tolerance, thinking_level, enable_web_search, seed } = args as Args;

      if (!process.env.FAL_API_KEY) {
        return { isError: true as const, content: [{ type: "text" as const, text: "FAL_API_KEY environment variable is not set" }] };
      }

      const resolved = await resolveImageSlugs(fs, image_slugs, project_slug);
      if (!resolved.ok) return { isError: true as const, content: [{ type: "text" as const, text: resolved.error }] };

      const assetResult = await fs.createAsset("img", `${modelSlug("kie", "nano-banana-2")}-${slugify(prompt) || String(Date.now())}`, project_slug);
      if (!assetResult.ok) return { isError: true as const, content: [{ type: "text" as const, text: `Failed to create image asset: ${assetResult.error.message}` }] };

      const { assetId: imgAssetId, path: imgAssetDir } = assetResult.value;

      const jobId = `fal-${modelSlug("kie", "nano-banana-2")}-edit-${imgAssetId}-${Date.now()}`;
      await queue.enqueue(jobId, {
        type: "generate_nano_banana_2_edit_fal",
        imgAssetId,
        imgAssetDir,
        projectSlug: project_slug,
        prompt,
        imageInputs: resolved.inputs,
        sourceImageIds: resolved.sourceImageIds,
        ...(num_images !== undefined ? { num_images } : {}),
        ...(aspect_ratio !== undefined ? { aspect_ratio } : {}),
        ...(resolution !== undefined ? { resolution } : {}),
        ...(output_format !== undefined ? { output_format } : {}),
        ...(safety_tolerance !== undefined ? { safety_tolerance } : {}),
        ...(thinking_level !== undefined ? { thinking_level } : {}),
        ...(enable_web_search !== undefined ? { enable_web_search } : {}),
        ...(seed !== undefined ? { seed } : {}),
      } as unknown as Record<string, unknown>);

      return { content: [{ type: "text" as const, text: JSON.stringify({ img_asset_id: imgAssetId, source_images: resolved.sourceImageIds, job_id: jobId, status: "enqueued" }) }] };
    },
  };
}
