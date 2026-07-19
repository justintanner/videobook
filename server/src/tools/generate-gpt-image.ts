import type { VideocityFs } from "videocity-engine";
import { z, type ZodRawShape } from "zod";
import { GptImage2ImageToImageRequestSchema } from "@apicity/kie/zod";
import { queue } from "../queue.js";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { zodErrorToToolResult } from "./_shared.js";
import { resolveImageSlugs } from "./_image-inputs.js";
import { apicityField, apicityStringArrayField, apicityStringField } from "./schema-from-apicity.js";

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 30)
    .replace(/-$/, "");
}

const gptImageToImageInputSchema = GptImage2ImageToImageRequestSchema.shape.input.shape;

const generateGptImageSchema = {
  prompt: apicityStringField(gptImageToImageInputSchema.prompt, "Text prompt for image editing", { required: true }),
  project_slug: z.string().describe("Project slug"),
  image_slugs: apicityStringArrayField(gptImageToImageInputSchema.input_urls, "1-16 @img-* slugs for reference images", { required: true }),
  aspect_ratio: apicityField(gptImageToImageInputSchema.aspect_ratio, "Aspect ratio"),
  resolution: apicityField(gptImageToImageInputSchema.resolution, "Output resolution. 1:1 cannot upscale to 4K; auto/unset aspect_ratio is 1K only."),
  nsfw_checker: apicityField(gptImageToImageInputSchema.nsfw_checker, "Enable NSFW content filter"),

  _provider: z.string().optional().describe("Provider key (e.g., 'kie')"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof generateGptImageSchema>;

export function generateGptImageDef(fs: VideocityFs): ToolDef {
  return {
    name: "generate_gpt_image",
    description: "Generate an image using GPT Image 2.0 editing with 1-16 reference images. Creates a new img- asset and enqueues a background job.",
    schema: generateGptImageSchema,
    handler: async (args) => {
      const { prompt, project_slug, image_slugs, aspect_ratio, resolution, nsfw_checker } = args as Args;
      const prefix = "img";

      const rawSlugs = image_slugs ?? [];

      if (!process.env.KIE_API_KEY) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "KIE_API_KEY environment variable is not set" }],
        };
      }

      // Apicity GptImage2ImageToImageRequestSchema enforces input_urls .min(1).max(16).
      const apicityCheck = GptImage2ImageToImageRequestSchema.safeParse({
        model: "gpt-image-2-image-to-image",
        input: {
          prompt,
          input_urls: rawSlugs.map((s) => s.replace(/^@/, "")),
          ...(aspect_ratio !== undefined ? { aspect_ratio } : {}),
          ...(resolution !== undefined ? { resolution } : {}),
          ...(nsfw_checker !== undefined ? { nsfw_checker } : {}),
        },
      });
      if (!apicityCheck.success) return zodErrorToToolResult(apicityCheck.error);

      const resolved = await resolveImageSlugs(fs, rawSlugs, project_slug);
      if (!resolved.ok) {
        return { isError: true as const, content: [{ type: "text" as const, text: resolved.error }] };
      }
      const { inputs: imageInputs, sourceImageIds } = resolved;

      const assetName = slugify(prompt);
      const assetResult = await fs.createAsset(prefix, assetName, project_slug);
      if (!assetResult.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Failed to create image asset: ${assetResult.error.message}` }],
        };
      }

      const { assetId: imgAssetId, path: imgAssetDir } = assetResult.value;

      const jobId = `gpt-image-${imgAssetId}-${Date.now()}`;

      await queue.enqueue(jobId, {
        type: "generate_gpt_image",
        prompt,
        imageInputs,
        imgAssetId,
        imgAssetDir,
        sourceImageIds,
        projectSlug: project_slug,
        ...(aspect_ratio !== undefined ? { aspectRatio: aspect_ratio } : {}),
        ...(resolution !== undefined ? { resolution } : {}),
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
