import { modelSlug } from "@apicity/cost";
import type { Engine } from "videobook-engine";
import { z, type ZodRawShape } from "zod";
import { Wan27ImageInputSchema } from "@apicity/kie/zod";
import { queue } from "../queue.js";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { resolveImageRefs } from "./_image-inputs.js";
import { apicityField, apicityStringArrayField, apicityStringField } from "./schema-from-apicity.js";
import { generationLabel } from "../artifact-label.js";

const wan27ImageInput = Wan27ImageInputSchema.shape;

const generateWan27ImageProSchema = {
  prompt: apicityStringField(wan27ImageInput.prompt, "Text prompt for image generation (max 5000 chars)", { required: true }),
  book_id: z.string().describe("Book id"),
  image_refs: apicityStringArrayField(wan27ImageInput.input_urls, "0-9 image artifact ids for reference images"),
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
    description: "Generate an image using Wan 2.7 Image Pro. Creates a new image artifact and enqueues a background job. Prompt is required; reference images are optional (0-9).",
    schema: generateWan27ImageProSchema,
    handler: async (args) => {
      const { prompt, book_id, image_refs, aspect_ratio, resolution, seed, nsfw_checker } = args as Args;
      const prefix = "img";

      const rawSlugs = image_refs ?? [];

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

      const resolved = await resolveImageRefs(fs, rawSlugs);
      if (!resolved.ok) {
        return { isError: true as const, content: [{ type: "text" as const, text: resolved.error }] };
      }
      const { inputs: imageInputs, sourceImageIds } = resolved;

      const assetName = generationLabel(modelSlug("kie", "wan/2-7-image-pro"), prompt);
      const assetResult = await fs.artifacts.create(prefix, assetName);
      if (!assetResult.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Failed to create image asset: ${assetResult.error.message}` }],
        };
      }

      const { artifactId: imgAssetId, path: imgAssetDir } = assetResult.value;

      const jobId = `${modelSlug("kie", "wan/2-7-image-pro")}-${imgAssetId}-${Date.now()}`;

      await queue.enqueue(jobId, {
        type: "generate_wan27_image_pro",
        prompt,
        imageInputs,
        imgAssetId,
        imgAssetDir,
        sourceImageIds,
        bookId: book_id,
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
