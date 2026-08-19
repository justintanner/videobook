import { modelSlug } from "@apicity/cost";
import type { Engine } from "videobook-engine";
import { z, type ZodRawShape } from "zod";
import { NanoBananaProRequestSchema } from "@apicity/kie/zod";
import { queue } from "../queue.js";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { zodErrorToToolResult } from "./_shared.js";
import { resolveImageRefs } from "./_image-inputs.js";
import { apicityField, apicityStringArrayField, apicityStringField } from "./schema-from-apicity.js";
import { generationLabel } from "../artifact-label.js";

const nanoBananaProInputSchema = NanoBananaProRequestSchema.shape.input.shape;

const generateNanoBananaImageSchema = {
  prompt: apicityStringField(nanoBananaProInputSchema.prompt, "Text prompt for image generation", { required: true }),
  book_id: z.string().describe("Book id"),
  image_refs: apicityStringArrayField(nanoBananaProInputSchema.image_input, "0-8 image artifact ids for reference images"),
  aspect_ratio: apicityField(nanoBananaProInputSchema.aspect_ratio, "Aspect ratio"),
  resolution: apicityField(nanoBananaProInputSchema.resolution, "Output resolution"),
  output_format: apicityField(nanoBananaProInputSchema.output_format, "Output image format"),

  _provider: z.string().optional().describe("Provider key (e.g., 'kie', 'xai')"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof generateNanoBananaImageSchema>;

export function generateNanoBananaImageDef(engine: Engine): ToolDef {
  return {
    name: "generate_kie_nano_banana_pro_text_to_image",
    description: "Generate an image using the nano-banana-pro model. Creates a new image artifact and enqueues a background job. Prompt is required; reference images are optional.",
    schema: generateNanoBananaImageSchema,
    handler: async (args) => {
      const { prompt, book_id, image_refs, aspect_ratio, resolution, output_format } = args as Args;
      const prefix = "img";

      const rawSlugs = image_refs ?? [];

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

      const resolved = await resolveImageRefs(engine, rawSlugs);
      if (!resolved.ok) {
        return { isError: true as const, content: [{ type: "text" as const, text: resolved.error }] };
      }
      const { inputs: imageInputs, sourceImageIds } = resolved;

      const assetName = generationLabel(modelSlug("kie", "nano-banana-pro"), prompt);
      const assetResult = await engine.artifacts.create(prefix, assetName);
      if (!assetResult.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Failed to create image asset: ${assetResult.error.message}` }],
        };
      }

      const { artifactId: imgAssetId, path: imgAssetDir } = assetResult.value;

      const jobId = `${modelSlug("kie", "nano-banana-pro")}-${imgAssetId}-${Date.now()}`;

      await queue.enqueue(jobId, {
        type: "generate_nano_banana_image",
        prompt,
        imageInputs,
        imgAssetId,
        imgAssetDir,
        sourceImageIds,
        bookId: book_id,
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
