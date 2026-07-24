import type { Engine } from "videobook-engine";
import { modelSlug } from "@apicity/cost";
import { z, type ZodRawShape } from "zod";
import { FalKlingVideoV3ProImageToVideoRequestSchema } from "@apicity/fal/zod";
import { queue } from "../queue.js";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { resolveImageSlugs, slugify } from "./_fal-shared.js";
import { apicityField, apicityStringField } from "./schema-from-apicity.js";

const kling = FalKlingVideoV3ProImageToVideoRequestSchema.shape;

const generateKlingV3ProI2vFalSchema = {
  book_id: z.string().describe("Project slug"),
  prompt: apicityStringField(kling.prompt, "Video description (max 2500 chars)"),
  first_frame_slug: apicityStringField(kling.start_image_url, "First frame image asset (e.g., @img-start)", { required: true }),
  end_frame_slug: apicityStringField(kling.end_image_url, "Optional end frame image asset"),
  duration: apicityStringField(kling.duration, "Video duration in seconds"),
  generate_audio: apicityField(kling.generate_audio, "Generate accompanying audio"),
  negative_prompt: apicityStringField(kling.negative_prompt, "Things to avoid (max 2500 chars)"),
  cfg_scale: apicityField(kling.cfg_scale, "Classifier-free guidance scale (0-1)"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof generateKlingV3ProI2vFalSchema>;

export function generateKlingV3ProI2vFalDef(fs: Engine): ToolDef {
  return {
    name: "generate_fal_kling_video_v3_pro_image_to_video",
    description: "Generate a video via fal.ai using Kling Video v3 Pro image-to-video. Requires a first-frame image; optional end frame for transition control. Creates a new vid- asset and enqueues a background job.",
    schema: generateKlingV3ProI2vFalSchema,
    handler: async (args) => {
      const { book_id, prompt, first_frame_slug, end_frame_slug, duration, generate_audio, negative_prompt, cfg_scale } = args as Args;

      if (!process.env.FAL_API_KEY) {
        return { isError: true as const, content: [{ type: "text" as const, text: "FAL_API_KEY environment variable is not set" }] };
      }

      const slugs = end_frame_slug ? [first_frame_slug, end_frame_slug] : [first_frame_slug];
      const resolved = await resolveImageSlugs(fs, slugs, book_id);
      if (!resolved.ok) return { isError: true as const, content: [{ type: "text" as const, text: resolved.error }] };

      const [firstFrame, endFrame] = resolved.inputs;
      const nameSource = prompt ?? first_frame_slug;
      const assetResult = await fs.artifacts.create("vid", `${modelSlug("kie", "kling-3.0/video/pro")}-${slugify(nameSource) || String(Date.now())}`);
      if (!assetResult.ok) return { isError: true as const, content: [{ type: "text" as const, text: `Failed to create video asset: ${assetResult.error.message}` }] };

      const { slug: vidAssetId, path: vidAssetDir } = assetResult.value;

      const jobId = `fal-${modelSlug("kie", "kling-3.0/video/pro")}-i2v-${vidAssetId}-${Date.now()}`;
      await queue.enqueue(jobId, {
        type: "generate_kling_v3_pro_i2v_fal",
        vidAssetId,
        vidAssetDir,
        bookId: book_id,
        firstFrame,
        ...(endFrame ? { endFrame } : {}),
        sourceImageIds: resolved.sourceImageIds,
        ...(prompt !== undefined ? { prompt } : {}),
        ...(duration !== undefined ? { duration } : {}),
        ...(generate_audio !== undefined ? { generate_audio } : {}),
        ...(negative_prompt !== undefined ? { negative_prompt } : {}),
        ...(cfg_scale !== undefined ? { cfg_scale } : {}),
      } as unknown as Record<string, unknown>);

      return { content: [{ type: "text" as const, text: JSON.stringify({ vid_asset_id: vidAssetId, source_images: resolved.sourceImageIds, job_id: jobId, status: "enqueued" }) }] };
    },
  };
}
