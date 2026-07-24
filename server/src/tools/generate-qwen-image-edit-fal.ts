import type { Engine } from "videobook-engine";
import { modelSlug } from "@apicity/cost";
import { z, type ZodRawShape } from "zod";
import { FalQwenImageEditRequestSchema } from "@apicity/fal/zod";
import { Qwen2ImageEditRequestSchema } from "@apicity/kie/zod";
import { queue } from "../queue.js";
import { enumOptions, zodUnionEnumOptions } from "../zod-slots.js";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { resolveImageSlugs, slugify } from "./_fal-shared.js";
import { apicityField, apicityStringArrayField, apicityStringField } from "./schema-from-apicity.js";

const base = FalQwenImageEditRequestSchema.shape;

// fal `image_size` is a ZodUnion of a named-size enum and a custom {width,height}
// object; pull the enum branch's options.
const falImageSizeOptions = zodUnionEnumOptions(base.image_size);
if (!falImageSizeOptions) throw new Error("FalQwenImageEditRequestSchema.image_size changed shape");
type FalImageSize = typeof falImageSizeOptions[number];

// The UI sends the Kie-canonical aspect-ratio strings (matching Qwen2ImageEditRequestSchema
// on Kie). Accept either those or the Fal enum, then normalize to the Fal enum for the job.
const KIE_ASPECT_RATIOS = enumOptions(Qwen2ImageEditRequestSchema.shape.input.shape.image_size);
const ACCEPTED_IMAGE_SIZES = [...falImageSizeOptions, ...KIE_ASPECT_RATIOS] as [string, ...string[]];

const KIE_TO_FAL_IMAGE_SIZE: Record<string, FalImageSize> = {
  "1:1": "square_hd",
  "2:3": "portrait_4_3",
  "3:2": "landscape_4_3",
  "3:4": "portrait_4_3",
  "4:3": "landscape_4_3",
  "9:16": "portrait_16_9",
  "16:9": "landscape_16_9",
  "21:9": "landscape_16_9",
};

function normalizeImageSize(value: string | undefined): FalImageSize | undefined {
  if (!value) return undefined;
  if ((falImageSizeOptions as readonly string[]).includes(value)) return value as FalImageSize;
  return KIE_TO_FAL_IMAGE_SIZE[value as typeof KIE_ASPECT_RATIOS[number]];
}

const schema = {
  project_slug: z.string().describe("Project slug"),
  prompt: apicityStringField(base.prompt, "Edit instruction", { required: true }),
  image_slugs: apicityStringArrayField(base.image_url, "Exactly one @img-* slug for the reference image", { required: true }),
  image_size: z.enum(ACCEPTED_IMAGE_SIZES).optional().describe("Output size — Fal enum (square_hd, landscape_16_9, ...) or aspect-ratio shorthand (1:1, 16:9, 9:16, 4:3, 3:4, ...)"),
  num_inference_steps: apicityField(base.num_inference_steps, "Inference steps (2-50)"),
  guidance_scale: apicityField(base.guidance_scale, "Guidance scale (0-20)"),
  num_images: apicityField(base.num_images, "Number of images (1-4)"),
  output_format: apicityField(base.output_format, "Output image format"),
  negative_prompt: apicityStringField(base.negative_prompt, "Negative prompt"),
  acceleration: apicityField(base.acceleration, "Acceleration level"),
  enable_safety_checker: apicityField(base.enable_safety_checker, "Enable safety checker"),
  seed: apicityField(base.seed, "Seed for deterministic output"),

} satisfies ZodRawShape;

type Args = SchemaArgs<typeof schema>;

export function generateQwenImageEditFalDef(fs: Engine): ToolDef {
  return {
    name: "generate_fal_qwen_2_0_edit_image",
    description: "Edit an image via fal.ai using Alibaba Qwen Image edit with one @img-* reference input. Creates a new img- asset and enqueues a background job.",
    schema,
    handler: async (args) => {
      const { project_slug, prompt, image_slugs, image_size, num_inference_steps, guidance_scale, num_images, output_format, negative_prompt, acceleration, enable_safety_checker, seed } = args as Args;
      const prefix = "img";

      if (!process.env.FAL_API_KEY) {
        return { isError: true as const, content: [{ type: "text" as const, text: "FAL_API_KEY environment variable is not set" }] };
      }

      const [firstSlug] = image_slugs;
      const resolved = await resolveImageSlugs(fs, [firstSlug], project_slug);
      if (!resolved.ok) return { isError: true as const, content: [{ type: "text" as const, text: resolved.error }] };

      const [refImage] = resolved.inputs;
      const normalizedSize = normalizeImageSize(image_size);

      const assetResult = await fs.artifacts.create(prefix, `${modelSlug("kie", "qwen2/image-edit")}-${slugify(prompt) || String(Date.now())}`, project_slug);
      if (!assetResult.ok) return { isError: true as const, content: [{ type: "text" as const, text: `Failed to create image asset: ${assetResult.error.message}` }] };

      const { slug: imgAssetId, path: imgAssetDir } = assetResult.value;

      const jobId = `fal-${modelSlug("kie", "qwen2/image-edit")}-edit-${imgAssetId}-${Date.now()}`;
      await queue.enqueue(jobId, {
        type: "generate_qwen_image_edit_fal",
        imgAssetId,
        imgAssetDir,
        projectSlug: project_slug,
        prompt,
        refImage,
        sourceImageIds: resolved.sourceImageIds,
        ...(normalizedSize !== undefined ? { image_size: normalizedSize } : {}),
        ...(num_inference_steps !== undefined ? { num_inference_steps } : {}),
        ...(guidance_scale !== undefined ? { guidance_scale } : {}),
        ...(num_images !== undefined ? { num_images } : {}),
        ...(output_format !== undefined ? { output_format } : {}),
        ...(negative_prompt !== undefined ? { negative_prompt } : {}),
        ...(acceleration !== undefined ? { acceleration } : {}),
        ...(enable_safety_checker !== undefined ? { enable_safety_checker } : {}),
        ...(seed !== undefined ? { seed } : {}),
      } as unknown as Record<string, unknown>);

      return { content: [{ type: "text" as const, text: JSON.stringify({ img_asset_id: imgAssetId, source_images: resolved.sourceImageIds, job_id: jobId, status: "enqueued" }) }] };
    },
  };
}
