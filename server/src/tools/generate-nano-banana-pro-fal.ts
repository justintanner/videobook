import type { Engine } from "videobook-engine";
import { z, type ZodRawShape } from "zod";
import { FalNanoBananaProTextToImageRequestSchema } from "@apicity/fal/zod";
import { queue } from "../queue.js";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { modelSlug } from "@apicity/cost";
import { apicityField, apicityStringField } from "./schema-from-apicity.js";
import { generationLabel } from "../artifact-label.js";

const base = FalNanoBananaProTextToImageRequestSchema.shape;

const schema = {
  book_id: z.string().describe("Book id"),
  prompt: apicityStringField(base.prompt, "Text prompt for image generation", { required: true }),
  num_images: apicityField(base.num_images, "Number of images to generate (1-4)"),
  aspect_ratio: apicityField(base.aspect_ratio, "Aspect ratio"),
  resolution: apicityField(base.resolution, "Output resolution (1K/2K/4K)"),
  output_format: apicityField(base.output_format, "Output image format"),
  seed: apicityField(base.seed, "Seed for deterministic output"),
  enable_web_search: apicityField(base.enable_web_search, "Enable web search grounding"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof schema>;

export function generateNanoBananaProFalDef(engine: Engine): ToolDef {
  return {
    name: "generate_fal_nano_banana_pro_text_to_image",
    description: "Generate an image via fal.ai using Google Nano Banana Pro from a text prompt. Creates a new image artifact and enqueues a background job.",
    schema,
    handler: async (args) => {
      const { book_id, prompt, num_images, aspect_ratio, resolution, output_format, seed, enable_web_search } = args as Args;

      if (!process.env.FAL_API_KEY) {
        return { isError: true as const, content: [{ type: "text" as const, text: "FAL_API_KEY environment variable is not set" }] };
      }

      const assetResult = await engine.artifacts.create("img", generationLabel(modelSlug("kie", "nano-banana-pro"), prompt));
      if (!assetResult.ok) return { isError: true as const, content: [{ type: "text" as const, text: `Failed to create image asset: ${assetResult.error.message}` }] };

      const { artifactId: imgAssetId, path: imgAssetDir } = assetResult.value;

      const jobId = `fal-${modelSlug("kie", "nano-banana-pro")}-${imgAssetId}-${Date.now()}`;
      await queue.enqueue(jobId, {
        type: "generate_nano_banana_pro_fal",
        imgAssetId,
        imgAssetDir,
        bookId: book_id,
        prompt,
        ...(num_images !== undefined ? { num_images } : {}),
        ...(aspect_ratio !== undefined ? { aspect_ratio } : {}),
        ...(resolution !== undefined ? { resolution } : {}),
        ...(output_format !== undefined ? { output_format } : {}),
        ...(seed !== undefined ? { seed } : {}),
        ...(enable_web_search !== undefined ? { enable_web_search } : {}),
      } as unknown as Record<string, unknown>);

      return { content: [{ type: "text" as const, text: JSON.stringify({ img_asset_id: imgAssetId, job_id: jobId, status: "enqueued" }) }] };
    },
  };
}
