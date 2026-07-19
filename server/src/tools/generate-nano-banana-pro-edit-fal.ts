import type { VideocityFs } from "videocity-engine";
import { modelSlug } from "@apicity/cost";
import { z, type ZodRawShape } from "zod";
import { FalNanoBananaProEditRequestSchema } from "@apicity/fal/zod";
import { queue } from "../queue.js";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { resolveImageSlugs, slugify } from "./_fal-shared.js";
import { apicityField, apicityStringArrayField, apicityStringField } from "./schema-from-apicity.js";

const base = FalNanoBananaProEditRequestSchema.shape;

const schema = {
  project_slug: z.string().describe("Project slug"),
  prompt: apicityStringField(base.prompt, "Edit instruction", { required: true }),
  image_slugs: apicityStringArrayField(base.image_urls, "1-14 @img-* slugs for reference images", { required: true }).min(1).max(14),
  num_images: z.number().int().min(1).max(4).optional().describe("Number of images to generate (1-4)"),
  aspect_ratio: apicityField(base.aspect_ratio, "Aspect ratio"),
  resolution: apicityField(base.resolution, "Output resolution (1K/2K/4K)"),
  output_format: apicityField(base.output_format, "Output image format"),
  seed: z.number().int().optional().describe("Seed for deterministic output"),
  enable_web_search: apicityField(base.enable_web_search, "Enable web search grounding"),

} satisfies ZodRawShape;

type Args = SchemaArgs<typeof schema>;

export function generateNanoBananaProEditFalDef(fs: VideocityFs): ToolDef {
  return {
    name: "generate_nano_banana_pro_edit_fal",
    description: "Edit or compose images via fal.ai using Google Nano Banana Pro with one or more @img-* reference inputs. Creates a new img- asset and enqueues a background job.",
    schema,
    handler: async (args) => {
      const { project_slug, prompt, image_slugs, num_images, aspect_ratio, resolution, output_format, seed, enable_web_search } = args as Args;
      const prefix = "img";

      if (!process.env.FAL_API_KEY) {
        return { isError: true as const, content: [{ type: "text" as const, text: "FAL_API_KEY environment variable is not set" }] };
      }

      const resolved = await resolveImageSlugs(fs, image_slugs, project_slug);
      if (!resolved.ok) return { isError: true as const, content: [{ type: "text" as const, text: resolved.error }] };

      const assetResult = await fs.createAsset(prefix, `${modelSlug("kie", "nano-banana-pro")}-${slugify(prompt) || String(Date.now())}`, project_slug);
      if (!assetResult.ok) return { isError: true as const, content: [{ type: "text" as const, text: `Failed to create image asset: ${assetResult.error.message}` }] };

      const { assetId: imgAssetId, path: imgAssetDir } = assetResult.value;

      const jobId = `fal-${modelSlug("kie", "nano-banana-pro")}-edit-${imgAssetId}-${Date.now()}`;
      await queue.enqueue(jobId, {
        type: "generate_nano_banana_pro_edit_fal",
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
        ...(seed !== undefined ? { seed } : {}),
        ...(enable_web_search !== undefined ? { enable_web_search } : {}),
      } as unknown as Record<string, unknown>);

      return { content: [{ type: "text" as const, text: JSON.stringify({ img_asset_id: imgAssetId, source_images: resolved.sourceImageIds, job_id: jobId, status: "enqueued" }) }] };
    },
  };
}
