import type { Engine } from "videobook-engine";
import { z, type ZodRawShape } from "zod";
import { Qwen21TextToImageRequestSchema } from "@apicity/kie/zod";
import { queue } from "../queue.js";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { zodErrorToToolResult } from "./_shared.js";
import { apicityField, apicityStringField } from "./schema-from-apicity.js";
import { generationLabel } from "../artifact-label.js";

const QWEN21_LABEL = "qwen2-1";
const qwen21InputSchema = Qwen21TextToImageRequestSchema.shape.input.shape;

const generateQwen21TextImageSchema = {
  prompt: apicityStringField(qwen21InputSchema.prompt, "Text description of the image to generate", { required: true }).min(1),
  book_id: z.string().describe("Book id"),
  aspect_ratio: apicityField(qwen21InputSchema.aspect_ratio, "Output aspect ratio (default 1:1)"),
  background: apicityField(qwen21InputSchema.background, "Output background (default opaque)"),
  output_format: apicityField(qwen21InputSchema.output_format, "Output image format (default png)"),
  resolution: apicityField(qwen21InputSchema.resolution, "Output resolution (default 1K)"),
  enhance_prompt: apicityField(qwen21InputSchema.enhance_prompt, "Enhance the prompt automatically"),
  nsfw_checker: apicityField(qwen21InputSchema.nsfw_checker, "Enable content safety filtering"),
  seed: apicityField(qwen21InputSchema.seed, "Random seed"),
  _provider: z.string().optional().describe("Provider key (e.g., 'kie')"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof generateQwen21TextImageSchema>;

export function generateQwen21TextImageDef(engine: Engine): ToolDef {
  return {
    name: "generate_kie_qwen_2_1_text_to_image",
    description: "Generate an image from text using Qwen Image 2.1 via Kie. Creates a new image artifact and enqueues a background job.",
    schema: generateQwen21TextImageSchema,
    handler: async (args) => {
      const {
        prompt,
        book_id,
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

      const apicityCheck = Qwen21TextToImageRequestSchema.safeParse({
        model: "qwen2-1/text-to-image",
        input: {
          prompt,
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

      const assetResult = await engine.artifacts.create("img", generationLabel(QWEN21_LABEL, prompt));
      if (!assetResult.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Failed to create image asset: ${assetResult.error.message}` }],
        };
      }

      const { artifactId: imgAssetId, path: imgAssetDir } = assetResult.value;
      const jobId = `kie-${QWEN21_LABEL}-text-${imgAssetId}-${Date.now()}`;
      await queue.enqueue(jobId, {
        type: "generate_qwen21_text_image",
        prompt,
        imgAssetId,
        imgAssetDir,
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
            job_id: jobId,
            status: "enqueued",
          }),
        }],
      };
    },
  };
}
