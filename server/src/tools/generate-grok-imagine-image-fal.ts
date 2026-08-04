import type { Engine } from "videobook-engine";
import { z, type ZodRawShape } from "zod";
import { FalXaiGrokImagineImageRequestSchema } from "@apicity/fal/zod";
import { queue } from "../queue.js";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { slugify } from "./_fal-shared.js";
import { modelSlug } from "@apicity/cost";
import { apicityField, apicityStringField } from "./schema-from-apicity.js";

const base = FalXaiGrokImagineImageRequestSchema.shape;

const schema = {
  book_id: z.string().describe("Book id"),
  prompt: apicityStringField(base.prompt, "Text prompt for image generation", { required: true }),
  num_images: apicityField(base.num_images, "Number of images to generate (1-4)"),
  aspect_ratio: apicityField(base.aspect_ratio, "Aspect ratio"),
  resolution: apicityField(base.resolution, "Output resolution"),
  output_format: apicityField(base.output_format, "Output image format"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof schema>;

export function generateGrokImagineImageFalDef(fs: Engine): ToolDef {
  return {
    name: "generate_fal_grok_imagine_text_to_image",
    description: "Generate an image via fal.ai using xAI Grok Imagine Image from a text prompt. Creates a new image artifact and enqueues a background job.",
    schema,
    handler: async (args) => {
      const { book_id, prompt, num_images, aspect_ratio, resolution, output_format } = args as Args;

      if (!process.env.FAL_API_KEY) {
        return { isError: true as const, content: [{ type: "text" as const, text: "FAL_API_KEY environment variable is not set" }] };
      }

      const assetResult = await fs.artifacts.create("img", `${modelSlug("kie", "grok-imagine/text-to-image")}-${slugify(prompt) || String(Date.now())}`);
      if (!assetResult.ok) return { isError: true as const, content: [{ type: "text" as const, text: `Failed to create image asset: ${assetResult.error.message}` }] };

      const { artifactId: imgAssetId, path: imgAssetDir } = assetResult.value;

      const jobId = `fal-${modelSlug("kie", "grok-imagine/text-to-image")}-${imgAssetId}-${Date.now()}`;
      await queue.enqueue(jobId, {
        type: "generate_grok_imagine_image_fal",
        imgAssetId,
        imgAssetDir,
        bookId: book_id,
        prompt,
        ...(num_images !== undefined ? { num_images } : {}),
        ...(aspect_ratio !== undefined ? { aspect_ratio } : {}),
        ...(resolution !== undefined ? { resolution } : {}),
        ...(output_format !== undefined ? { output_format } : {}),
      } as unknown as Record<string, unknown>);

      return { content: [{ type: "text" as const, text: JSON.stringify({ img_asset_id: imgAssetId, job_id: jobId, status: "enqueued" }) }] };
    },
  };
}
