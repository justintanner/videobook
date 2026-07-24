import { modelSlug } from "@apicity/cost";
import type { Engine } from "videobook-engine";
import { z, type ZodRawShape } from "zod";
import { Wan27ImageInputSchema } from "@apicity/kie/zod";
import { queue } from "../queue.js";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { resolveImageSlugs } from "./_image-inputs.js";
import { apicityField, apicityStringArrayField, apicityStringField } from "./schema-from-apicity.js";

const wan27ImageInput = Wan27ImageInputSchema.shape;

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 30)
    .replace(/-$/, "");
}

const generateWan27ImageProSchema = {
  prompt: apicityStringField(wan27ImageInput.prompt, "Text prompt for image generation (max 5000 chars)", { required: true }),
  project_slug: z.string().describe("Project slug"),
  image_slugs: apicityStringArrayField(wan27ImageInput.input_urls, "0-9 @img-* slugs for reference images"),
  aspect_ratio: apicityField(wan27ImageInput.aspect_ratio, "Output aspect ratio (default 16:9)"),
  resolution: apicityField(wan27ImageInput.resolution, "Output resolution (default 2K)"),
  seed: apicityField(wan27ImageInput.seed, "Random seed (0-2147483647)"),
  n: apicityField(wan27ImageInput.n, "Number of images to generate (1-4)"),
  enable_sequential: apicityField(wan27ImageInput.enable_sequential, "Enable sequential generation mode"),
  thinking_mode: apicityField(wan27ImageInput.thinking_mode, "Enable thinking mode for better quality"),
  color_palette: apicityField(wan27ImageInput.color_palette, "Target color palette"),
  bbox_list: apicityField(wan27ImageInput.bbox_list, "Bounding boxes for region control"),
  watermark: apicityField(wan27ImageInput.watermark, "Add watermark to generated image"),
  nsfw_checker: apicityField(wan27ImageInput.nsfw_checker, "Content safety filter (default false)"),

  _provider: z.string().optional().describe("Provider key (e.g., 'kie')"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof generateWan27ImageProSchema>;

export function generateWan27ImageProDef(fs: Engine): ToolDef {
  return {
    name: "generate_kie_wan_2_7_pro_text_to_image",
    description: "Generate an image using Wan 2.7 Image Pro. Creates a new img- asset and enqueues a background job. Prompt is required; reference images are optional (0-9).",
    schema: generateWan27ImageProSchema,
    handler: async (args) => {
      const { prompt, project_slug, image_slugs, aspect_ratio, resolution, seed, nsfw_checker } = args as Args;
      const prefix = "img";

      const rawSlugs = image_slugs ?? [];

      if (!process.env.KIE_API_KEY) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "KIE_API_KEY environment variable is not set" }],
        };
      }

      if (rawSlugs.length > 9) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "Maximum 9 reference images allowed" }],
        };
      }

      const resolved = await resolveImageSlugs(fs, rawSlugs, project_slug);
      if (!resolved.ok) {
        return { isError: true as const, content: [{ type: "text" as const, text: resolved.error }] };
      }
      const { inputs: imageInputs, sourceImageIds } = resolved;

      const assetName = `${modelSlug("kie", "wan/2-7-image-pro")}-${slugify(prompt) || String(Date.now())}`;
      const assetResult = await fs.artifacts.create(prefix, assetName, project_slug);
      if (!assetResult.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Failed to create image asset: ${assetResult.error.message}` }],
        };
      }

      const { slug: imgAssetId, path: imgAssetDir } = assetResult.value;

      const jobId = `${modelSlug("kie", "wan/2-7-image-pro")}-${imgAssetId}-${Date.now()}`;

      await queue.enqueue(jobId, {
        type: "generate_wan27_image_pro",
        prompt,
        imageInputs,
        imgAssetId,
        imgAssetDir,
        sourceImageIds,
        projectSlug: project_slug,
        ...(aspect_ratio !== undefined ? { aspectRatio: aspect_ratio } : {}),
        ...(resolution !== undefined ? { resolution } : {}),
        ...(seed !== undefined ? { seed } : {}),
        ...(nsfw_checker !== undefined ? { nsfwChecker: nsfw_checker } : {}),
      } as unknown as Record<string, unknown>);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            img_asset_id: imgAssetId,
            job_id: jobId,
            status: "enqueued",
          }),
        }],
      };
    },
  };
}
