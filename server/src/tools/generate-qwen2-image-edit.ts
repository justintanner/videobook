import type { Engine } from "videobook-engine";
import { z, type ZodRawShape } from "zod";
import { Qwen2ImageEditRequestSchema } from "@apicity/kie/zod";
import { queue } from "../queue.js";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { refAsPlaceholderUrl, zodErrorToToolResult } from "./_shared.js";
import { resolveImageRefs } from "./_image-inputs.js";
import { apicityField, apicityStringArrayField, apicityStringField } from "./schema-from-apicity.js";

// The output artifact's label is free text; ids carry no name, so the stem
// comes from the source image's own label (or a timestamp when there is none).
function deriveImageName(stem: string): string {
  return `qwen2-${stem}`;
}

function sourceImageLabel(engine: Engine, imageAssetId: string | undefined): string {
  if (!imageAssetId) return `ephemeral-${Date.now()}`;
  const artifact = engine.artifacts.get(imageAssetId);
  const label = artifact.ok ? artifact.value.label?.trim() : undefined;
  return label || imageAssetId;
}

const qwen2ImageEditInputSchema = Qwen2ImageEditRequestSchema.shape.input.shape;

const generateQwen2ImageEditSchema = {
  prompt: apicityStringField(qwen2ImageEditInputSchema.prompt, "Image editing prompt (max 800 chars)", { required: true }),
  book_id: z.string().describe("Book id"),
  image_refs: apicityStringArrayField(qwen2ImageEditInputSchema.image_url, "Exactly 1 image artifact id for the reference image to edit", { required: true }),
  image_size: apicityField(qwen2ImageEditInputSchema.image_size, "Output aspect ratio (default 16:9)"),
  output_format: apicityField(qwen2ImageEditInputSchema.output_format, "Output image format (default png)"),
  nsfw_checker: apicityField(qwen2ImageEditInputSchema.nsfw_checker, "Enable NSFW content safety filter"),
  seed: apicityField(qwen2ImageEditInputSchema.seed, "Random seed"),

  _provider: z.string().optional().describe("Provider key (e.g., 'kie')"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof generateQwen2ImageEditSchema>;

export function generateQwen2ImageEditDef(engine: Engine): ToolDef {
  return {
    name: "generate_kie_qwen_2_0_edit_image",
    description: "Edit an image using Qwen2 image-edit on Kie. Requires exactly 1 reference image. Creates a new image artifact and enqueues a background job.",
    schema: generateQwen2ImageEditSchema,
    handler: async (args) => {
      const { prompt, book_id, image_refs, image_size, output_format, seed } = args as Args;
      const prefix = "img";

      if (!process.env.KIE_API_KEY) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "KIE_API_KEY environment variable is not set" }],
        };
      }

      const rawSlugs = image_refs ?? [];
      if (rawSlugs.length !== 1) {
        return {
          isError: true as const,
          content: [{
            type: "text" as const,
            text: `generate_qwen2_image_edit accepts exactly 1 reference image (got ${rawSlugs.length}). qwen2/image-edit is single-image; use a multi-image model for edits with more references.`,
          }],
        };
      }

      // Apicity Qwen2ImageEditRequestSchema enforces image_url as z.string().url()
      // and prompt .min(1). Local artifact refs are not URLs; use a placeholder so
      // pre-upload validation still checks prompt/options. The job handler uploads
      // the asset and substitutes a real CDN URL before calling Kie.
      const apicityCheck = Qwen2ImageEditRequestSchema.safeParse({
        model: "qwen2/image-edit",
        input: {
          prompt,
          image_url: refAsPlaceholderUrl(rawSlugs[0]),
          ...(image_size !== undefined ? { image_size } : {}),
          ...(output_format !== undefined ? { output_format } : {}),
          ...(seed !== undefined ? { seed } : {}),
        },
      });
      if (!apicityCheck.success) return zodErrorToToolResult(apicityCheck.error);

      const resolved = await resolveImageRefs(engine, rawSlugs);
      if (!resolved.ok) {
        return { isError: true as const, content: [{ type: "text" as const, text: resolved.error }] };
      }
      const { inputs: imageInputs, sourceImageIds } = resolved;

      const imgName = deriveImageName(sourceImageLabel(engine, sourceImageIds[0]));
      const assetResult = await engine.artifacts.create(prefix, imgName);
      if (!assetResult.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Failed to create image asset: ${assetResult.error.message}` }],
        };
      }

      const { artifactId: imgAssetId, path: imgAssetDir } = assetResult.value;

      const jobId = `qwen2-image-edit-${imgAssetId}-${Date.now()}`;

      await queue.enqueue(jobId, {
        type: "generate_qwen2_image_edit",
        prompt,
        imageInputs,
        imgAssetId,
        imgAssetDir,
        sourceImageIds,
        bookId: book_id,
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
