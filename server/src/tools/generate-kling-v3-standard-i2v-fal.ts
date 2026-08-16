import type { Engine } from "videobook-engine";
import { modelSlug } from "@apicity/cost";
import { z, type ZodRawShape } from "zod";
import { FalKlingVideoV3StandardImageToVideoRequestSchema } from "@apicity/fal/zod";
import { queue } from "../queue.js";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { resolveImageRefs } from "./_fal-shared.js";
import { apicityField, apicityStringField } from "./schema-from-apicity.js";
import { generationLabel } from "../artifact-label.js";

const base = FalKlingVideoV3StandardImageToVideoRequestSchema.shape;

const schema = {
  book_id: z.string().describe("Book id"),
  prompt: apicityStringField(base.prompt, "Video description (max 2500 chars)"),
  first_frame_ref: apicityStringField(base.start_image_url, "First frame image artifact id", { required: true }),
  end_frame_ref: apicityStringField(base.end_image_url, "Optional end frame image asset"),
  duration: apicityStringField(base.duration, "Video duration as string (model-specific)"),
  generate_audio: apicityField(base.generate_audio, "Generate accompanying audio"),
  shot_type: apicityField(base.shot_type, "Shot type"),
  negative_prompt: apicityStringField(base.negative_prompt, "Things to avoid"),
  cfg_scale: apicityField(base.cfg_scale, "CFG scale (0-2)"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof schema>;

export function generateKlingV3StandardI2vFalDef(fs: Engine): ToolDef {
  return {
    name: "generate_fal_kling_video_v3_standard_image_to_video",
    description: "Generate a video via fal.ai using Kling Video v3 Standard from a first-frame image (optional end frame). Creates a new video artifact and enqueues a background job.",
    schema,
    handler: async (args) => {
      const { book_id, prompt, first_frame_ref, end_frame_ref, duration, generate_audio, shot_type, negative_prompt, cfg_scale } = args as Args;

      if (!process.env.FAL_API_KEY) {
        return { isError: true as const, content: [{ type: "text" as const, text: "FAL_API_KEY environment variable is not set" }] };
      }

      const slugs = end_frame_ref ? [first_frame_ref, end_frame_ref] : [first_frame_ref];
      const resolved = await resolveImageRefs(fs, slugs);
      if (!resolved.ok) return { isError: true as const, content: [{ type: "text" as const, text: resolved.error }] };

      const [firstFrame, endFrame] = resolved.inputs;
      const assetResult = await fs.artifacts.create("vid", generationLabel(modelSlug("kie", "kling-3.0/video/std"), prompt));
      if (!assetResult.ok) return { isError: true as const, content: [{ type: "text" as const, text: `Failed to create video asset: ${assetResult.error.message}` }] };

      const { artifactId: vidAssetId, path: vidAssetDir } = assetResult.value;

      const jobId = `fal-${modelSlug("kie", "kling-3.0/video/std")}-i2v-${vidAssetId}-${Date.now()}`;
      await queue.enqueue(jobId, {
        type: "generate_kling_v3_standard_i2v_fal",
        vidAssetId,
        vidAssetDir,
        bookId: book_id,
        firstFrame,
        ...(endFrame ? { endFrame } : {}),
        sourceImageIds: resolved.sourceImageIds,
        ...(prompt !== undefined ? { prompt } : {}),
        ...(duration !== undefined ? { duration } : {}),
        ...(generate_audio !== undefined ? { generate_audio } : {}),
        ...(shot_type !== undefined ? { shot_type } : {}),
        ...(negative_prompt !== undefined ? { negative_prompt } : {}),
        ...(cfg_scale !== undefined ? { cfg_scale } : {}),
      } as unknown as Record<string, unknown>);

      return { content: [{ type: "text" as const, text: JSON.stringify({ vid_asset_id: vidAssetId, source_images: resolved.sourceImageIds, job_id: jobId, status: "enqueued" }) }] };
    },
  };
}
