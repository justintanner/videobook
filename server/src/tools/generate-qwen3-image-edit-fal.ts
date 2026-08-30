import type { Engine } from "videobook-engine";
import { z, type ZodRawShape } from "zod";
import { FalAlibabaQwenImage3EditRequestSchema } from "@apicity/fal/zod";
import { queue } from "../queue.js";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { resolveImageRefs } from "./_fal-shared.js";
import { apicityField, apicityStringArrayField, apicityStringField, apicityUnionEnumField } from "./schema-from-apicity.js";
import { generationLabel } from "../artifact-label.js";

const base = FalAlibabaQwenImage3EditRequestSchema.shape;

const schema = {
  book_id: z.string().describe("Book id"),
  prompt: apicityStringField(base.prompt, "Edit instruction (Chinese or English; reference inputs positionally as \"image 1\", \"image 2\", \"image 3\")", { required: true }).min(1).max(5000),
  image_refs: apicityStringArrayField(base.image_urls, "Image artifact ids for 1-3 ordered reference images (order is meaningful)", { required: true }).min(1).max(3),
  negative_prompt: z.string().max(500).optional().describe("Negative prompt"),
  image_size: apicityUnionEnumField(base.image_size, "Output size (square_hd default)"),
  enable_prompt_expansion: apicityField(base.enable_prompt_expansion, "Enable prompt expansion"),
  seed: apicityField(base.seed, "Seed for deterministic output"),
  enable_safety_checker: apicityField(base.enable_safety_checker, "Enable safety checker"),
  sync_mode: apicityField(base.sync_mode, "Wait for the result in a single request"),
  num_images: apicityField(base.num_images, "Number of images (1-6)"),
  output_format: apicityField(base.output_format, "Output image format"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof schema>;

export function generateQwen3ImageEditFalDef(engine: Engine): ToolDef {
  return {
    name: "generate_fal_qwen_3_0_edit_image",
    description: "Edit images via fal.ai using Alibaba Qwen Image 3 with 1-3 ordered image artifact reference inputs. Creates a new image artifact and enqueues a background job.",
    schema,
    handler: async (args) => {
      const { book_id, prompt, image_refs, negative_prompt, image_size, enable_prompt_expansion, seed, enable_safety_checker, sync_mode, num_images, output_format } = args as Args;

      if (!process.env.FAL_API_KEY) {
        return { isError: true as const, content: [{ type: "text" as const, text: "FAL_API_KEY environment variable is not set" }] };
      }

      const resolved = await resolveImageRefs(engine, image_refs);
      if (!resolved.ok) return { isError: true as const, content: [{ type: "text" as const, text: resolved.error }] };

      const assetResult = await engine.artifacts.create("img", generationLabel("qwen3", prompt));
      if (!assetResult.ok) return { isError: true as const, content: [{ type: "text" as const, text: `Failed to create image asset: ${assetResult.error.message}` }] };

      const { artifactId: imgAssetId, path: imgAssetDir } = assetResult.value;

      const jobId = `fal-qwen3-edit-${imgAssetId}-${Date.now()}`;
      await queue.enqueue(jobId, {
        type: "generate_qwen3_image_edit_fal",
        imgAssetId,
        imgAssetDir,
        bookId: book_id,
        prompt,
        imageInputs: resolved.inputs,
        sourceImageIds: resolved.sourceImageIds,
        ...(negative_prompt !== undefined ? { negative_prompt } : {}),
        ...(image_size !== undefined ? { image_size } : {}),
        ...(enable_prompt_expansion !== undefined ? { enable_prompt_expansion } : {}),
        ...(seed !== undefined ? { seed } : {}),
        ...(enable_safety_checker !== undefined ? { enable_safety_checker } : {}),
        ...(sync_mode !== undefined ? { sync_mode } : {}),
        ...(num_images !== undefined ? { num_images } : {}),
        ...(output_format !== undefined ? { output_format } : {}),
      } as unknown as Record<string, unknown>);

      return { content: [{ type: "text" as const, text: JSON.stringify({ img_asset_id: imgAssetId, source_images: resolved.sourceImageIds, job_id: jobId, status: "enqueued" }) }] };
    },
  };
}
