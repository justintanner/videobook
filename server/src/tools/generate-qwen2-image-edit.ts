import type { VideocityFs } from "videocity-engine";
import { z, type ZodRawShape } from "zod";
import { Qwen2ImageEditRequestSchema } from "@apicity/kie/zod";
import { queue } from "../queue.js";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { zodErrorToToolResult } from "./_shared.js";
import { resolveImageSlugs } from "./_image-inputs.js";

function deriveImageName(imageAssetId: string): string {
  const baseName = imageAssetId.startsWith("img-") ? imageAssetId.slice(4) : imageAssetId;
  return `qwen2-${baseName}`;
}

const qwen2ImageEditInputSchema = Qwen2ImageEditRequestSchema.shape.input.shape;

const generateQwen2ImageEditSchema = {
  prompt: z.string().describe("Image editing prompt (max 800 chars)"),
  project_slug: z.string().describe("Project slug"),
  image_slugs: z.array(z.string()).describe("1-3 @img-* slugs for reference images to edit"),
  image_size: z.enum(qwen2ImageEditInputSchema.image_size.removeDefault().options).optional().describe("Output aspect ratio (default 16:9)"),
  output_format: z.enum(qwen2ImageEditInputSchema.output_format.removeDefault().options).optional().describe("Output image format (default png)"),
  seed: z.number().optional().describe("Random seed"),
  output_prefix: z.enum(["img", "char"]).optional().describe("Asset prefix for the output (default: img). Use 'char' to bundle into a character asset."),
  _provider: z.string().optional().describe("Provider key (e.g., 'kie')"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof generateQwen2ImageEditSchema>;

export function generateQwen2ImageEditDef(fs: VideocityFs): ToolDef {
  return {
    name: "generate_qwen2_image_edit",
    description: "Edit images using Qwen2 image-edit on Kie. Requires 1-3 reference images. Creates a new img- asset and enqueues a background job.",
    schema: generateQwen2ImageEditSchema,
    handler: async (args) => {
      const { prompt, project_slug, image_slugs, image_size, output_format, seed, output_prefix } = args as Args;
      const prefix = output_prefix ?? "img";

      if (!process.env.KIE_API_KEY) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "KIE_API_KEY environment variable is not set" }],
        };
      }

      const rawSlugs = image_slugs ?? [];

      // Apicity Qwen2ImageEditRequestSchema enforces image_url .min(1).max(3)
      // and prompt .min(1). Slugs stand in for URLs here — they are non-empty
      // strings that satisfy the inner `z.string().min(1)` constraint. The
      // actual URLs are resolved post-upload in the job handler.
      const apicityCheck = Qwen2ImageEditRequestSchema.safeParse({
        model: "qwen2/image-edit",
        input: {
          prompt,
          image_url: rawSlugs.map((s) => s.replace(/^@/, "")),
          ...(image_size !== undefined ? { image_size } : {}),
          ...(output_format !== undefined ? { output_format } : {}),
          ...(seed !== undefined ? { seed } : {}),
        },
      });
      if (!apicityCheck.success) return zodErrorToToolResult(apicityCheck.error);

      const resolved = await resolveImageSlugs(fs, rawSlugs, project_slug);
      if (!resolved.ok) {
        return { isError: true as const, content: [{ type: "text" as const, text: resolved.error }] };
      }
      const { inputs: imageInputs, sourceImageIds } = resolved;

      const nameSeed = sourceImageIds[0] ?? `ephemeral-${Date.now()}`;
      const imgName = deriveImageName(nameSeed);
      const assetResult = await fs.createAsset(prefix, imgName, project_slug);
      if (!assetResult.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Failed to create image asset: ${assetResult.error.message}` }],
        };
      }

      const { assetId: imgAssetId, path: imgAssetDir } = assetResult.value;

      const jobId = `qwen2-image-edit-${imgAssetId}-${Date.now()}`;

      await queue.enqueue(jobId, {
        type: "generate_qwen2_image_edit",
        prompt,
        imageInputs,
        imgAssetId,
        imgAssetDir,
        sourceImageIds,
        projectSlug: project_slug,
        ...(image_size !== undefined ? { imageSize: image_size } : {}),
        ...(output_format !== undefined ? { outputFormat: output_format } : {}),
        ...(seed !== undefined ? { seed } : {}),
      } as unknown as Record<string, unknown>);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            img_asset_id: imgAssetId,
            source_images: sourceImageIds,
            job_id: jobId,
            status: "enqueued",
          }),
        }],
      };
    },
  };
}

