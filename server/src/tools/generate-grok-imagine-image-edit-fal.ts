import type { VideocityFs } from "videocity-engine";
import { modelSlug } from "@apicity/cost";
import { z, type ZodRawShape } from "zod";
import { FalXaiGrokImagineImageEditRequestSchema } from "@apicity/fal/zod";
import { queue } from "../queue.js";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { resolveImageSlugs, slugify } from "./_fal-shared.js";
import { apicityField, apicityStringArrayField, apicityStringField } from "./schema-from-apicity.js";

const base = FalXaiGrokImagineImageEditRequestSchema.shape;

const schema = {
  project_slug: z.string().describe("Project slug"),
  prompt: apicityStringField(base.prompt, "Edit instruction", { required: true }),
  image_slugs: apicityStringArrayField(base.image_urls, "1-3 @img-* slugs for reference images", { required: true }).min(1),
  num_images: apicityField(base.num_images, "Number of images to generate (1-4)"),
  resolution: apicityField(base.resolution, "Output resolution"),
  output_format: apicityField(base.output_format, "Output image format"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof schema>;

export function generateGrokImagineImageEditFalDef(fs: VideocityFs): ToolDef {
  return {
    name: "generate_fal_grok_imagine_edit_image",
    description: "Edit images via fal.ai using xAI Grok Imagine Image edit with 1-3 @img-* reference inputs. Creates a new img- asset and enqueues a background job.",
    schema,
    handler: async (args) => {
      const { project_slug, prompt, image_slugs, num_images, resolution, output_format } = args as Args;

      if (!process.env.FAL_API_KEY) {
        return { isError: true as const, content: [{ type: "text" as const, text: "FAL_API_KEY environment variable is not set" }] };
      }

      const resolved = await resolveImageSlugs(fs, image_slugs, project_slug);
      if (!resolved.ok) return { isError: true as const, content: [{ type: "text" as const, text: resolved.error }] };

      const assetResult = await fs.createAsset("img", `${modelSlug("kie", "grok-imagine/image-to-image")}-${slugify(prompt) || String(Date.now())}`, project_slug);
      if (!assetResult.ok) return { isError: true as const, content: [{ type: "text" as const, text: `Failed to create image asset: ${assetResult.error.message}` }] };

      const { assetId: imgAssetId, path: imgAssetDir } = assetResult.value;

      const jobId = `fal-${modelSlug("kie", "grok-imagine/image-to-image")}-edit-${imgAssetId}-${Date.now()}`;
      await queue.enqueue(jobId, {
        type: "generate_grok_imagine_image_edit_fal",
        imgAssetId,
        imgAssetDir,
        projectSlug: project_slug,
        prompt,
        imageInputs: resolved.inputs,
        sourceImageIds: resolved.sourceImageIds,
        ...(num_images !== undefined ? { num_images } : {}),
        ...(resolution !== undefined ? { resolution } : {}),
        ...(output_format !== undefined ? { output_format } : {}),
      } as unknown as Record<string, unknown>);

      return { content: [{ type: "text" as const, text: JSON.stringify({ img_asset_id: imgAssetId, source_images: resolved.sourceImageIds, job_id: jobId, status: "enqueued" }) }] };
    },
  };
}
