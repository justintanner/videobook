import type { Engine } from "videobook-engine";
import { z, type ZodRawShape } from "zod";
import { GptImage2TextToImageRequestSchema } from "@apicity/kie/zod";
import { queue } from "../queue.js";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { zodErrorToToolResult } from "./_shared.js";
import { apicityField, apicityStringField } from "./schema-from-apicity.js";
import { generationLabel } from "../artifact-label.js";

const gptImageTextInputSchema = GptImage2TextToImageRequestSchema.shape.input.shape;

const generateGptImageTextSchema = {
  prompt: apicityStringField(gptImageTextInputSchema.prompt, "Text prompt for image generation (1-20000 chars)", { required: true }),
  book_id: z.string().describe("Book id"),
  aspect_ratio: apicityField(gptImageTextInputSchema.aspect_ratio, "Aspect ratio"),
  resolution: apicityField(gptImageTextInputSchema.resolution, "Output resolution. 1:1 cannot upscale to 4K; auto/unset aspect_ratio is 1K only."),
  nsfw_checker: apicityField(gptImageTextInputSchema.nsfw_checker, "Enable NSFW content filter"),
  _provider: z.string().optional().describe("Provider key (e.g., 'kie')"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof generateGptImageTextSchema>;

export function generateGptImageTextDef(engine: Engine): ToolDef {
  return {
    name: "generate_kie_gpt_image_2_text_to_image",
    description: "Generate an image using GPT Image 2.0 text-to-image. Creates a new image artifact and enqueues a background job.",
    schema: generateGptImageTextSchema,
    handler: async (args) => {
      const { prompt, book_id, aspect_ratio, resolution, nsfw_checker } = args as Args;

      if (!process.env.KIE_API_KEY) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "KIE_API_KEY environment variable is not set" }],
        };
      }

      const apicityCheck = GptImage2TextToImageRequestSchema.safeParse({
        model: "gpt-image-2-text-to-image",
        input: {
          prompt,
          ...(aspect_ratio !== undefined ? { aspect_ratio } : {}),
          ...(resolution !== undefined ? { resolution } : {}),
          ...(nsfw_checker !== undefined ? { nsfw_checker } : {}),
        },
      });
      if (!apicityCheck.success) return zodErrorToToolResult(apicityCheck.error);

      const assetName = generationLabel("gpt-image-text", prompt);
      const assetResult = await engine.artifacts.create("img", assetName);
      if (!assetResult.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Failed to create image asset: ${assetResult.error.message}` }],
        };
      }

      const { artifactId: imgAssetId, path: imgAssetDir } = assetResult.value;

      const jobId = `gpt-image-text-${imgAssetId}-${Date.now()}`;

      await queue.enqueue(jobId, {
        type: "generate_gpt_image_text",
        prompt,
        imgAssetId,
        imgAssetDir,
        bookId: book_id,
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
