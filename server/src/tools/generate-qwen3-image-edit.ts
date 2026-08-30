import { modelSlug } from "@apicity/cost";
import { Qwen3ImageToImageRequestSchema } from "@apicity/kie/zod";
import type { Engine } from "videobook-engine";
import { z, type ZodRawShape } from "zod";
import { generationLabel } from "../artifact-label.js";
import { queue } from "../queue.js";
import { resolveImageRefs } from "./_image-inputs.js";
import { refAsPlaceholderUrl, zodErrorToToolResult } from "./_shared.js";
import { apicityField, apicityStringArrayField, apicityStringField } from "./schema-from-apicity.js";
import type { SchemaArgs, ToolDef } from "./tool-def.js";

const qwen3InputSchema = Qwen3ImageToImageRequestSchema.shape.input.shape;

const generateQwen3ImageEditSchema = {
  prompt: apicityStringField(qwen3InputSchema.prompt, "Image editing prompt (max 5000 chars)", { required: true }).min(1),
  book_id: z.string().describe("Book id"),
  image_refs: apicityStringArrayField(qwen3InputSchema.image_urls, "1-3 ordered image artifact ids for reference images", { required: true }),
  image_size: apicityField(qwen3InputSchema.image_size, "Output aspect ratio (default 16:9)"),
  output_format: apicityField(qwen3InputSchema.output_format, "Output image format (default png)"),
  prompt_extend: apicityField(qwen3InputSchema.prompt_extend, "Extend the prompt automatically"),
  nsfw_checker: apicityField(qwen3InputSchema.nsfw_checker, "Enable content safety filtering"),
  negative_prompt: apicityField(qwen3InputSchema.negative_prompt, "Negative prompt"),
  seed: apicityField(qwen3InputSchema.seed, "Random seed"),
  resolution: apicityField(qwen3InputSchema.resolution, "Output resolution (default 1K)"),
  _provider: z.string().optional().describe("Provider key (e.g., 'kie', 'fal')"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof generateQwen3ImageEditSchema>;

export function generateQwen3ImageEditDef(engine: Engine): ToolDef {
  return {
    name: "generate_kie_qwen_3_0_edit_image",
    description: "Edit or compose images using Qwen Image 3 via Kie with 1-3 ordered image artifact reference inputs. Creates a new image artifact and enqueues a background job.",
    schema: generateQwen3ImageEditSchema,
    handler: async (args) => {
      const {
        prompt,
        book_id,
        image_refs,
        image_size,
        output_format,
        prompt_extend,
        nsfw_checker,
        negative_prompt,
        seed,
        resolution,
      } = args as Args;

      if (!process.env.KIE_API_KEY) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "KIE_API_KEY environment variable is not set" }],
        };
      }

      const rawRefs = image_refs ?? [];
      const apicityCheck = Qwen3ImageToImageRequestSchema.safeParse({
        model: "qwen3/image-to-image",
        input: {
          prompt,
          image_urls: rawRefs.map(refAsPlaceholderUrl),
          ...(image_size !== undefined ? { image_size } : {}),
          ...(output_format !== undefined ? { output_format } : {}),
          ...(prompt_extend !== undefined ? { prompt_extend } : {}),
          ...(nsfw_checker !== undefined ? { nsfw_checker } : {}),
          ...(negative_prompt !== undefined ? { negative_prompt } : {}),
          ...(seed !== undefined ? { seed } : {}),
          ...(resolution !== undefined ? { resolution } : {}),
        },
      });
      if (!apicityCheck.success) return zodErrorToToolResult(apicityCheck.error);

      const resolved = await resolveImageRefs(engine, rawRefs);
      if (!resolved.ok) {
        return { isError: true as const, content: [{ type: "text" as const, text: resolved.error }] };
      }

      const model = "qwen3/image-to-image";
      const assetResult = await engine.artifacts.create("img", generationLabel(modelSlug("kie", model), prompt));
      if (!assetResult.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Failed to create image asset: ${assetResult.error.message}` }],
        };
      }

      const { artifactId: imgAssetId, path: imgAssetDir } = assetResult.value;
      const jobId = `${modelSlug("kie", model)}-edit-${imgAssetId}-${Date.now()}`;
      await queue.enqueue(jobId, {
        type: "generate_qwen3_image_edit",
        prompt,
        imageInputs: resolved.inputs,
        imgAssetId,
        imgAssetDir,
        sourceImageIds: resolved.sourceImageIds,
        bookId: book_id,
        ...(image_size !== undefined ? { imageSize: image_size } : {}),
        ...(output_format !== undefined ? { outputFormat: output_format } : {}),
        ...(prompt_extend !== undefined ? { promptExtend: prompt_extend } : {}),
        ...(nsfw_checker !== undefined ? { nsfwChecker: nsfw_checker } : {}),
        ...(negative_prompt !== undefined ? { negativePrompt: negative_prompt } : {}),
        ...(seed !== undefined ? { seed } : {}),
        ...(resolution !== undefined ? { resolution } : {}),
      } as unknown as Record<string, unknown>);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            img_asset_id: imgAssetId,
            source_images: resolved.sourceImageIds,
            job_id: jobId,
            status: "enqueued",
          }),
        }],
      };
    },
  };
}
