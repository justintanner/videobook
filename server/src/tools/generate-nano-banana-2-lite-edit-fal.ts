import type { Engine } from "videobook-engine";
import { z, type ZodRawShape } from "zod";
import { FalNanoBanana2LiteEditRequestSchema } from "@apicity/fal/zod";
import { queue } from "../queue.js";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { resolveImageSlugs, slugify } from "./_fal-shared.js";
import { apicityField, apicityStringArrayField, apicityStringField } from "./schema-from-apicity.js";

const base = FalNanoBanana2LiteEditRequestSchema.shape;

const schema = {
  book_id: z.string().describe("Project slug"),
  prompt: apicityStringField(base.prompt, "Edit instruction", { required: true }),
  image_slugs: apicityStringArrayField(base.image_urls, "1 or more @img-* slugs for reference images", { required: true }).min(1),
  num_images: apicityField(base.num_images, "Number of images to generate"),
  aspect_ratio: apicityField(base.aspect_ratio, "Aspect ratio"),
  output_format: apicityField(base.output_format, "Output image format"),
  safety_tolerance: apicityField(base.safety_tolerance, "Safety tolerance 1-6"),
  thinking_level: apicityField(base.thinking_level, "Thinking level (minimal/high)"),
  seed: apicityField(base.seed, "Seed for deterministic output"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof schema>;

export function generateNanoBanana2LiteEditFalDef(fs: Engine): ToolDef {
  return {
    name: "generate_fal_nano_banana_2_lite_edit_image",
    description: "Edit images via fal.ai using Google Nano Banana 2 Lite with one or more @img-* reference inputs. Creates a new img- asset and enqueues a background job.",
    schema,
    handler: async (args) => {
      const { book_id, prompt, image_slugs, num_images, aspect_ratio, output_format, safety_tolerance, thinking_level, seed } = args as Args;

      if (!process.env.FAL_API_KEY) {
        return { isError: true as const, content: [{ type: "text" as const, text: "FAL_API_KEY environment variable is not set" }] };
      }

      const resolved = await resolveImageSlugs(fs, image_slugs, book_id);
      if (!resolved.ok) return { isError: true as const, content: [{ type: "text" as const, text: resolved.error }] };

      const assetResult = await fs.artifacts.create("img", `nano-banana-2-lite-edit-${slugify(prompt) || String(Date.now())}`);
      if (!assetResult.ok) return { isError: true as const, content: [{ type: "text" as const, text: `Failed to create image asset: ${assetResult.error.message}` }] };

      const { slug: imgAssetId, path: imgAssetDir } = assetResult.value;

      const jobId = `fal-nano-banana-2-lite-edit-${imgAssetId}-${Date.now()}`;
      await queue.enqueue(jobId, {
        type: "generate_nano_banana_2_lite_edit_fal",
        imgAssetId,
        imgAssetDir,
        bookId: book_id,
        prompt,
        imageInputs: resolved.inputs,
        sourceImageIds: resolved.sourceImageIds,
        ...(num_images !== undefined ? { num_images } : {}),
        ...(aspect_ratio !== undefined ? { aspect_ratio } : {}),
        ...(output_format !== undefined ? { output_format } : {}),
        ...(safety_tolerance !== undefined ? { safety_tolerance } : {}),
        ...(thinking_level !== undefined ? { thinking_level } : {}),
        ...(seed !== undefined ? { seed } : {}),
      } as unknown as Record<string, unknown>);

      return { content: [{ type: "text" as const, text: JSON.stringify({ img_asset_id: imgAssetId, source_images: resolved.sourceImageIds, job_id: jobId, status: "enqueued" }) }] };
    },
  };
}
