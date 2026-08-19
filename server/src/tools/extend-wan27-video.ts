import type { Engine } from "videobook-engine";
import { modelSlug } from "@apicity/cost";
import { z, type ZodRawShape } from "zod";
import { Wan27ImageToVideoRequestSchema } from "@apicity/kie/zod";
import { queue } from "../queue.js";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { apicityField, apicityStringField, apicityStringNumberField } from "./schema-from-apicity.js";
import { resolveVideoRef } from "./_seedance2-shared.js";
import { generationLabel } from "../artifact-label.js";

const wan27I2v = Wan27ImageToVideoRequestSchema.shape.input.shape;

const extendWan27VideoSchema = {
  book_id: z.string().describe("Book id"),
  video_ref: z.string().describe("Source video artifact id to extend"),
  prompt: apicityStringField(wan27I2v.prompt, "Video description (max 5000 chars)", { required: true }),
  negative_prompt: apicityStringField(wan27I2v.negative_prompt, "Negative prompt — things to avoid (max 500 chars)"),
  resolution: apicityField(wan27I2v.resolution, "Video resolution (default 1080p)"),
  duration: apicityStringNumberField(wan27I2v.duration, "Video duration in seconds (2-15)"),
  prompt_extend: apicityField(wan27I2v.prompt_extend, "Intelligent prompt rewriting (default true)"),
  watermark: apicityField(wan27I2v.watermark, "Add provider watermark to output (default false)"),
  nsfw_checker: apicityField(wan27I2v.nsfw_checker, "Content safety filter (default false)"),
  seed: apicityField(wan27I2v.seed, "Random seed for reproducibility"),
  _provider: z.string().optional().describe("Provider key (e.g., 'kie')"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof extendWan27VideoSchema>;

export function extendWan27VideoDef(engine: Engine): ToolDef {
  return {
    name: "extend_kie_wan_2_7_video",
    description: "Extend an existing video asset using Wan 2.7 Image to Video by providing the source video as first_clip. Creates a new video artifact and enqueues a background job.",
    schema: extendWan27VideoSchema,
    handler: async (args) => {
      const {
        book_id, video_ref, prompt, negative_prompt,
        resolution, duration, prompt_extend, watermark, nsfw_checker, seed,
      } = args as Args;

      if (!process.env.KIE_API_KEY) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "KIE_API_KEY environment variable is not set" }],
        };
      }

      if (!video_ref) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "video_ref is required" }],
        };
      }

      const videoResult = await resolveVideoRef(engine, video_ref);
      if (!videoResult.ok) return { isError: true as const, content: [{ type: "text" as const, text: videoResult.error }] };
      const sourceVideo = videoResult.value;

      const videoName = generationLabel(modelSlug("kie", "wan/2-7-image-to-video"), prompt);
      const assetResult = await engine.artifacts.create("vid", videoName);
      if (!assetResult.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Failed to create video asset: ${assetResult.error.message}` }],
        };
      }

      const { artifactId: vidAssetId, path: vidAssetDir } = assetResult.value;
      const sourceVideoIds = [sourceVideo.assetId];
      const sourceImageIds: string[] = [];
      const sourceAudioIds: string[] = [];

      const jobId = `${modelSlug("kie", "wan/2-7-image-to-video")}-extend-${vidAssetId}-${Date.now()}`;

      await queue.enqueue(jobId, {
        type: "extend_wan27_video",
        vidAssetId,
        vidAssetDir,
        bookId: book_id,
        prompt,
        sourceVideo,
        sourceVideoIds,
        sourceImageIds,
        sourceAudioIds,
        ...(negative_prompt !== undefined ? { negative_prompt } : {}),
        ...(resolution !== undefined ? { resolution } : {}),
        ...(duration !== undefined ? { duration } : {}),
        ...(prompt_extend !== undefined ? { prompt_extend } : {}),
        ...(watermark !== undefined ? { watermark } : {}),
        ...(nsfw_checker !== undefined ? { nsfw_checker } : {}),
        ...(seed !== undefined ? { seed } : {}),
      } as unknown as Record<string, unknown>);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            vid_asset_id: vidAssetId,
            source_videos: sourceVideoIds,
            job_id: jobId,
            status: "enqueued",
          }),
        }],
      };
    },
  };
}
