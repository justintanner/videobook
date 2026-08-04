import type { Engine } from "videobook-engine";
import { modelSlug } from "@apicity/cost";
import { z, type ZodRawShape } from "zod";
import { FalNanoBanana2EditRequestSchema } from "@apicity/fal/zod";
import { queue } from "../queue.js";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { resolveImageRefs, slugify } from "./_fal-shared.js";
import { apicityField, apicityStringArrayField, apicityStringField } from "./schema-from-apicity.js";

const base = FalNanoBanana2EditRequestSchema.shape;

const schema = {
  book_id: z.string().describe("Book id"),
  prompt: apicityStringField(base.prompt, "Edit instruction", { required: true }),
  // Apicity edit image_urls still unbounded; keep Fal's 14-ref cap locally (§24).
  image_refs: apicityStringArrayField(base.image_urls, "1-14 image artifact ids for reference images", { required: true }).min(1).max(14),
  num_images: apicityField(base.num_images, "Number of images to generate (1-4)"),
  aspect_ratio: apicityField(base.aspect_ratio, "Aspect ratio"),
  resolution: apicityField(base.resolution, "Output resolution"),
  output_format: apicityField(base.output_format, "Output image format"),
  safety_tolerance: apicityField(base.safety_tolerance, "Safety tolerance 1-6"),
  thinking_level: apicityField(base.thinking_level, "Thinking level (minimal/high)"),
  enable_web_search: apicityField(base.enable_web_search, "Enable web search grounding"),
  seed: apicityField(base.seed, "Seed for deterministic output"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof schema>;

export function generateNanoBanana2EditFalDef(fs: Engine): ToolDef {
  return {
    name: "generate_fal_nano_banana_2_edit_image",
    description: "Edit images via fal.ai using Google Nano Banana 2 with one or more image artifact reference inputs. Creates a new image artifact and enqueues a background job.",
    schema,
    handler: async (args) => {
      const { book_id, prompt, image_refs, num_images, aspect_ratio, resolution, output_format, safety_tolerance, thinking_level, enable_web_search, seed } = args as Args;

      if (!process.env.FAL_API_KEY) {
        return { isError: true as const, content: [{ type: "text" as const, text: "FAL_API_KEY environment variable is not set" }] };
      }

      const resolved = await resolveImageRefs(fs, image_refs, book_id);
      if (!resolved.ok) return { isError: true as const, content: [{ type: "text" as const, text: resolved.error }] };

      const assetResult = await fs.artifacts.create("img", `${modelSlug("kie", "nano-banana-2")}-${slugify(prompt) || String(Date.now())}`);
      if (!assetResult.ok) return { isError: true as const, content: [{ type: "text" as const, text: `Failed to create image asset: ${assetResult.error.message}` }] };

      const { artifactId: imgAssetId, path: imgAssetDir } = assetResult.value;

      const jobId = `fal-${modelSlug("kie", "nano-banana-2")}-edit-${imgAssetId}-${Date.now()}`;
      await queue.enqueue(jobId, {
        type: "generate_nano_banana_2_edit_fal",
        imgAssetId,
        imgAssetDir,
        bookId: book_id,
        prompt,
        imageInputs: resolved.inputs,
        sourceImageIds: resolved.sourceImageIds,
        ...(num_images !== undefined ? { num_images } : {}),
        ...(aspect_ratio !== undefined ? { aspect_ratio } : {}),
        ...(resolution !== undefined ? { resolution } : {}),
        ...(output_format !== undefined ? { output_format } : {}),
        ...(safety_tolerance !== undefined ? { safety_tolerance } : {}),
        ...(thinking_level !== undefined ? { thinking_level } : {}),
        ...(enable_web_search !== undefined ? { enable_web_search } : {}),
        ...(seed !== undefined ? { seed } : {}),
      } as unknown as Record<string, unknown>);

      return { content: [{ type: "text" as const, text: JSON.stringify({ img_asset_id: imgAssetId, source_images: resolved.sourceImageIds, job_id: jobId, status: "enqueued" }) }] };
    },
  };
}
