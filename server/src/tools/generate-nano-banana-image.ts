import { modelSlug } from "@apicity/cost";
import type { VideocityFs } from "videocity-engine";
import { z, type ZodRawShape } from "zod";
import { NanoBananaOutputFormatSchema, NanoBananaProRequestSchema, NanoBananaResolutionSchema } from "@apicity/kie/zod";
import { queue } from "../queue.js";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { zodErrorToToolResult } from "./_shared.js";
import { resolveImageSlugs } from "./_image-inputs.js";
import { apicityField } from "./schema-from-apicity.js";

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 30)
    .replace(/-$/, "");
}

const nanoBananaProInputSchema = NanoBananaProRequestSchema.shape.input.shape;

const generateNanoBananaImageSchema = {
  prompt: z.string().describe("Text prompt for image generation"),
  project_slug: z.string().describe("Project slug"),
  image_slugs: z.array(z.string()).optional().describe("0-8 @img-* slugs for reference images"),
  aspect_ratio: apicityField(nanoBananaProInputSchema.aspect_ratio, "Aspect ratio"),
  resolution: apicityField(NanoBananaResolutionSchema, "Output resolution"),
  output_format: apicityField(NanoBananaOutputFormatSchema, "Output image format"),

  _provider: z.string().optional().describe("Provider key (e.g., 'kie', 'xai')"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof generateNanoBananaImageSchema>;

export function generateNanoBananaImageDef(fs: VideocityFs): ToolDef {
  return {
    name: "generate_nano_banana_image",
    description: "Generate an image using the nano-banana-pro model. Creates a new img- asset and enqueues a background job. Prompt is required; reference images are optional.",
    schema: generateNanoBananaImageSchema,
    handler: async (args) => {
      const { prompt, project_slug, image_slugs, aspect_ratio, resolution, output_format } = args as Args;
      const prefix = "img";

      const rawSlugs = image_slugs ?? [];

      if (!process.env.KIE_API_KEY) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "KIE_API_KEY environment variable is not set" }],
        };
      }

      // Apicity NanoBananaProRequestSchema enforces image_input .max(8).
      const apicityCheck = NanoBananaProRequestSchema.safeParse({
        model: "nano-banana-pro",
        input: {
          prompt,
          ...(rawSlugs.length > 0 ? { image_input: rawSlugs.map((s) => s.replace(/^@/, "")) } : {}),
          ...(aspect_ratio !== undefined ? { aspect_ratio } : {}),
          ...(resolution !== undefined ? { resolution } : {}),
          ...(output_format !== undefined ? { output_format } : {}),
        },
      });
      if (!apicityCheck.success) return zodErrorToToolResult(apicityCheck.error);

      const resolved = await resolveImageSlugs(fs, rawSlugs, project_slug);
      if (!resolved.ok) {
        return { isError: true as const, content: [{ type: "text" as const, text: resolved.error }] };
      }
      const { inputs: imageInputs, sourceImageIds } = resolved;

      const assetName = `${modelSlug("kie", "nano-banana-pro")}-${slugify(prompt) || String(Date.now())}`;
      const assetResult = await fs.createAsset(prefix, assetName, project_slug);
      if (!assetResult.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Failed to create image asset: ${assetResult.error.message}` }],
        };
      }

      const { assetId: imgAssetId, path: imgAssetDir } = assetResult.value;

      const jobId = `${modelSlug("kie", "nano-banana-pro")}-${imgAssetId}-${Date.now()}`;

      await queue.enqueue(jobId, {
        type: "generate_nano_banana_image",
        prompt,
        imageInputs,
        imgAssetId,
        imgAssetDir,
        sourceImageIds,
        projectSlug: project_slug,
        ...(aspect_ratio !== undefined ? { aspectRatio: aspect_ratio } : {}),
        ...(resolution !== undefined ? { resolution } : {}),
        ...(output_format !== undefined ? { outputFormat: output_format } : {}),
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

