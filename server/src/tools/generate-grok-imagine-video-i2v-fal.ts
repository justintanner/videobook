import type { VideocityFs } from "videocity-engine";
import { modelSlug } from "@apicity/cost";
import { z, type ZodRawShape } from "zod";
import { FalXaiGrokImagineVideoImageToVideoRequestSchema } from "@apicity/fal/zod";
import { queue } from "../queue.js";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { resolveImageSlugs, slugify } from "./_fal-shared.js";

const base = FalXaiGrokImagineVideoImageToVideoRequestSchema.shape;
const aspectRatioOptions = base.aspect_ratio.unwrap().options as readonly [string, ...string[]];
const resolutionOptions = base.resolution.unwrap().options as readonly [string, ...string[]];

const generateGrokImagineVideoI2vFalSchema = {
  project_slug: z.string().describe("Project slug"),
  prompt: z.string().describe("Video description (max 4096 chars)"),
  first_frame_slug: z.string().describe("First frame image asset (e.g., @img-start)"),
  duration: z.number().int().min(1).max(15).optional().describe("Video duration in seconds (1-15)"),
  aspect_ratio: z.enum(aspectRatioOptions).optional().describe("Output aspect ratio"),
  resolution: z.enum(resolutionOptions).optional().describe("Output resolution (480p / 720p)"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof generateGrokImagineVideoI2vFalSchema>;

export function generateGrokImagineVideoI2vFalDef(fs: VideocityFs): ToolDef {
  return {
    name: "generate_grok_imagine_video_i2v_fal",
    description: "Generate a video via fal.ai using xAI Grok Imagine Video image-to-video. Requires a first-frame image. Creates a new vid- asset and enqueues a background job.",
    schema: generateGrokImagineVideoI2vFalSchema,
    handler: async (args) => {
      const { project_slug, prompt, first_frame_slug, duration, aspect_ratio, resolution } = args as Args;

      if (!process.env.FAL_API_KEY) {
        return { isError: true as const, content: [{ type: "text" as const, text: "FAL_API_KEY environment variable is not set" }] };
      }

      const resolved = await resolveImageSlugs(fs, [first_frame_slug], project_slug);
      if (!resolved.ok) return { isError: true as const, content: [{ type: "text" as const, text: resolved.error }] };

      const [firstFrame] = resolved.inputs;
      const assetResult = await fs.createAsset("vid", `${modelSlug("kie", "grok-imagine/image-to-video")}-${slugify(prompt) || String(Date.now())}`, project_slug);
      if (!assetResult.ok) return { isError: true as const, content: [{ type: "text" as const, text: `Failed to create video asset: ${assetResult.error.message}` }] };

      const { assetId: vidAssetId, path: vidAssetDir } = assetResult.value;

      const jobId = `fal-${modelSlug("kie", "grok-imagine/image-to-video")}-i2v-${vidAssetId}-${Date.now()}`;
      await queue.enqueue(jobId, {
        type: "generate_grok_imagine_video_i2v_fal",
        vidAssetId,
        vidAssetDir,
        projectSlug: project_slug,
        prompt,
        firstFrame,
        sourceImageIds: resolved.sourceImageIds,
        ...(duration !== undefined ? { duration } : {}),
        ...(aspect_ratio !== undefined ? { aspect_ratio } : {}),
        ...(resolution !== undefined ? { resolution } : {}),
      } as unknown as Record<string, unknown>);

      return { content: [{ type: "text" as const, text: JSON.stringify({ vid_asset_id: vidAssetId, source_images: resolved.sourceImageIds, job_id: jobId, status: "enqueued" }) }] };
    },
  };
}
