import type { Engine } from "videobook-engine";
import { z, type ZodRawShape } from "zod";
import { Qwen21ImageToImageRequestSchema } from "@apicity/kie/zod";
import { generationLabel } from "../artifact-label.js";
import { queue } from "../queue.js";
import { resolveImageRefs } from "./_image-inputs.js";
import { refAsPlaceholderUrl, zodErrorToToolResult } from "./_shared.js";
import { apicityField, apicityStringArrayField, apicityStringField } from "./schema-from-apicity.js";
import type { SchemaArgs, ToolDef } from "./tool-def.js";

const QWEN21_LABEL = "qwen2-1";
const qwen21InputSchema = Qwen21ImageToImageRequestSchema.shape.input.shape;

const generateQwen21ImageEditSchema = {
  prompt: apicityStringField(qwen21InputSchema.prompt, "Image editing prompt", { required: true }).min(1),
  book_id: z.string().describe("Book id"),
  image_refs: apicityStringArrayField(qwen21InputSchema.image_urls, "1-10 ordered image artifact ids for reference images", { required: true }),
  aspect_ratio: apicityField(qwen21InputSchema.aspect_ratio, "Output aspect ratio: auto / 16:9 / 9:16 / 1:1 / 2:3 / 3:2 / 4:3 / 3:4 / 21:9 / 9:21 (default auto)"),
  background: apicityField(qwen21InputSchema.background, "Output background (default opaque)"),
  output_format: apicityField(qwen21InputSchema.output_format, "Output image format (default png)"),
  resolution: apicityField(qwen21InputSchema.resolution, "Output resolution (default 1K)"),
  enhance_prompt: apicityField(qwen21InputSchema.enhance_prompt, "Enhance the prompt automatically"),
  nsfw_checker: apicityField(qwen21InputSchema.nsfw_checker, "Enable content safety filtering"),
  seed: apicityField(qwen21InputSchema.seed, "Random seed"),
  _provider: z.string().optional().describe("Provider key (e.g., 'kie')"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof generateQwen21ImageEditSchema>;

export function generateQwen21ImageEditDef(engine: Engine): ToolDef {
  return {
    name: "generate_kie_qwen_2_1_edit_image",
    description: "Edit or compose images using Qwen Image 2.1 via Kie with 1-10 ordered image artifact reference inputs. Creates a new image artifact and enqueues a background job.",
    schema: generateQwen21ImageEditSchema,
    handler: async (args) => {
      const {
        prompt,
        book_id,
        image_refs,
        aspect_ratio,
        background,
        output_format,
        resolution,
        enhance_prompt,
        nsfw_checker,
        seed,
      } = args as Args;

      if (!process.env.KIE_API_KEY) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "KIE_API_KEY environment variable is not set" }],
        };
      }

      const rawRefs = image_refs ?? [];
      const apicityCheck = Qwen21ImageToImageRequestSchema.safeParse({
        model: "qwen2-1/image-to-image",
        input: {
          prompt,
          image_urls: rawRefs.map(refAsPlaceholderUrl),
          ...(aspect_ratio !== undefined ? { aspect_ratio } : {}),
          ...(background !== undefined ? { background } : {}),
          ...(output_format !== undefined ? { output_format } : {}),
          ...(resolution !== undefined ? { resolution } : {}),
          ...(enhance_prompt !== undefined ? { enhance_prompt } : {}),
          ...(nsfw_checker !== undefined ? { nsfw_checker } : {}),
          ...(seed !== undefined ? { seed } : {}),
        },
      });
      if (!apicityCheck.success) return zodErrorToToolResult(apicityCheck.error);

      const resolved = await resolveImageRefs(engine, rawRefs);
      if (!resolved.ok) {
        return { isError: true as const, content: [{ type: "text" as const, text: resolved.error }] };
      }

      const assetResult = await engine.artifacts.create("img", generationLabel(QWEN21_LABEL, prompt));
      if (!assetResult.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Failed to create image asset: ${assetResult.error.message}` }],
        };
      }

      const { artifactId: imgAssetId, path: imgAssetDir } = assetResult.value;
      const jobId = `kie-${QWEN21_LABEL}-edit-${imgAssetId}-${Date.now()}`;
      await queue.enqueue(jobId, {
        type: "generate_qwen21_image_edit",
        prompt,
        imageInputs: resolved.inputs,
        imgAssetId,
        imgAssetDir,
        sourceImageIds: resolved.sourceImageIds,
        bookId: book_id,
        ...(aspect_ratio !== undefined ? { aspectRatio: aspect_ratio } : {}),
        ...(background !== undefined ? { background } : {}),
        ...(output_format !== undefined ? { outputFormat: output_format } : {}),
        ...(resolution !== undefined ? { resolution } : {}),
        ...(enhance_prompt !== undefined ? { enhancePrompt: enhance_prompt } : {}),
        ...(nsfw_checker !== undefined ? { nsfwChecker: nsfw_checker } : {}),
        ...(seed !== undefined ? { seed } : {}),
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
